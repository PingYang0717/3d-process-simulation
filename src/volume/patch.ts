// 補丁（plan v7 §8.2、§8.3、§10.7）：一步改動＝外框＋外框裡改前、改後的資料。
// 主執行緒用它從目前的陣列做出下一個版本（memcpy＋貼上），復原貼 before、重做貼 after，
// 不必每一步都存整個陣列。
import { type BBox, type Comp, type LabelMove, type Labeled, type Volume, moveLabel } from './volume';

type Dims = { X: number; Y: number; Z: number };
type Arr = Uint8Array | Int32Array;

export const boxSize = (b: BBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);

/** 外框裡的資料（複製）。 */
export function cropArr<T extends Arr>(src: T, dims: Dims, b: BBox): T {
  const W = b.x1 - b.x0 + 1;
  const H = b.y1 - b.y0 + 1;
  const D = b.z1 - b.z0 + 1;
  const out = new (src.constructor as { new (n: number): T })(W * H * D);
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++) {
      const s = ((z + b.z0) * dims.Y + y + b.y0) * dims.X + b.x0;
      out.set(src.subarray(s, s + W), (z * H + y) * W);
    }
  return out;
}

/** 把外框資料貼回整個陣列（原地）。 */
export function pasteArr(dst: Arr, dims: Dims, b: BBox, src: Arr) {
  const W = b.x1 - b.x0 + 1;
  const H = b.y1 - b.y0 + 1;
  const D = b.z1 - b.z0 + 1;
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++) dst.set(src.subarray((z * H + y) * W, (z * H + y + 1) * W), ((z + b.z0) * dims.Y + y + b.y0) * dims.X + b.x0);
}

/** 兩份同外框資料不同的地方（外框座標換回整個陣列）；沒有不同回傳 null。 */
export function diffInBox(a: Uint8Array, b: Uint8Array, box: BBox): BBox | null {
  const W = box.x1 - box.x0 + 1;
  const H = box.y1 - box.y0 + 1;
  const D = box.z1 - box.z0 + 1;
  let x0 = W;
  let x1 = -1;
  let y0 = H;
  let y1 = -1;
  let z0 = D;
  let z1 = -1;
  for (let z = 0, i = 0; z < D; z++)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++, i++)
        if (a[i] !== b[i]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          if (z < z0) z0 = z;
          if (z > z1) z1 = z;
        }
  return x1 < 0 ? null : { x0: x0 + box.x0, x1: x1 + box.x0, y0: y0 + box.y0, y1: y1 + box.y0, z0: z0 + box.z0, z1: z1 + box.z0 };
}

export interface DataPatch {
  box: BBox;
  before: Uint8Array;
  after: Uint8Array;
}
export interface LabelPatch {
  /** 重新標記的範圍 S；外面只有 moves 裡的結構換了編號。 */
  box: BBox;
  before: Int32Array;
  after: Int32Array;
  moves: LabelMove[];
  compsBefore: Comp[];
  compsAfter: Comp[];
}
/** 一步：體素補丁與 labels 補丁（沒改到就都是 null）。 */
export interface Step {
  data: DataPatch | null;
  labels: LabelPatch | null;
}

/**
 * 從 s 套一步補丁做出下一個狀態（新的陣列，s 不變）。dir 'back' = 復原（貼 before、編號反查）。
 */
export function applyStep(s: { vol: Volume; L: Labeled }, step: Step, dir: 'fwd' | 'back' = 'fwd'): { vol: Volume; L: Labeled } {
  const dims = s.vol;
  const data = s.vol.data.slice();
  if (step.data) pasteArr(data, dims, step.data.box, dir === 'fwd' ? step.data.after : step.data.before);
  let L = s.L;
  const lp = step.labels;
  if (lp) {
    const labels = s.L.labels.slice();
    if (dir === 'fwd') for (const m of lp.moves) moveLabel(labels, dims, m.box, m.from, m.to);
    else for (const m of [...lp.moves].reverse()) moveLabel(labels, dims, m.box, m.to, m.from);
    pasteArr(labels, dims, lp.box, dir === 'fwd' ? lp.after : lp.before);
    L = { labels, comps: dir === 'fwd' ? lp.compsAfter : lp.compsBefore };
  }
  return { vol: { X: dims.X, Y: dims.Y, Z: dims.Z, data }, L };
}

/** 補丁佔多少位元組（復原堆疊的記憶體估算）。 */
export const stepBytes = (s: Step) => (s.data ? s.data.before.length * 2 : 0) + (s.labels ? s.labels.before.length * 8 : 0);
