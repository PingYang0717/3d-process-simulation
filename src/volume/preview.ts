// 即時預覽：一步操作只會改到選取外框附近，所以把那一小塊裁下來、在主執行緒用同一組純函式算一次，
// 幾十毫秒就能畫出結果；Worker 的正式結果（含 relabel）之後再覆蓋。裁下來的範圍內逐體素和正式結果相同（有測試）。
import { type BBox, type Labeled, type Vec3, type Volume, LINER_MAX, adjacentMasks, growMask, setMaskMaterial, translateMask, unionBBox } from './volume';
import { type AdjPushOp, type AdjTranslateOp, type EditState, type Op, adjacentDir, isAdjacent } from './ops';
import { axisIndex } from './scope';
import { isEmpty, linerLUT, shellFlood, simGrowRow } from './kernel';
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
 * 這一步會動到的範圍：選取外框，推面／補平沿法線兩側多留 |n|＋襯層，筆刷只留筆刷蓋到的列，
 * 平移是外框 ∪ 搬到的地方。超出陣列的部分切掉；選取不存在回傳 null。
 */
export function previewBox(s: EditState, op: Op): BBox | null {
  const keys = new Set(op.keys);
  const b = unionBBox(s.L.comps.filter((c) => keys.has(c.key)));
  if (!b) return null;
  if (isAdjacent(op)) return adjacentBox(s, op, b);
  const l = lo(b);
  const h = hi(b);
  // scope 比結構短：沿 scope 的軸只算 scope 那一段（推面的方向和 scope 同軸時不行：最外側的面要看整根）
  const sa = axisIndex(op.scope.axis);
  const along = op.kind === 'push' && (op.dir[0] ? 0 : op.dir[1] ? 1 : 2) === sa;
  if (op.kind !== 'translate' && !along) {
    l[sa] = Math.max(l[sa], op.scope.lo);
    h[sa] = Math.min(h[sa], op.scope.hi);
    if (l[sa] > h[sa]) return null;
  }
  if (op.kind === 'push') {
    const a = op.dir[0] ? 0 : op.dir[1] ? 1 : 2;
    const reach = Math.abs(op.n) + LINER_MARGIN;
    l[a] -= reach;
    h[a] += reach;
    return clampBox(fromLoHi(l, h), s.vol);
  }
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

/** 'adjacent' 讀窗：沿推的方向最多模擬這麼多格（|n| 之外）；超過就把外框一路開到模型邊界。 */
export const ADJ_WINDOW = 64;

/**
 * 'adjacent'（plan v17 §5.4.4）的裁切範圍：裁切邊界必須不會被誤當成模型邊界，所以讀到哪裡都要包進來。
 * 推拉：沿法線對每一排做一維模擬（simGrowRow），外推多留「模擬讀到最遠的格數＋2」、內縮多留「薄層串長＋2」；
 * 讀出窗外就開到模型邊界。其他兩軸＝選取外框（只有那些排會變）。
 * 平移：結構＋整圈薄層（shellFlood）的外框，往前多留 |n|＋2、其他方向 2；薄層碰到試算範圍的邊就放大重試。
 */
function adjacentBox(s: EditState, op: AdjPushOp | AdjTranslateOp, b: BBox): BBox | null {
  const { dir, n } = adjacentDir(op);
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const sg = dir[a] > 0 ? 1 : -1;
  const l = lo(b);
  const h = hi(b);
  const dims = [s.vol.X, s.vol.Y, s.vol.Z];
  const liner = linerLUT(op.liners);
  if (op.kind === 'translate') {
    for (let m = 8; ; m *= 2) {
      const ml = l.map((v, k) => v - m - (k === a && sg < 0 ? n : 0)) as Vec3;
      const mh = h.map((v, k) => v + m + (k === a && sg > 0 ? n : 0)) as Vec3;
      const box = clampBox(fromLoHi(ml, mh), s.vol)!;
      const vol = cropVolume(s.vol, box);
      const S = new Uint8Array(vol.data.length);
      const ks = [...new Set(op.keys)];
      let touch = false;
      const sl: Vec3 = [Infinity, Infinity, Infinity];
      const sh: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const k of ks) {
        const km = cropMask(s.L, new Set([k]), s.vol, box);
        const first = km.indexOf(1);
        if (first < 0) continue;
        if (op.follow) shellFlood(vol, km, vol.data[first], liner);
        for (let i = 0; i < km.length; i++) if (km[i]) S[i] = 1;
      }
      const bl = lo(box);
      const bh = hi(box);
      for (let i = 0; i < S.length; i++) {
        if (!S[i]) continue;
        const x = i % vol.X;
        const y = ((i - x) / vol.X) % vol.Y;
        const z = (i - x - y * vol.X) / (vol.X * vol.Y);
        const c = [x + bl[0], y + bl[1], z + bl[2]];
        for (let k = 0; k < 3; k++) {
          if (c[k] < sl[k]) sl[k] = c[k];
          if (c[k] > sh[k]) sh[k] = c[k];
          if ((c[k] === bl[k] && bl[k] > 0) || (c[k] === bh[k] && bh[k] < dims[k] - 1)) touch = true;
        }
      }
      if (sl[0] === Infinity) return null;
      if (touch && m < 4 * ADJ_WINDOW) continue;
      if (touch) return clampBox({ x0: 0, y0: 0, z0: 0, x1: dims[0] - 1, y1: dims[1] - 1, z1: dims[2] - 1 }, s.vol);
      const ol = sl.map((v, k) => v - 2 - (k === a && sg < 0 ? n : 0)) as Vec3;
      const oh = sh.map((v, k) => v + 2 + (k === a && sg > 0 ? n : 0)) as Vec3;
      return clampBox(fromLoHi(ol, oh), s.vol);
    }
  }
  // 推拉：每個結構、每一排從最外側那一格往外模擬
  const { X, Y } = s.vol;
  const st = a === 0 ? 1 : a === 1 ? X : X * Y;
  const len = dims[a];
  const [u, v] = [0, 1, 2].filter((k) => k !== a);
  const p: Vec3 = [0, 0, 0];
  let reach = 0;
  /** 外推只讀最外側那一格往外：裁切範圍沿法線從「最裡面的那個最外側格」開始就夠（不必包整個結構）。 */
  let inner = sg > 0 ? Infinity : -Infinity;
  const win = Math.abs(n) + ADJ_WINDOW;
  const row: number[] = [];
  outer: for (const key of new Set(op.keys)) {
    const ci = s.L.comps.findIndex((c) => c.key === key);
    if (ci < 0) continue;
    const cb = s.L.comps[ci].bbox;
    const cl = lo(cb);
    const ch = hi(cb);
    const mat = s.L.comps[ci].mat;
    for (p[u] = cl[u]; p[u] <= ch[u]; p[u]++)
      for (p[v] = cl[v]; p[v] <= ch[v]; p[v]++) {
        // 最外側那一格
        let c = -1;
        for (let t = sg > 0 ? ch[a] : cl[a]; sg > 0 ? t >= cl[a] : t <= ch[a]; t -= sg) {
          p[a] = t;
          if (s.L.labels[(p[2] * Y + p[1]) * X + p[0]] === ci) {
            c = t;
            break;
          }
        }
        if (c < 0) continue;
        inner = sg > 0 ? Math.min(inner, c) : Math.max(inner, c);
        p[a] = c;
        const base = (p[2] * Y + p[1]) * X + p[0];
        if (n > 0) {
          row.length = 0;
          for (let k = 1; k <= win; k++) {
            const t = c + k * sg;
            if (t < 0 || t >= len) {
              row.push(-1);
              break;
            }
            row.push(s.vol.data[base + k * sg * st]);
          }
          const r = simGrowRow(row, n, mat, op.follow, liner);
          if (r.reach >= row.length && row[row.length - 1] !== -1) {
            reach = Infinity;
            break outer;
          }
          reach = Math.max(reach, r.reach + 1);
        } else {
          let k = 1;
          if (op.follow)
            for (; k <= win; k++) {
              const t = c + k * sg;
              if (t < 0 || t >= len) break;
              const m = s.vol.data[base + k * sg * st];
              if (isEmpty(m) || m === mat || !liner[m]) break;
            }
          if (k > win) {
            reach = Infinity;
            break outer;
          }
          reach = Math.max(reach, k);
        }
      }
  }
  if (sg > 0) h[a] = reach === Infinity ? len - 1 : h[a] + reach + 2;
  else l[a] = reach === Infinity ? 0 : l[a] - reach - 2;
  // 外推：結構在面後面的部分不會被讀（內縮要看整個結構沿這一軸的厚度，不能裁）
  if (n > 0 && Number.isFinite(inner)) {
    if (sg > 0) l[a] = Math.max(l[a], inner);
    else h[a] = Math.min(h[a], inner);
  }
  return clampBox(fromLoHi(l, h), s.vol);
}

