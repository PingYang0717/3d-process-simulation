// 疊圖與 A vs B（plan v11 §4.4）：純函式，不碰 React。
// - 每個 split 在這一片的輪廓（trace.ts 的 boundaryLoops，含內環），快取 key＝(版本, 軸, 片, keys)。
// - 所有 split 在這一片的差異聯集外框（＋邊距），沒有差異回 null。
// - 兩個版本的差異 mask（基準不是原始時），快取 key＝版本對。
import type { Axis, Labeled, Volume } from '../../volume/volume';
import { type XY, boundaryLoops } from '../../slice/trace';

export interface UVBox {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** 切面寬高與 (u, v, t) → index。 */
export function sliceGeom(vol: Pick<Volume, 'X' | 'Y' | 'Z'>, axis: Axis) {
  const { X, Y, Z } = vol;
  const [W, H] = axis === 'z' ? [X, Y] : axis === 'y' ? [X, Z] : [Z, Y];
  // YZ（axis x）：u＝z、v＝y，和 drawSlice 同一個方向（plan v12 修正：以前寫成 (v·Y＋u)·X，u／v 對調）
  const index = axis === 'z' ? (u: number, v: number, t: number) => (t * Y + v) * X + u : axis === 'y' ? (u: number, v: number, t: number) => (v * Y + t) * X + u : (u: number, v: number, t: number) => (u * Y + v) * X + t;
  return { W, H, index };
}

export const overlayKey = (version: number, axis: Axis, at: number, keys: string[]) => `${version}|${axis}|${at}|${[...keys].sort().join(',')}`;

/** 一片上屬於 keys 的格子描成封閉折線（整數角座標）。 */
export function contourOf(L: Labeled, vol: Pick<Volume, 'X' | 'Y' | 'Z'>, keys: string[], axis: Axis, at: number): XY[][] {
  const ks = new Set(keys);
  const on = new Uint8Array(L.comps.length + 1);
  L.comps.forEach((c, i) => ks.has(c.key) && (on[i] = 1));
  const { W, H, index } = sliceGeom(vol, axis);
  const inside = (u: number, v: number) => {
    if (u < 0 || v < 0 || u >= W || v >= H) return false;
    const l = L.labels[index(u, v, at)];
    return l >= 0 && on[l] === 1;
  };
  return boundaryLoops(inside, 0, 0, W - 1, H - 1);
}

/** 輪廓快取（換片才重描）。 */
export function contourCache(limit = 400) {
  const m = new Map<string, XY[][]>();
  let hits = 0;
  let misses = 0;
  return {
    get(key: string, make: () => XY[][]) {
      const v = m.get(key);
      if (v) {
        hits++;
        return v;
      }
      misses++;
      const out = make();
      m.set(key, out);
      if (m.size > limit) m.delete(m.keys().next().value!);
      return out;
    },
    stats: () => ({ hits, misses, size: m.size }),
  };
}

/** a 和 b 在這一片不同的格子：外框與格數。 */
export function sliceDiff(a: Uint8Array, b: Uint8Array, vol: Pick<Volume, 'X' | 'Y' | 'Z'>, axis: Axis, at: number): { box: UVBox | null; count: number } {
  const { W, H, index } = sliceGeom(vol, axis);
  let u0 = W;
  let v0 = H;
  let u1 = -1;
  let v1 = -1;
  let count = 0;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const i = index(u, v, at);
      if (a[i] === b[i]) continue;
      count++;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  return { box: u1 < 0 ? null : { u0, v0, u1, v1 }, count };
}

/** 外框聯集 ± pad，夾在切面內；全是 null 回 null。 */
export function unionUV(boxes: (UVBox | null)[], pad: number, W: number, H: number): UVBox | null {
  const bs = boxes.filter((b): b is UVBox => !!b);
  if (!bs.length) return null;
  return {
    u0: Math.max(0, Math.min(...bs.map((b) => b.u0)) - pad),
    v0: Math.max(0, Math.min(...bs.map((b) => b.v0)) - pad),
    u1: Math.min(W - 1, Math.max(...bs.map((b) => b.u1)) + pad),
    v1: Math.min(H - 1, Math.max(...bs.map((b) => b.v1)) + pad),
  };
}

/** 兩個版本的差異 mask（A vs B 的基準不是原始時），快取 key＝版本對。 */
const pairCache = new Map<string, { mask: Uint8Array; count: number }>();
export function diffPair(va: number, a: Uint8Array, vb: number, b: Uint8Array) {
  const key = `${va}|${vb}`;
  let r = pairCache.get(key);
  if (r) return r;
  const mask = new Uint8Array(a.length);
  let count = 0;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      mask[i] = 1;
      count++;
    }
  r = { mask, count };
  pairCache.set(key, r);
  // 只留最近 24 對（每對一個整陣列大小的 mask）
  if (pairCache.size > 24) pairCache.delete(pairCache.keys().next().value!);
  return r;
}

/** 輪廓 → SVG path。 */
export const loopsPath = (loops: XY[][]) => loops.map((l) => `M${l.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`).join('');
