// 疊圖與 A vs B（plan v11 §4.4、plan v15 §5.6 C5）：純函式，不碰 React。
// - 每個 split 在這一片的輪廓（trace.ts 的 boundaryLoops，含內環），只在 keys 的結構外框投影（keysBox）裡描；
//   快取 key＝(版本, 軸, 片, keys, 基準版本)，值＝{ loops, diff }（diff＝這一片對基準的差異外框與格數）。
// - 所有 split 在這一片的差異聯集外框（＋邊距），沒有差異回 null。
// - A vs B 的差異 mask 在 slabs.ts（pairMaskOf，片大小、有快取）；舊的整陣列 diffPair 已刪。
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

/** 切面上 (u, v) 各是哪一個 3D 軸（0＝x、1＝y、2＝z；和 sliceGeom、drawSlice 同一套）。 */
const uvAxes = (axis: Axis): [number, number] => (axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1]);

/**
 * 快取 key：版本、軸、片、keys（順序無關）；baseVersion 有給就一併放進去（疊圖的值含對基準的 diff，基準換了要重算）。
 * 沒給 baseVersion 時和舊版的 key 相同（結果卡片的原始輪廓快取還在用）。
 */
export const overlayKey = (version: number, axis: Axis, at: number, keys: string[], baseVersion?: number) =>
  `${version}|${axis}|${at}|${[...keys].sort().join(',')}` + (baseVersion === undefined ? '' : `|b${baseVersion}`);

/**
 * keys 的結構外框投影到切面的聯集（夾在切面內），描輪廓只要在這裡面掃；L 裡一個 key 都沒有回 null。
 * 只看 u／v 兩軸、不拿法線軸和 at 比：Slab 的 comps 是整個陣列的外框、labels 是切下來的一片（at 固定 0），
 * 兩者 u／v 座標相同，法線軸不能比。O(comps)。
 */
export function keysBox(L: Labeled, keys: Iterable<string>, axis: Axis, W: number, H: number): UVBox | null {
  const ks = keys instanceof Set ? keys : new Set(keys);
  const [ua, va] = uvAxes(axis);
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const c of L.comps) {
    if (!ks.has(c.key)) continue;
    const b = c.bbox;
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    if (lo[ua] < u0) u0 = lo[ua];
    if (lo[va] < v0) v0 = lo[va];
    if (hi[ua] > u1) u1 = hi[ua];
    if (hi[va] > v1) v1 = hi[va];
  }
  if (u1 < u0) return null;
  return { u0: Math.max(0, u0), v0: Math.max(0, v0), u1: Math.min(W - 1, u1), v1: Math.min(H - 1, v1) };
}

/**
 * 一片上屬於 keys 的格子描成封閉折線（整數角座標）。
 * bbox＝描的範圍：省略＝keysBox（keys 的結構外框投影，plan v15 C5）；給 UVBox＝只在那裡面描；'full'＝整片（舊版行為，測試對照用）。
 * 結構的格子一定在它自己的外框裡，所以三種結果逐點相同（overlay.test.ts 守住）。
 */
export function contourOf(L: Labeled, vol: Pick<Volume, 'X' | 'Y' | 'Z'>, keys: string[], axis: Axis, at: number, bbox?: UVBox | 'full'): XY[][] {
  const ks = new Set(keys);
  const on = new Uint8Array(L.comps.length + 1);
  L.comps.forEach((c, i) => ks.has(c.key) && (on[i] = 1));
  const { W, H, index } = sliceGeom(vol, axis);
  const inside = (u: number, v: number) => {
    if (u < 0 || v < 0 || u >= W || v >= H) return false;
    const l = L.labels[index(u, v, at)];
    return l >= 0 && on[l] === 1;
  };
  const b = bbox === 'full' ? { u0: 0, v0: 0, u1: W - 1, v1: H - 1 } : (bbox ?? keysBox(L, ks, axis, W, H));
  if (!b) return [];
  return boundaryLoops(inside, b.u0, b.v0, b.u1, b.v1);
}

/** 輪廓快取（換片才重描）；值的型別可自訂（疊圖放 OverlayEntry、結果卡片放 loops）。超過上限逐出最早放進去的。 */
export function contourCache<T = XY[][]>(limit = 400) {
  const m = new Map<string, T>();
  let hits = 0;
  let misses = 0;
  return {
    get(key: string, make: () => T): T {
      const v = m.get(key);
      if (v !== undefined) {
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

/** 疊圖快取的值（plan v15 C5）：一個 split 在這一片的輪廓＋對基準的差異（外框與格數）。 */
export interface OverlayEntry {
  loops: XY[][];
  diff: { box: UVBox | null; count: number };
}

/** 一個 split 在這一片的 OverlayEntry：輪廓只在 keys 的結構外框裡描，diff＝vol 對 baseData 的差異。 */
export function overlayEntry(L: Labeled, vol: Volume, baseData: Uint8Array, keys: string[], axis: Axis, at: number): OverlayEntry {
  return { loops: contourOf(L, vol, keys, axis, at), diff: sliceDiff(vol.data, baseData, vol, axis, at) };
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

/** 輪廓 → SVG path。 */
export const loopsPath = (loops: XY[][]) => loops.map((l) => `M${l.map((p) => `${p[0]} ${p[1]}`).join('L')}Z`).join('');
