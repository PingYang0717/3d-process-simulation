// 放大的切面怎麼擺（plan v18 §3.2）：縮放＝每個體素幾個 CSS px，(tx, ty)＝圖的左上角在視窗裡的位置。
// 搬自完整版 SliceEditor 的 fit／aim／zoomAt，改成純函式（好測）。
import type { Axis, BBox } from '../../volume/volume';
import { planeAxes } from '../../volume/scope';

export interface ViewXf {
  zoom: number;
  tx: number;
  ty: number;
}
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 32;
export const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** 整張切面放進 w×h 的視窗，置中、四周留 3%。 */
export function fitXf(w: number, h: number, W: number, H: number): ViewXf {
  const zoom = clampZoom(Math.min(w / W, h / H) * 0.94);
  return { zoom, tx: (w - W * zoom) / 2, ty: (h - H * zoom) / 2 };
}

/** 切面上的一塊（含端點）放到視窗中央，四周留 30%（看得到旁邊的結構）。 */
export function aimXf(w: number, h: number, box: { u0: number; v0: number; u1: number; v1: number }): ViewXf {
  const bw = box.u1 - box.u0 + 1;
  const bh = box.v1 - box.v0 + 1;
  const zoom = clampZoom(Math.min(w / (bw * 1.6 + 4), h / (bh * 1.6 + 4)));
  const cu = (box.u0 + box.u1 + 1) / 2;
  const cv = (box.v0 + box.v1 + 1) / 2;
  return { zoom, tx: w / 2 - cu * zoom, ty: h / 2 - cv * zoom };
}

/** 縮放到 zoom，視窗上的 (cx, cy) 那一點底下的體素不動。 */
export function zoomXf(p: ViewXf, zoom: number, cx: number, cy: number): ViewXf {
  const z = clampZoom(zoom);
  return { zoom: z, tx: cx - ((cx - p.tx) * z) / p.zoom, ty: cy - ((cy - p.ty) * z) / p.zoom };
}

/** 視窗上的一點 → 切面上的 (u, v)（小數；取 floor 就是體素）。 */
export const uvAtXf = (p: ViewXf, x: number, y: number): [number, number] => [(x - p.tx) / p.zoom, (y - p.ty) / p.zoom];

/** 3D 外框在這個方向的切面上佔哪一塊。 */
export function boxInPlane(axis: Axis, b: BBox) {
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  const [ua, va] = planeAxes(axis);
  return { u0: lo[ua], v0: lo[va], u1: hi[ua], v1: hi[va] };
}

/** 每個方向上次的縮放與位置（這個 session 裡記住；回 3D 再放大時還原）。載入新檔案時清掉。 */
export const zoomMemory = new Map<Axis, ViewXf>();
