// 即時預覽：一步操作只會改到選取外框附近，所以把那一小塊裁下來、在主執行緒用同一組純函式算一次，
// 幾十毫秒就能畫出結果；Worker 的正式結果（含 relabel）之後再覆蓋。裁下來的範圍內逐體素和正式結果相同（有測試）。
import {
  AIR,
  type BBox,
  type Labeled,
  type Vec3,
  type Volume,
  LINER_MAX,
  dilateMask,
  growMask,
  pushSeq,
  setRegionMaterial,
  levelMask,
  localMask,
  setMaskMaterial,
  translateMask,
  unionBBox,
} from './volume';
import { type EditState, type LegacyOp, type Op, bboxOfKeys, cdSteps, radiusOf, taperSteps, upgradeOp } from './ops';
import { type Scope, axisIndex, planeAxes } from './scope';
import { type ProfileOp, type RingsFor, applyProfileMask, decodeRle, dirVec, rleBox } from './profile';
import type { Report } from './kernel';

export interface Preview {
  /** 裁切範圍（含端點，整個陣列的座標）。 */
  box: BBox;
  /** 範圍內的結果，shape = 外框大小。 */
  data: Uint8Array;
}

/** 推面／補平沿法線方向多留的格數：|n| 之外再加幾層襯層的厚度（collectLiners 一次最多收幾層薄層）。 */
const LINER_MARGIN = LINER_MAX * 4 + 1;

export const boxVoxels = (b: BBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);

const clampBox = (b: BBox, v: Volume): BBox | null => {
  const out = {
    x0: Math.max(0, b.x0),
    y0: Math.max(0, b.y0),
    z0: Math.max(0, b.z0),
    x1: Math.min(v.X - 1, b.x1),
    y1: Math.min(v.Y - 1, b.y1),
    z1: Math.min(v.Z - 1, b.z1),
  };
  return out.x0 <= out.x1 && out.y0 <= out.y1 && out.z0 <= out.z1 ? out : null;
};

const lo = (b: BBox): Vec3 => [b.x0, b.y0, b.z0];
const hi = (b: BBox): Vec3 => [b.x1, b.y1, b.z1];
const fromLoHi = (l: Vec3, h: Vec3): BBox => ({ x0: l[0], y0: l[1], z0: l[2], x1: h[0], y1: h[1], z1: h[2] });

/** 裁一塊出來（複製）。 */
export function cropVolume(v: Volume, b: BBox): Volume {
  const X = b.x1 - b.x0 + 1;
  const Y = b.y1 - b.y0 + 1;
  const Z = b.z1 - b.z0 + 1;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const src = ((z + b.z0) * v.Y + y + b.y0) * v.X + b.x0;
      data.set(v.data.subarray(src, src + X), (z * Y + y) * X);
    }
  return { X, Y, Z, data };
}

/** 選取結構在裁切範圍內的 mask（不必先做整個陣列的 mask）。 */
export function cropMask(L: Labeled, keys: Set<string>, v: Volume, b: BBox): Uint8Array {
  const on = new Uint8Array(L.comps.length);
  L.comps.forEach((c, i) => {
    if (keys.has(c.key)) on[i] = 1;
  });
  const X = b.x1 - b.x0 + 1;
  const Y = b.y1 - b.y0 + 1;
  const Z = b.z1 - b.z0 + 1;
  const out = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const src = ((z + b.z0) * v.Y + y + b.y0) * v.X + b.x0;
      const dst = (z * Y + y) * X;
      for (let x = 0; x < X; x++) {
        const l = L.labels[src + x];
        if (l >= 0 && on[l]) out[dst + x] = 1;
      }
    }
  return out;
}

/**
 * 從 start 沿 step 讀襯層要讀到多遠（和 kernel 的 collectLiners 讀的格子一樣或更多）：回傳要包進外框的格數（含 start）。
 * 不看 stopMat（讀得比較遠，只會更保守）；厚的那一層只要讀到 LINER_MAX＋1 格就知道它是厚的。
 */
