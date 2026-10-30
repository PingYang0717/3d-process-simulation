// 即時預覽：一步操作只會改到選取外框附近，所以把那一小塊裁下來、在主執行緒用同一組純函式算一次，
// 幾十毫秒就能畫出結果；Worker 的正式結果（含 relabel）之後再覆蓋。裁下來的範圍內逐體素和正式結果相同（有測試）。
import {
  type BBox,
  type Labeled,
  type Vec3,
  type Volume,
  LINER_MAX,
  growMask,
  levelMask,
  localMask,
  setMaskMaterial,
  translateMask,
  unionBBox,
} from './volume';
import { type EditState, type Op, radiusOf } from './ops';

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
  const l = lo(b);
  const h = hi(b);
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
  if (op.kind === 'translate') {
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
export function previewOp(s: EditState, orig: Volume, op: Op, cap = Infinity): Preview | null {
  const box = previewBox(s, op);
  if (!box || boxVoxels(box) > cap) return null;
  const vol = cropVolume(s.vol, box);
  const o = cropVolume(orig, box);
  const mask = cropMask(s.L, new Set(op.keys), s.vol, box);
  const zr: [number, number] = [Math.max(0, op.zRange[0] - box.z0), Math.min(vol.Z - 1, op.zRange[1] - box.z0)];
  const shift = (p: Vec3): Vec3 => [p[0] - box.x0, p[1] - box.y0, p[2] - box.z0];
  let out: Volume;
  if (op.kind === 'push') {
    const m = op.local ? localMask(vol, mask, op.dir, shift(op.local.center), radiusOf(op.local), op.local.shape ?? 'round') : mask;
    out = growMask(vol, o, m, zr, op.dir, op.n, op.backfill, op.follow);
  } else if (op.kind === 'level') {
    const a = op.dir[0] ? 0 : op.dir[1] ? 1 : 2;
    const to = op.to - [box.x0, box.y0, box.z0][a];
    out = levelMask(vol, o, mask, zr, op.dir, shift(op.local.center), radiusOf(op.local), op.local.shape ?? 'round', to, op.backfill, !!op.follow);
  } else if (op.kind === 'translate') out = translateMask(vol, o, mask, zr, op.d, op.backfill);
  else out = setMaskMaterial(vol, mask, zr, op.m);
  return { box, data: out.data };
}