/**
 * 在裁切範圍內算這一步的結果；範圍超過 cap 個體素就回傳 null（留給 Worker）。
 * 範圍內逐體素和 applyOp 的結果相同；範圍外這一步本來就不會改到。
 * box：呼叫端已經算好的 previewBox（applyOpInPlace 傳進來，同一個 Op 不算第二次；plan v15 §5.1）。
 */
export function previewOp(s: EditState, orig: Volume, op: Op, cap = Infinity, report?: Report, box0?: BBox | null): Preview | null {
  const box = box0 === undefined ? previewBox(s, op) : box0;
  if (!box || boxVoxels(box) > cap) return null;
  const vol = cropVolume(s.vol, box);
  const o = cropVolume(orig, box);
  if (isAdjacent(op)) {
    const { dir, n } = adjacentDir(op);
    const masks = [...new Set(op.keys)].map((k) => cropMask(s.L, new Set([k]), s.vol, box));
    return { box, data: adjacentMasks(vol, masks, op.kind, dir, n, op.follow, op.liners, report).data };
  }
  const mask = cropMask(s.L, new Set(op.keys), s.vol, box);
  // scope 換成裁切範圍裡的座標（超出的部分本來就不會被改）
  const off = [box.x0, box.y0, box.z0][axisIndex(op.scope.axis)];
  const zr = { axis: op.scope.axis, lo: op.scope.lo - off, hi: op.scope.hi - off };
  let out: Volume;
  if (op.kind === 'push') out = growMask(vol, o, mask, zr, op.dir, op.n, op.backfill, op.follow, report, op.policy ?? 'overwrite');
  else if (op.kind === 'translate') out = translateMask(vol, o, mask, zr, op.d, op.backfill, !!op.follow);
  else out = setMaskMaterial(vol, mask, zr, op.m);
  return { box, data: out.data };
}