export function linerReach(vol: Volume, start: Vec3, step: Vec3): number {
  const { X, Y, Z, data } = vol;
  const inV = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < X && y < Y && z < Z;
  let k = 0;
  for (let guard = 0; guard < 4 * LINER_MAX * 8; guard++) {
    const x = start[0] + k * step[0];
    const y = start[1] + k * step[1];
    const z = start[2] + k * step[2];
    if (!inV(x, y, z)) return k;
    const m = data[(z * Y + y) * X + x];
    if (m === AIR) return k + 1;
    let run = 0;
    for (;;) {
      const rx = x + run * step[0];
      const ry = y + run * step[1];
      const rz = z + run * step[2];
      if (!inV(rx, ry, rz) || data[(rz * Y + ry) * X + rx] !== m || run > LINER_MAX) break;
      run++;
    }
    if (run > LINER_MAX) return k + run;
    k += run;
  }
  return k;
}

/**
 * profile 的緊外框（plan v8 §7.7）：切面上＝要加／拿的格子（相對式手勢再加上結構這一段的外框，
 * 每片才描得到同一個輪廓），四周留「這一段實際存在的襯層」要讀到的格數＋1；沿法線＝scope ∩ 結構外框。
 * 不再整個結構外框加 LINER_MARGIN（×1 範例拖 fin 節點從 45 萬格降到 10 萬以下）。
 */
