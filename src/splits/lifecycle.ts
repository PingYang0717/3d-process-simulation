// split 生命週期（plan v12 §5.3）：live（有整本帳簿）／parked（只留補丁）。純函式，主執行緒、Worker、測試共用。
// 補丁＝和原始不同（data 或 labels）的外框裡的 data／labels；外框外和原始逐位元組相同（每一步的補丁外框、
// relabel 的 S 與換編號的結構外框都 union 進 touch，所以外面不會有不同）。
import type { Axis, BBox, Comp, Labeled, Volume } from '../volume/volume';
import { type Step, boxSize, cropArr, pasteArr, tightBox, unionBox } from '../volume/patch';

type Dims = { X: number; Y: number; Z: number };

export interface SplitPatch {
  /** 和原始不同（data 或 labels）的外框；null＝和原始完全相同。 */
  box: BBox | null;
  /** box 內的 data／labels（box 為 null 時長度 0）。 */
  data: Uint8Array;
  labels: Int32Array;
  /** 這個 split 的結構清單（key、bbox、count）。 */
  comps: Comp[];
}

/** 兩種狀態都有的摘要：卡片、矩陣、manifest 用，不必碰整個陣列。 */
export interface SplitStats {
  /** 和原始不同的格數。 */
  changed: number;
  /** 和原始不同的格子的外框（貼合）。 */
  diffBox: BBox | null;
  /** 材質體積帳（長度 256）。 */
  counts: Float64Array;
}

/** 一步補丁碰到的所有範圍：data 外框、labels 的 S、換編號的結構外框。 */
export function stepTouch(step: Step): BBox | null {
  let b = step.data ? { ...step.data.box } : null;
  if (step.labels) {
    b = unionBox(b, step.labels.box);
    for (const m of step.labels.moves) b = unionBox(b, m.box);
  }
  return b;
}

