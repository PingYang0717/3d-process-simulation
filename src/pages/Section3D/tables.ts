// 送 Worker 的畫法表（主執行緒 index.tsx 與 views.tsx 共用；不 import three.js）。
import { type Material, hexToRgb } from '../../volume/volume';

/** 長度 768，每個材質的 RGB（0～1）。 */
export const palette = (materials: Material[]) => {
  const out = new Float32Array(768);
  materials.forEach((m) => {
    const [r, g, b] = hexToRgb(m.color);
    out.set([r / 255, g / 255, b / 255], m.id * 3);
  });
  return out;
};
/** 長度 256，1 = 不畫這個材質。 */
export const hiddenTable = (hidden: Set<number>) => {
  const out = new Uint8Array(256);
  hidden.forEach((m) => (out[m] = 1));
  return out;
};