function profileBox(s: EditState, op: ProfileOp, b: BBox): BBox | null {
  const a = axisIndex(op.scope.axis);
  const [ua, va] = planeAxes(op.scope.axis);
  const l = lo(b);
  const h = hi(b);
  const t0 = Math.max(l[a], op.scope.lo);
  const t1 = Math.min(h[a], op.scope.hi);
  if (t0 > t1) return null;
  const cells: { u: number; v: number; dir: number; add: boolean }[] = [];
  for (const pk of Object.values(op.perKey)) {
    for (const c of decodeRle(pk.add)) cells.push({ ...c, add: true });
    for (const c of decodeRle(pk.remove)) cells.push({ ...c, add: false });
  }
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  const grow = (u: number, v: number) => {
    u0 = Math.min(u0, u);
    v0 = Math.min(v0, v);
    u1 = Math.max(u1, u);
    v1 = Math.max(v1, v);
  };
  for (const pk of Object.values(op.perKey))
    for (const r of [pk.add, pk.remove]) {
      const rb = rleBox(r);
      if (rb) {
        grow(rb.u0, rb.v0);
        grow(rb.u1, rb.v1);
      }
    }
  const relative = (op.gestures && Object.keys(op.gestures).length) || (op.rounds && Object.keys(op.rounds).length);
  if (relative) {
    // 相對式：每一片要描整個剖面才找得到同一個把手；結構在別的片偏了多少，要加的格子也跟著偏
    const ref = sliceBoxOf(s, op.keys, op.scope.axis, op.at);
    const over = ref && u0 <= u1 ? [Math.max(0, ref.u0 - u0), Math.max(0, ref.v0 - v0), Math.max(0, u1 - ref.u1), Math.max(0, v1 - ref.v1)] : [0, 0, 0, 0];
    grow(l[ua] - over[0], l[va] - over[1]);
    grow(h[ua] + over[2], h[va] + over[3]);
    // 圓頭（plan v10 §4.6）：每一片用自己的外框重算；內圓角會補到外框外 max(ru, rv) 格，
    // 結構沿法線偏移時別的片的格子和襯層也跟著偏，所以整段外框再往外留 max(ru, rv)＋襯層
    // 只往有勾角的那幾側留（上面兩個角不必往下留）：[左, 上, 右, 下]
    const ext = [0, 0, 0, 0];
    for (const g of Object.values(op.rounds ?? {}))
      for (const c of g.corners) {
        const r = c.concave ? Math.ceil(Math.max(g.ru ?? g.r, g.rv ?? g.r)) : 0;
        const e = r + 1 + (op.follow ? LINER_MARGIN : 0);
        const k = c.id[1] === 'l' ? 0 : 2;
        const j = c.id[0] === 'u' ? 1 : 3;
        ext[k] = Math.max(ext[k], e);
        ext[j] = Math.max(ext[j], e);
      }
    grow(l[ua] - ext[0], l[va] - ext[1]);
    grow(h[ua] + ext[2], h[va] + ext[3]);
  }
  if (u0 > u1) return null;
  // 襯層：每一格沿它的方向，這一段每一片實際要讀到多遠（同一條線上前面先加的格子會把襯層再往前推）
  // 數字 key（plan v9 P19）：切面座標 < 65536
  const cellKey = (u: number, v: number) => (v + 1) * 65538 + u + 1;
  const addAt = new Set(cells.filter((c) => c.add).map((c) => cellKey(c.u, c.v)));
  let pad = [1, 1, 1, 1];
  if (op.follow)
    for (const c of cells) {
      const [du, dv] = [c.dir === 0 ? 1 : c.dir === 1 ? -1 : 0, c.dir === 2 ? 1 : c.dir === 3 ? -1 : 0];
      let behind = 0;
      if (c.add) while (addAt.has(cellKey(c.u - (behind + 1) * du, c.v - (behind + 1) * dv))) behind++;
      const d3 = dirVec(op.scope.axis, c.dir);
      let reach = 0;
      for (let t = t0; t <= t1; t++) {
        const p = [0, 0, 0] as Vec3;
        p[ua] = c.u + (c.add ? 0 : du);
        p[va] = c.v + (c.add ? 0 : dv);
        p[a] = t;
        reach = Math.max(reach, linerReach(s.vol, p, d3));
        if (reach >= LINER_MARGIN) break;
      }
      const need = Math.min(LINER_MARGIN, reach + behind + (c.add ? 0 : 1)) + 1;
      // 這一格往 dir 那一側要多留幾格（超過外框才算）
      if (du > 0) pad[2] = Math.max(pad[2], c.u + need - u1);
      if (du < 0) pad[0] = Math.max(pad[0], u0 - (c.u - need));
      if (dv > 0) pad[3] = Math.max(pad[3], c.v + need - v1);
      if (dv < 0) pad[1] = Math.max(pad[1], v0 - (c.v - need));
    }
  pad = pad.map((x) => Math.max(1, x));
  l[ua] = u0 - pad[0];
  l[va] = v0 - pad[1];
  h[ua] = u1 + pad[2];
  h[va] = v1 + pad[3];
  l[a] = t0;
  h[a] = t1;
  const out = clampBox(fromLoHi(l, h), s.vol);
  // 每片輪廓快取（plan v9 §4.5）的前提：有手勢時切面上包住結構整個外框（描出來的環才和這一幀的範圍無關）
  if (out && relative) {
    const ob = lo(out);
    const oh = hi(out);
    const bl = lo(b);
    const bh = hi(b);
    if (ob[ua] > bl[ua] || ob[va] > bl[va] || oh[ua] < bh[ua] || oh[va] < bh[va]) throw new Error('profileBox 沒有包住結構外框');
  }
  return out;
}

/** 已選結構在第 at 片的外框（切面座標，含端點）；那一片沒有回傳 null。 */
function sliceBoxOf(s: EditState, keys: string[], axis: ProfileOp['scope']['axis'], at: number) {
  const a = axisIndex(axis);
  const [ua, va] = planeAxes(axis);
  const { X, Y } = s.vol;
  const ks = new Set(keys);
  const idx = new Set<number>();
  s.L.comps.forEach((c, i) => ks.has(c.key) && idx.add(i));
  const b = unionBBox(s.L.comps.filter((c) => ks.has(c.key)));
  if (!b) return null;
  const l = lo(b);
  const h = hi(b);
  if (at < l[a] || at > h[a]) return null;
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  const p = [0, 0, 0];
  p[a] = at;
  for (let v = l[va]; v <= h[va]; v++)
    for (let u = l[ua]; u <= h[ua]; u++) {
      p[ua] = u;
      p[va] = v;
      if (!idx.has(s.L.labels[(p[2] * Y + p[1]) * X + p[0]])) continue;
      u0 = Math.min(u0, u);
      v0 = Math.min(v0, v);
      u1 = Math.max(u1, u);
      v1 = Math.max(v1, v);
    }
  return u0 <= u1 ? { u0, v0, u1, v1 } : null;
}

