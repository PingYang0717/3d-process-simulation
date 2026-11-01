// 切面畫成像素（plan v9 P11）：主切面、下方小切面、3D 剖面貼圖共用，所以逐像素相同。
// LUT 版：材質色（隱藏的折成淡灰）與「混藍」各一張 256 色表；依軸特化索引遞增（不呼叫 toVoxel／idx、不配陣列）；
// 預覽盒用列區間判斷；差異描邊在同一份像素裡做 4 鄰居判斷，最後一次 putImageData。
// 沒有 diff 時輸出和舊版逐位元組相同（drawSlice.test.ts 留著舊版當參考；差異的顏色 plan v10 改過）。
// plan v15 §5.6 C6：crop 有給就只走裁切窗的列與行、輸出裁切窗大小（縮圖不再整片畫完再裁）；drawSlice 每個 canvas 重用自己的 out。
import type { Axis, Vec3, Volume } from '../../volume/volume';
import type { Preview } from '../../volume/preview';
import type { UVBox } from './overlay';

/** 選取混的藍。 */
export const SEL_RGB: Vec3 = [22, 119, 255];
const HIDDEN_RGB = 245;
const MISSING: Vec3 = [255, 0, 255];
/**
 * 差異模式（plan v10 §4.3）：改過的描深藍邊（和 16 色調色盤每一色對比度 ≥ 3:1，plan 原訂的 #1677ff 只有 1.2～2.9）、
 * 被拿掉的（現在是空、和原始不同）整格紅。改後模式不傳 diff，什麼都不標。
 */
export const DIFF_EDGE_HEX = '#003a8c';
export const DIFF_EDGE_RGB: Vec3 = [0, 58, 140];
export const REMOVED_RGB: Vec3 = [255, 77, 79];

/** 切面像素大小（u 往右、v 往下）。 */
export const sliceSize = (vol: { X: number; Y: number; Z: number }, axis: Axis): [number, number] =>
  axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];

/**
 * 切面的 RGBA（長度 W×H×4）。out 有給且大小對就重用。
 * crop 有給（切面座標、含端點）：只畫裁切窗，回傳的 W／H 是裁切窗大小，像素和整片畫完再裁下來逐位元組相同
 * （差異描邊的 4 鄰居仍看整片：裁切窗邊上的格子不會因為裁切多出一圈邊）。
 */
export function sliceRGBA(
  vol: Volume,
  axis: Axis,
  at: number,
  rgb: Map<number, Vec3>,
  hidden: Set<number>,
  selMask: Uint8Array | null,
  diff: Uint8Array | null,
  patch?: Preview | null,
  out?: Uint8ClampedArray | null,
  crop?: UVBox | null,
): { W: number; H: number; data: Uint8ClampedArray } {
  const { X, Y } = vol;
  const [FW, FH] = sliceSize(vol, axis);
  // 要畫的列與行（整片座標、含端點）
  const cu0 = crop ? Math.max(0, crop.u0) : 0;
  const cv0 = crop ? Math.max(0, crop.v0) : 0;
  const cu1 = crop ? Math.min(FW - 1, crop.u1) : FW - 1;
  const cv1 = crop ? Math.min(FH - 1, crop.v1) : FH - 1;
  const W = Math.max(0, cu1 - cu0 + 1);
  const H = Math.max(0, cv1 - cv0 + 1);
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
  // u／v 都是整片座標（預覽盒、diff 鄰居、陣列 index 都照整片算），p 是輸出像素
  const uEnd = cu1 + 1;
  for (let v = cv0, p = 0; v <= cv1; v++) {
    const r = row0 + v * sv;
    const inPv = pAt >= 0 && v >= pv0 && v <= pv1;
    const prow = inPv ? pAt + (v - pv0) * psv - pu0 * psu : 0;
    // 預覽盒在這一列的區間 [a, b)（夾在裁切窗裡）；區間外直接讀陣列
    const a = inPv ? Math.min(uEnd, Math.max(cu0, pu0)) : uEnd;
    const b = inPv ? Math.max(a, Math.min(uEnd, pu1 + 1)) : uEnd;
    let u = cu0;
    let i = r + cu0 * su;
    if (selMask) {
      for (; u < a; u++, i += su, p++) px[p] = selMask[i] ? blu[d[i]] : lut[d[i]];
      for (; u < b; u++, i += su, p++) {
        const m = pd![prow + u * psu];
        px[p] = selMask[i] ? blu[m] : lut[m];
      }
      for (; u < uEnd; u++, i += su, p++) px[p] = selMask[i] ? blu[d[i]] : lut[d[i]];
    } else {
      for (; u < a; u++, i += su, p++) px[p] = lut[d[i]];
      for (; u < b; u++, i += su, p++) px[p] = lut[pd![prow + u * psu]];
      for (; u < uEnd; u++, i += su, p++) px[p] = lut[d[i]];
    }
  }
  if (diff) {
    const edge = (DIFF_EDGE_RGB[0] | (DIFF_EDGE_RGB[1] << 8) | (DIFF_EDGE_RGB[2] << 16) | (255 << 24)) >>> 0;
    const red = (REMOVED_RGB[0] | (REMOVED_RGB[1] << 8) | (REMOVED_RGB[2] << 16) | (255 << 24)) >>> 0;
    for (let v = cv0, p = 0; v <= cv1; v++) {
      const r = row0 + v * sv;
      // 出界＝整片的邊，不是裁切窗的邊
      const edgeRow = v === 0 || v === FH - 1;
      for (let u = cu0, i = r + cu0 * su; u <= cu1; u++, i += su, p++) {
        if (!diff[i]) continue;
        // 改過而現在是空＝被拿掉：整格紅
        if (!d[i]) px[p] = red;
        // 4 鄰居有一個不是改過的（或出界）＝邊
        else if (edgeRow || u === 0 || u === FW - 1 || !diff[i - su] || !diff[i + su] || !diff[i - sv] || !diff[i + sv]) px[p] = edge;
      }
    }
  }
  return { W, H, data };
}

/** 每個 canvas 自己的 RGBA 緩衝（plan v15 C6）：尺寸不變就重用，不每次配一片。 */
const outByCanvas = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
/** 給 cv 用、長度剛好 n 的緩衝（同一個 canvas 尺寸沒變就是上次那一片；其他要畫整片到 canvas 的地方可共用）。 */
export function rgbaBufferFor(cv: HTMLCanvasElement, n: number): Uint8ClampedArray {
  let buf = outByCanvas.get(cv);
  if (!buf || buf.length !== n) {
    buf = new Uint8ClampedArray(n);
    outByCanvas.set(cv, buf);
  }
  return buf;
}

/** 把一個切面畫到 canvas：材質顏色、隱藏材質淡灰、選取混藍、差異（只有差異模式傳）描藍邊＋拿掉的紅；patch＝即時預覽蓋上去。 */
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
  // putImageData 當場拷貝進 canvas，緩衝之後可以直接重用
  const { data } = sliceRGBA(vol, axis, at, rgb, hidden, selMask, diff, patch, rgbaBufferFor(cv, W * H * 4));
  cv.getContext('2d')!.putImageData(new ImageData(data, W, H), 0, 0);
}