/** 在 loose 裡掃「data 或 labels 和原始不同」收緊成貼合的外框。O(loose)。 */
export function changedBox(dims: Dims, data: Uint8Array, labels: Int32Array, orig: Uint8Array, origLabels: Int32Array, loose: BBox | null): BBox | null {
  if (!loose) return null;
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  let z0 = Infinity;
  let z1 = -1;
  for (let z = loose.z0; z <= loose.z1; z++)
    for (let y = loose.y0; y <= loose.y1; y++) {
      const row = (z * dims.Y + y) * dims.X;
      let any = false;
      for (let x = loose.x0; x <= loose.x1; x++) {
        const i = row + x;
        if (data[i] !== orig[i] || labels[i] !== origLabels[i]) {
          any = true;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
      if (any) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
  return x1 < 0 ? null : { x0, x1, y0, y1, z0, z1 };
}

/** live 帳簿 → 補丁（park）：O(loose)。loose＝所有改過的範圍的聯集（寬鬆）。 */
export function extractPatch(dims: Dims, data: Uint8Array, labels: Int32Array, orig: Uint8Array, origLabels: Int32Array, loose: BBox | null, comps: Comp[]): SplitPatch {
  const box = changedBox(dims, data, labels, orig, origLabels, loose);
  return box ? { box, data: cropArr(data, dims, box), labels: cropArr(labels, dims, box), comps } : { box: null, data: new Uint8Array(0), labels: new Int32Array(0), comps };
}

/** 補丁貼到原始的複本上（原地）。 */
export function applyPatch(dims: Dims, data: Uint8Array, labels: Int32Array, p: SplitPatch) {
  if (!p.box) return;
  pasteArr(data, dims, p.box, p.data);
  pasteArr(labels, dims, p.box, p.labels);
}

/** 補丁的 diff 統計：box 內和原始不同的格數、貼合外框、體積帳（原始＋差量）。O(box)。 */
export function patchStats(dims: Dims, p: SplitPatch, orig: Uint8Array, origCounts: Float64Array): SplitStats {
  const counts = origCounts.slice();
  if (!p.box) return { changed: 0, diffBox: null, counts };
  const b = p.box;
  const W = b.x1 - b.x0 + 1;
  let changed = 0;
  let x0 = Infinity;
  let x1 = -1;
  let y0 = Infinity;
  let y1 = -1;
  let z0 = Infinity;
  let z1 = -1;
  for (let z = b.z0, k = 0; z <= b.z1; z++)
    for (let y = b.y0; y <= b.y1; y++) {
      const row = (z * dims.Y + y) * dims.X + b.x0;
      for (let x = 0; x < W; x++, k++) {
        const o = orig[row + x];
        const m = p.data[k];
        if (m === o) continue;
        counts[o]--;
        counts[m]++;
        changed++;
        const gx = b.x0 + x;
        if (gx < x0) x0 = gx;
        if (gx > x1) x1 = gx;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
    }
  return { changed, diffBox: x1 < 0 ? null : { x0, x1, y0, y1, z0, z1 }, counts };
}

/** 一本帳簿（主執行緒 SplitBuffers 的形狀）。 */
export interface Buffers {
  data: Uint8Array;
  labels: Int32Array;
  diff: Uint8Array;
  diffCount: number;
  counts: Float64Array;
  /** 所有改過的範圍（寬鬆）：park 時只掃這裡。 */
  touch: BBox | null;
}

/** restore：原始複本（O(N) memcpy）→ 貼補丁 → box 內對照原始算 diff 與體積帳。 */
export function restoreBuffers(dims: Dims, orig: Uint8Array, origLabels: Int32Array, origCounts: Float64Array, p: SplitPatch): Buffers {
  const data = orig.slice();
  const labels = origLabels.slice();
  const diff = new Uint8Array(orig.length);
  applyPatch(dims, data, labels, p);
  const st = patchStats(dims, p, orig, origCounts);
  if (p.box) {
    const b = p.box;
    for (let z = b.z0; z <= b.z1; z++)
      for (let y = b.y0; y <= b.y1; y++) {
        const row = (z * dims.Y + y) * dims.X;
        for (let x = b.x0; x <= b.x1; x++) if (data[row + x] !== orig[row + x]) diff[row + x] = 1;
      }
  }
  return { data, labels, diff, diffCount: st.changed, counts: st.counts, touch: p.box ? { ...p.box } : null };
}

/** live 帳簿的摘要（diff 外框只掃 touch）。 */
export function buffersStats(dims: Dims, b: Buffers): SplitStats {
  return { changed: b.diffCount, diffBox: b.diffCount ? tightBox(dims, b.diff, b.touch) : null, counts: b.counts };
}

/** 補丁佔多少位元組。 */
export const patchBytes = (p: SplitPatch | null) => (p ? p.data.byteLength + p.labels.byteLength : 0);

// ---- 切面（parked split 不還原；plan v12 §5.3） ----

/**
 * 一片切面：法線軸長度 1 的假 Volume（at＝0），drawSlice／sliceDiff／contourOf 只靠 dims 與 index 算，所以直接吃。
 * diff＝和原始不同（同一片）。
 */
export interface Slab {
  axis: Axis;
  at: number;
  vol: Volume;
  L: Labeled;
  diff: Uint8Array;
  diffCount: number;
  /** 原始同一片（輪廓、A vs B 用）。 */
  orig: Uint8Array;
}

/** 假 Volume 的 dims：法線軸長度 1。 */
export const slabDims = (d: Dims, axis: Axis): Dims => (axis === 'z' ? { X: d.X, Y: d.Y, Z: 1 } : axis === 'y' ? { X: d.X, Y: 1, Z: d.Z } : { X: 1, Y: d.Y, Z: d.Z });

/** 從整個陣列切一片（假 Volume 的排列）。 */
export function cutSlab<T extends Uint8Array | Int32Array>(src: T, d: Dims, axis: Axis, at: number): T {
  const s = slabDims(d, axis);
  const out = new (src.constructor as { new (n: number): T })(s.X * s.Y * s.Z);
  if (axis === 'z') out.set(src.subarray(at * d.X * d.Y, (at + 1) * d.X * d.Y));
  else if (axis === 'y') for (let z = 0; z < d.Z; z++) out.set(src.subarray((z * d.Y + at) * d.X, (z * d.Y + at + 1) * d.X), z * d.X);
  else for (let z = 0, k = 0; z < d.Z; z++) for (let y = 0; y < d.Y; y++, k++) out[k] = src[(z * d.Y + y) * d.X + at];
  return out;
}

/** 補丁和這一片相交的部分蓋到 slab 上（原地）。 */
function pasteSlab<T extends Uint8Array | Int32Array>(slab: T, d: Dims, axis: Axis, at: number, box: BBox, src: T) {
  const W = box.x1 - box.x0 + 1;
  const H = box.y1 - box.y0 + 1;
  if (axis === 'z') {
    if (at < box.z0 || at > box.z1) return;
    const z = at - box.z0;
    for (let y = 0; y < H; y++) slab.set(src.subarray((z * H + y) * W, (z * H + y + 1) * W), (y + box.y0) * d.X + box.x0);
  } else if (axis === 'y') {
    if (at < box.y0 || at > box.y1) return;
    const y = at - box.y0;
    for (let z = 0; z <= box.z1 - box.z0; z++) slab.set(src.subarray((z * H + y) * W, (z * H + y + 1) * W), (z + box.z0) * d.X + box.x0);
  } else {
    if (at < box.x0 || at > box.x1) return;
    const x = at - box.x0;
    for (let z = 0; z <= box.z1 - box.z0; z++) for (let y = 0; y < H; y++) slab[(z + box.z0) * d.Y + y + box.y0] = src[(z * H + y) * W + x];
  }
}

/** parked split 的一片：原始那一片＋補丁。O(一片＋補丁和這片相交)。 */
export function slabOfPatch(d: Dims, orig: Uint8Array, origLabels: Int32Array, p: SplitPatch, axis: Axis, at: number): Slab {
  const o = cutSlab(orig, d, axis, at);
  const data = o.slice();
  const labels = cutSlab(origLabels, d, axis, at);
  if (p.box) {
    pasteSlab(data, d, axis, at, p.box, p.data);
    pasteSlab(labels, d, axis, at, p.box, p.labels);
  }
  return finish(d, axis, at, data, labels, p.comps, o);
}

/** live split（或原始）的一片：直接從整個陣列切。 */
export function slabOfArrays(d: Dims, data: Uint8Array, labels: Int32Array, comps: Comp[], orig: Uint8Array, axis: Axis, at: number): Slab {
  return finish(d, axis, at, cutSlab(data, d, axis, at), cutSlab(labels, d, axis, at), comps, cutSlab(orig, d, axis, at));
}

function finish(d: Dims, axis: Axis, at: number, data: Uint8Array, labels: Int32Array, comps: Comp[], o: Uint8Array): Slab {
  const diff = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++)
    if (data[i] !== o[i]) {
      diff[i] = 1;
      n++;
    }
  const s = slabDims(d, axis);
  return { axis, at, vol: { ...s, data }, L: { labels, comps }, diff, diffCount: n, orig: o };
}

// ---- live 集合（plan v12 §5.3 政策、§10 D4） ----

/** 預設同時 live 幾個 split：N ≤ 500 萬 → 8、≤ 2,000 萬 → 3、否則 1。 */
export const defaultLiveK = (N: number) => (N <= 5_000_000 ? 8 : N <= 20_000_000 ? 3 : 1);

/**
 * 要 park 哪些：lru 是最近用過的在前（含 active）；active 與 pinned（正在產生／匯出）永遠留著，
 * 其他依 lru 順序留到 K 個。只看 live（有帳簿）的。
 */
export function toPark(live: string[], lru: string[], K: number, active: string, pinned: Iterable<string> = []): string[] {
  const keep = new Set<string>([active, ...pinned]);
  let n = live.filter((id) => keep.has(id)).length;
  // 最近用過的先留；沒在 lru 裡的（剛 restore、還沒用過）照清單順序
  for (const id of [...lru, ...live]) {
    if (n >= Math.max(1, K)) break;
    if (live.includes(id) && !keep.has(id)) {
      keep.add(id);
      n++;
    }
  }
  return live.filter((id) => !keep.has(id));
}

export { boxSize };