/**
 * 這一步會動到的範圍：選取外框，推面／補平沿法線兩側多留 |n|＋襯層，筆刷只留筆刷蓋到的列，
 * 平移是外框 ∪ 搬到的地方。超出陣列的部分切掉；選取不存在回傳 null。
 */
export function previewBox(s: EditState, input: Op | LegacyOp): BBox | null {
  const op = upgradeOp(input);
  const keys = new Set(op.keys);
  const b = unionBBox(s.L.comps.filter((c) => keys.has(c.key)));
  if (!b) return null;
  const l = lo(b);
  const h = hi(b);
  // scope 比結構短：沿 scope 的軸只算 scope 那一段（推面／補平的方向和 scope 同軸時不行：
  // 最外側的面要看整根，裁掉會把裁切邊當成表面）
  const sa = axisIndex(op.scope.axis);
  if (op.kind === 'dilate') {
    // 保形層：每一面都可能長／退 |n|，襯層再往外推（plan v11 §4.6）；來源可以在 scope 外，不裁 scope
    const r = Math.abs(op.n) + LINER_MARGIN;
    for (let k = 0; k < 3; k++) {
      l[k] -= r;
      h[k] += r;
    }
    return clampBox(fromLoHi(l, h), s.vol);
  }
  if (op.kind === 'defect') {
    const a = op.abs;
    return clampBox({ x0: Math.max(b.x0, a.x0), x1: Math.min(b.x1, a.x1), y0: Math.max(b.y0, a.y0), y1: Math.min(b.y1, a.y1), z0: Math.max(b.z0, a.z0), z1: Math.min(b.z1, a.z1) }, s.vol);
  }
  if (op.kind === 'cd' || op.kind === 'taper') {
    // 展開成推面：推的那一軸兩側多留 |n|＋襯層；scope 和推的軸不同才裁
    const a = op.kind === 'cd' ? op.axis : op.face[0] ? 0 : op.face[1] ? 1 : 2;
    const n = op.kind === 'cd' ? Math.abs(op.delta) : Math.max(Math.abs(op.top), Math.abs(op.bottom));
    if (a !== sa) {
      l[sa] = Math.max(l[sa], op.scope.lo);
      h[sa] = Math.min(h[sa], op.scope.hi);
      if (l[sa] > h[sa]) return null;
    }
    l[a] -= n + LINER_MARGIN;
    h[a] += n + LINER_MARGIN;
    return clampBox(fromLoHi(l, h), s.vol);
  }
  const along = (op.kind === 'push' || op.kind === 'level') && (op.dir[0] ? 0 : op.dir[1] ? 1 : 2) === sa;
  if (op.kind !== 'translate' && !along) {
    l[sa] = Math.max(l[sa], op.scope.lo);
    h[sa] = Math.min(h[sa], op.scope.hi);
    if (l[sa] > h[sa]) return null;
  }
  if (op.kind === 'push' || op.kind === 'level') {
    const a = op.dir[0] ? 0 : op.dir[1] ? 1 : 2;
    const local = op.local;
    if (local && local.radius !== null) {
      const r = radiusOf(local);
      for (let k = 0; k < 3; k++) {
        if (k === a) continue;
        l[k] = Math.max(l[k], local.center[k] - r);
        h[k] = Math.min(h[k], local.center[k] + r);
      }
      if (l[0] > h[0] || l[1] > h[1] || l[2] > h[2]) return null;
    }
    const reach = (op.kind === 'push' ? Math.abs(op.n) : Math.abs(op.to - l[a]) + Math.abs(op.to - h[a])) + LINER_MARGIN;
    l[a] -= reach;
    h[a] += reach;
    return clampBox(fromLoHi(l, h), s.vol);
  }
  if (op.kind === 'profile') return profileBox(s, op, b);
  if (op.kind === 'translate') {
    // 帶殼：殼最多在結構外 LINER_MARGIN 格
    if (op.follow)
      for (let k = 0; k < 3; k++) {
        l[k] -= LINER_MARGIN;
        h[k] += LINER_MARGIN;
      }
    for (let k = 0; k < 3; k++) {
      l[k] = Math.min(l[k], l[k] + op.d[k]);
      h[k] = Math.max(h[k], h[k] + op.d[k]);
    }
    return clampBox(fromLoHi(l, h), s.vol);
  }
  return clampBox(b, s.vol);
}

