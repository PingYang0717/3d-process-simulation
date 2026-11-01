// 2D 縮圖（plan v12 §5.5）：純函式（選軸、選片、裁切、畫像素＋原始輪廓）＋ ImageBitmap 的 LRU。
// 同一個設計的 split 共用一個軸（整個設計的 diff 外框聯集最長的那一軸當法線），片＝各自改最多的那一片；
// 對照組（沒改動）用結構中點。像素：sliceRGBA（深藍邊、拿掉的紅）→ 裁到 diff 外框 ∪ 改到結構的外框 ＋8 格 →
// nearest 縮放（長邊 ≤ 240）→ 疊原始輪廓（黑線）。
import type { Axis, BBox, Vec3 } from '../../volume/volume';
import type { XY } from '../../slice/trace';
import type { Slab } from '../../splits/lifecycle';
import { sliceRGBA } from './drawSlice';
import type { UVBox } from './overlay';

type Dims = { X: number; Y: number; Z: number };
export const THUMB_MAX = 240;
const AX = { x: 0, y: 1, z: 2 } as const;
/** 切面的 (u, v) 軸（和 sliceGeom 同一套）。 */
const uvAxes = (axis: Axis): [0 | 1 | 2, 0 | 1 | 2] => (axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1]);
const lo = (b: BBox) => [b.x0, b.y0, b.z0];
const hi = (b: BBox) => [b.x1, b.y1, b.z1];

/** 外框聯集。 */
export function unionBoxes(bs: (BBox | null | undefined)[]): BBox | null {
  let u: BBox | null = null;
  for (const b of bs) {
    if (!b) continue;
    u = u ? { x0: Math.min(u.x0, b.x0), x1: Math.max(u.x1, b.x1), y0: Math.min(u.y0, b.y0), y1: Math.max(u.y1, b.y1), z0: Math.min(u.z0, b.z0), z1: Math.max(u.z1, b.z1) } : { ...b };
  }
  return u;
}

/**
 * 自動選軸：法線＝外框最長的那一軸（同長照 x、z、y）。plan 原訂「投影面積最大」，實測切到的是垂直於改動方向的那一面
 * （例：沿 z 改 CD／偏移的 poly，XY 切面只看到整片截面），改成沿最長軸切，改動方向落在切面上（見 plan v12 §11）。沒有外框回 null。
 */
export function autoAxis(box: BBox | null): Axis | null {
  if (!box) return null;
  const w = [box.x1 - box.x0 + 1, box.y1 - box.y0 + 1, box.z1 - box.z0 + 1];
  const order: [Axis, number][] = [
    ['x', w[0]],
    ['z', w[2]],
    ['y', w[1]],
  ];
  return order.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/** 結構最長的那一軸的法線（對照組、沒有任何差異時的軸）。 */
export function longestAxisOf(b: BBox | null): Axis {
  if (!b) return 'z';
  const w = [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0];
  // 最長軸躺在切面上：法線取另外兩軸裡最短的
  const k = w.indexOf(Math.max(...w));
  const others = ([0, 1, 2] as const).filter((a) => a !== k);
  const n = w[others[0]] <= w[others[1]] ? others[0] : others[1];
  return (['x', 'y', 'z'] as Axis[])[n];
}

/** 片：diff 外框在這個軸的中點；沒有 diff 用結構外框中點；都沒有用陣列中點。 */
export function thumbAt(axis: Axis, diffBox: BBox | null, structBox: BBox | null, dims: Dims): number {
  const a = AX[axis];
  const b = diffBox ?? structBox;
  if (!b) return Math.floor([dims.X, dims.Y, dims.Z][a] / 2);
  return (lo(b)[a] + hi(b)[a]) >> 1;
}

/** 裁切：外框們投影到切面的聯集 ± pad，夾在切面內；都沒有＝整片。 */
export function thumbCrop(axis: Axis, boxes: (BBox | null | undefined)[], dims: Dims, pad = 8): UVBox {
  const [ua, va] = uvAxes(axis);
  const D = [dims.X, dims.Y, dims.Z];
  const u = unionBoxes(boxes);
  if (!u) return { u0: 0, v0: 0, u1: D[ua] - 1, v1: D[va] - 1 };
  return { u0: Math.max(0, lo(u)[ua] - pad), v0: Math.max(0, lo(u)[va] - pad), u1: Math.min(D[ua] - 1, hi(u)[ua] + pad), v1: Math.min(D[va] - 1, hi(u)[va] + pad) };
}

/** 縮圖大小：長邊 ≤ max，nearest。 */
export const thumbScale = (c: UVBox, max = THUMB_MAX) => Math.min(8, max / Math.max(c.u1 - c.u0 + 1, c.v1 - c.v0 + 1));

/** 原始輪廓的黑線。 */
export const LOOP_RGB: Vec3 = [17, 17, 17];

/**
 * 縮圖像素（純函式，測試可比對）：slab 畫成 RGBA（含 diff 深藍邊與拿掉的紅）→ 裁 crop → nearest 縮放 → 疊原始輪廓。
 * loops 是同一片原始的輪廓（切面座標、整數角）。
 */
export function thumbRGBA(slab: Slab, crop: UVBox, rgb: Map<number, Vec3>, hidden: Set<number>, loops: XY[][], max = THUMB_MAX): { W: number; H: number; data: Uint8ClampedArray } {
  const full = sliceRGBA(slab.vol, slab.axis, 0, rgb, hidden, null, slab.diff);
  const s = thumbScale(crop, max);
  const CW = crop.u1 - crop.u0 + 1;
  const CH = crop.v1 - crop.v0 + 1;
  const W = Math.max(1, Math.round(CW * s));
  const H = Math.max(1, Math.round(CH * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const src = new Uint32Array(full.data.buffer, full.data.byteOffset, full.W * full.H);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    const v = crop.v0 + Math.min(CH - 1, Math.floor(y / s));
    const row = v * full.W;
    for (let x = 0; x < W; x++) dst[y * W + x] = src[row + crop.u0 + Math.min(CW - 1, Math.floor(x / s))];
  }
  // 原始輪廓：軸向的線段，畫 1 px（座標＝角，換到縮圖像素）
  const ink = (LOOP_RGB[0] | (LOOP_RGB[1] << 8) | (LOOP_RGB[2] << 16) | (255 << 24)) >>> 0;
  const px = (u: number) => Math.min(W - 1, Math.max(0, Math.round((u - crop.u0) * s)));
  const py = (v: number) => Math.min(H - 1, Math.max(0, Math.round((v - crop.v0) * s)));
  for (const loop of loops)
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k];
      const q = loop[(k + 1) % loop.length];
      // 完全在裁切外的線段不畫
      if ((p[0] < crop.u0 && q[0] < crop.u0) || (p[0] > crop.u1 + 1 && q[0] > crop.u1 + 1) || (p[1] < crop.v0 && q[1] < crop.v0) || (p[1] > crop.v1 + 1 && q[1] > crop.v1 + 1)) continue;
      const x0 = px(p[0]);
      const y0 = py(p[1]);
      const x1 = px(q[0]);
      const y1 = py(q[1]);
      if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) dst[y0 * W + x] = ink;
      else if (x0 === x1) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) dst[y * W + x0] = ink;
      else {
        // 斜線（不會發生在體素輪廓，保險）
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let i = 0; i <= n; i++) dst[Math.round(y0 + ((y1 - y0) * i) / n) * W + Math.round(x0 + ((x1 - x0) * i) / n)] = ink;
      }
    }
  return { W, H, data: out };
}

