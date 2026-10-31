// 切面畫成像素（plan v9 P11）：主切面、下方小切面、3D 剖面貼圖共用，所以逐像素相同。
// LUT 版：材質色（隱藏的折成淡灰）與「混藍」各一張 256 色表；依軸特化索引遞增（不呼叫 toVoxel／idx、不配陣列）；
// 預覽盒用列區間判斷；差異描紅邊在同一份像素裡做 4 鄰居判斷，最後一次 putImageData。
// 輸出和舊版逐位元組相同（drawSlice.test.ts 留著舊版當參考）。
import type { Axis, Vec3, Volume } from '../../volume/volume';
import type { Preview } from '../../volume/preview';

/** 選取混的藍。 */
export const SEL_RGB: Vec3 = [22, 119, 255];
const HIDDEN_RGB = 245;
const MISSING: Vec3 = [255, 0, 255];
const DIFF_RGB: Vec3 = [255, 77, 79];

/** 切面像素大小（u 往右、v 往下）。 */
export const sliceSize = (vol: { X: number; Y: number; Z: number }, axis: Axis): [number, number] =>
  axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];

/** 切面的 RGBA（長度 W×H×4）。out 有給且大小對就重用。 */
export function sliceRGBA(
  vol: Volume,
  axis: Axis,
  at: number,
  rgb: Map<number, Vec3>,
  hidden: Set<number>,
  selMask: Uint8Array | null,
  diff: Uint8Array | null,
  patch?: Preview | null,
  out?: Uint8ClampedArray,
): { W: number; H: number; data: Uint8ClampedArray } {
  const { X, Y } = vol;
  const [W, H] = sliceSize(vol, axis);
  const data = out && out.length === W * H * 4 ? out : new Uint8ClampedArray(W * H * 4);
  // 色表：每個材質一個 RGBA（一次寫 32 位元；little-endian：R 在最低位元組）；混藍另一張
  const lut = new Uint32Array(256);
  const blu = new Uint32Array(256);
  for (let m = 0; m < 256; m++) {
    const c = hidden.has(m) ? [HIDDEN_RGB, HIDDEN_RGB, HIDDEN_RGB] : (rgb.get(m) ?? MISSING);
    lut[m] = (c[0] | (c[1] << 8) | (c[2] << 16) | (255 << 24)) >>> 0;
    blu[m] = (((c[0] + SEL_RGB[0]) >> 1) | (((c[1] + SEL_RGB[1]) >> 1) << 8) | (((c[2] + SEL_RGB[2]) >> 1) << 16) | (255 << 24)) >>> 0;
  }
  const px = new Uint32Array(data.buffer, data.byteOffset, W * H);
  // 依軸：第 v 列的起點 index 與每往右一格的 index 增量；v 往下一格的增量
  const plane = X * Y;
  const su = axis === 'x' ? plane : 1;
  const sv = axis === 'y' ? plane : X;
  const row0 = axis === 'z' ? at * plane : axis === 'y' ? at * X : at;
  // 預覽盒：切面上 u／v 的範圍與預覽陣列裡的增量
  let pu0 = 1;
  let pu1 = 0;
  let pv0 = 1;
  let pv1 = 0;
  let pAt = -1;
  let psu = 0;
  let psv = 0;
  if (patch) {
    const b = patch.box;
    const PW = b.x1 - b.x0 + 1;
    const PH = b.y1 - b.y0 + 1;
    const [a0, a1] = axis === 'z' ? [b.z0, b.z1] : axis === 'y' ? [b.y0, b.y1] : [b.x0, b.x1];
    if (at >= a0 && at <= a1) {
      [pu0, pu1, pv0, pv1] = axis === 'z' ? [b.x0, b.x1, b.y0, b.y1] : axis === 'y' ? [b.x0, b.x1, b.z0, b.z1] : [b.z0, b.z1, b.y0, b.y1];
      psu = axis === 'x' ? PW * PH : 1;
      psv = axis === 'y' ? PW * PH : PW;
      // 預覽陣列裡 (pu0, pv0) 那一格
      pAt = axis === 'z' ? (at - b.z0) * PW * PH : axis === 'y' ? (at - b.y0) * PW : at - b.x0;
    }
  }
  const pd = patch?.data;
  const d = vol.data;
  for (let v = 0, p = 0; v < H; v++) {
    const r = row0 + v * sv;
    const inPv = pAt >= 0 && v >= pv0 && v <= pv1;
    const prow = inPv ? pAt + (v - pv0) * psv - pu0 * psu : 0;
    // 預覽盒在這一列的區間 [a, b)；區間外直接讀陣列
    const a = inPv ? Math.max(0, pu0) : W;
    const b = inPv ? Math.min(W, pu1 + 1) : W;
    let u = 0;
    let i = r;
    if (selMask) {
      for (; u < a; u++, i += su, p++) px[p] = selMask[i] ? blu[d[i]] : lut[d[i]];
      for (; u < b; u++, i += su, p++) {
        const m = pd![prow + u * psu];
        px[p] = selMask[i] ? blu[m] : lut[m];
      }
      for (; u < W; u++, i += su, p++) px[p] = selMask[i] ? blu[d[i]] : lut[d[i]];
    } else {
      for (; u < a; u++, i += su, p++) px[p] = lut[d[i]];
      for (; u < b; u++, i += su, p++) px[p] = lut[pd![prow + u * psu]];
      for (; u < W; u++, i += su, p++) px[p] = lut[d[i]];
    }
  }
  if (diff) {
    const red = (DIFF_RGB[0] | (DIFF_RGB[1] << 8) | (DIFF_RGB[2] << 16) | (255 << 24)) >>> 0;
    for (let v = 0, p = 0; v < H; v++) {
      const r = row0 + v * sv;
      const edgeRow = v === 0 || v === H - 1;
      for (let u = 0, i = r; u < W; u++, i += su, p++) {
        if (!diff[i]) continue;
        // 4 鄰居有一個不是改過的（或出界）＝邊
        if (edgeRow || u === 0 || u === W - 1 || !diff[i - su] || !diff[i + su] || !diff[i - sv] || !diff[i + sv]) px[p] = red;
      }
    }
  }
  return { W, H, data };
}

/** 把一個切面畫到 canvas：材質顏色、隱藏材質淡灰、選取混藍、差異描紅邊；patch＝即時預覽蓋上去。 */
export function drawSlice(
  cv: HTMLCanvasElement,
  vol: Volume,
  axis: Axis,
  at: number,
  rgb: Map<number, Vec3>,
  hidden: Set<number>,
  selMask: Uint8Array | null,
  diff: Uint8Array | null,
  patch?: Preview | null,
) {
  const [W, H] = sliceSize(vol, axis);
  if (cv.width !== W) cv.width = W;
  if (cv.height !== H) cv.height = H;
  const { data } = sliceRGBA(vol, axis, at, rgb, hidden, selMask, diff, patch);
  cv.getContext('2d')!.putImageData(new ImageData(data, W, H), 0, 0);
}