/**
 * 在裁切範圍內算這一步的結果；範圍超過 cap 個體素就回傳 null（留給 Worker）。
 * 範圍內逐體素和 applyOp 的結果相同；範圍外這一步本來就不會改到。
 */
export function previewOp(s: EditState, orig: Volume, input: Op | LegacyOp, cap = Infinity, report?: Report, ringsFor?: RingsFor): Preview | null {
  const op = upgradeOp(input);
  const box = previewBox(s, op);
  if (!box || boxVoxels(box) > cap) return null;
  const vol = cropVolume(s.vol, box);
  const o = cropVolume(orig, box);
  if (op.kind === 'profile') {
    // profile 只用每個 key 自己的 mask（不必另外做一份聯集）
    const masks = new Map(op.keys.map((k) => [k, cropMask(s.L, new Set([k]), s.vol, box)] as const));
    return { box, data: applyProfileMask(vol, o, masks, op, [box.x0, box.y0, box.z0], report, ringsFor).data };
  }
  const mask = cropMask(s.L, new Set(op.keys), s.vol, box);
  // scope 換成裁切範圍裡的座標（超出的部分本來就不會被改）
  const off = [box.x0, box.y0, box.z0][axisIndex(op.scope.axis)];
  const zr = { axis: op.scope.axis, lo: op.scope.lo - off, hi: op.scope.hi - off };
  const shift = (p: Vec3): Vec3 => [p[0] - box.x0, p[1] - box.y0, p[2] - box.z0];
  let out: Volume;
  if (op.kind === 'push') {
    const m = op.local ? localMask(vol, mask, op.dir, shift(op.local.center), radiusOf(op.local), op.local.shape ?? 'round') : mask;
    out = growMask(vol, o, m, zr, op.dir, op.n, op.backfill, op.follow, report, op.policy ?? 'overwrite');
  } else if (op.kind === 'cd' || op.kind === 'taper') {
    const steps = op.kind === 'cd' ? cdSteps(op) : taperSteps(op, bboxOfKeys(s.L, op.keys)!);
    const local = (sc: Scope): Scope => {
      const d = [box.x0, box.y0, box.z0][axisIndex(sc.axis)];
      return { axis: sc.axis, lo: sc.lo - d, hi: sc.hi - d };
    };
    out = pushSeq(vol, o, mask, steps.map((st) => ({ ...st, scope: local(st.scope), ...(st.clip ? { clip: local(st.clip) } : {}) })), op.backfill, op.follow, op.policy ?? 'overwrite', report);
  } else if (op.kind === 'dilate') {
    out = dilateMask(vol, o, mask, zr, op.n, op.backfill, op.follow, report);
  } else if (op.kind === 'defect') {
    const a = op.abs;
    out = setRegionMaterial(vol, mask, zr, op.shape, { x0: a.x0 - box.x0, x1: a.x1 - box.x0, y0: a.y0 - box.y0, y1: a.y1 - box.y0, z0: a.z0 - box.z0, z1: a.z1 - box.z0 }, op.mat);
  } else if (op.kind === 'level') {
    const a = op.dir[0] ? 0 : op.dir[1] ? 1 : 2;
    const to = op.to - [box.x0, box.y0, box.z0][a];
    out = levelMask(vol, o, mask, zr, op.dir, shift(op.local.center), radiusOf(op.local), op.local.shape ?? 'round', to, op.backfill, !!op.follow, report);
  } else if (op.kind === 'translate') out = translateMask(vol, o, mask, zr, op.d, op.backfill, !!op.follow);
  else if (op.kind === 'material') out = setMaskMaterial(vol, mask, zr, op.m);
  else out = vol;
  return { box, data: out.data };
}