// ---- ImageBitmap 快取（全域 LRU 300 張，plan v12 §5.5） ----

const bitmaps = new Map<string, ImageBitmap | HTMLCanvasElement>();
const LIMIT = 300;
export function thumbCached(key: string) {
  const b = bitmaps.get(key);
  if (b) {
    bitmaps.delete(key);
    bitmaps.set(key, b);
  }
  return b;
}
export function thumbStore(key: string, b: ImageBitmap | HTMLCanvasElement) {
  bitmaps.set(key, b);
  while (bitmaps.size > LIMIT) {
    const k = bitmaps.keys().next().value!;
    const old = bitmaps.get(k);
    if (old && 'close' in old) old.close();
    bitmaps.delete(k);
  }
}
/** 開發模式量測：快取了幾張。 */
export const thumbCount = () => bitmaps.size;

/**
 * 結構縮圖（plan v12 §5.4 設計區第 1 步，120 px）：結構用選取藍、其他半透明（混白）；face＝滑過六面小方塊的那一面（橘線）。
 */
export function structThumbRGBA(
  slab: Slab,
  crop: UVBox,
  rgb: Map<number, Vec3>,
  hidden: Set<number>,
  on: Set<number>,
  box: BBox | null,
  face: Vec3 | null,
  max = 120,
): { W: number; H: number; data: Uint8ClampedArray } {
  const full = sliceRGBA(slab.vol, slab.axis, 0, rgb, hidden, null, null);
  const s = thumbScale(crop, max);
  const CW = crop.u1 - crop.u0 + 1;
  const CH = crop.v1 - crop.v0 + 1;
  const W = Math.max(1, Math.round(CW * s));
  const H = Math.max(1, Math.round(CH * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const lab = slab.L.labels;
  for (let y = 0; y < H; y++) {
    const v = crop.v0 + Math.min(CH - 1, Math.floor(y / s));
    for (let x = 0; x < W; x++) {
      const u = crop.u0 + Math.min(CW - 1, Math.floor(x / s));
      const i = v * full.W + u;
      const o = (y * W + x) * 4;
      const sel = on.has(lab[i]);
      for (let c = 0; c < 3; c++) {
        const p = full.data[i * 4 + c];
        out[o + c] = sel ? (p + [22, 119, 255][c]) >> 1 : Math.round(p * 0.35 + 255 * 0.65);
      }
      out[o + 3] = 255;
    }
  }
  if (box && face) {
    const a = face[0] ? 0 : face[1] ? 1 : 2;
    const [ua, va] = uvAxes(slab.axis);
    const lo3 = lo(box);
    const hi3 = hi(box);
    const line = (vertical: boolean, at: number, from: number, to: number) => {
      for (let t = from; t <= to; t++)
        for (let w = -1; w <= 0; w++) {
          const x = vertical ? at + w : t;
          const y = vertical ? t : at + w;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const o = (y * W + x) * 4;
          out[o] = 250;
          out[o + 1] = 84;
          out[o + 2] = 28;
        }
    };
    const X = (u: number) => Math.round((u - crop.u0) * s);
    const Y = (v: number) => Math.round((v - crop.v0) * s);
    if (a === ua) line(true, X(face[a] > 0 ? hi3[a] + 1 : lo3[a]), Y(lo3[va]), Y(hi3[va] + 1) - 1);
    else if (a === va) line(false, Y(face[a] > 0 ? hi3[a] + 1 : lo3[a]), X(lo3[ua]), X(hi3[ua] + 1) - 1);
  }
  return { W, H, data: out };
}
