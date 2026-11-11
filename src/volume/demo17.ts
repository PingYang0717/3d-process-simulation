// plan v17 的小範例：和 prototype（docs/proto-v17-simple-version.html）同一個 48×38×40 模型，
// 只是 y 上下顛倒（這個專案 y 索引變小＝往上）。kernel17.test.ts 用它逐例檢查相鄰材質規則。
// 材質編號和 MATERIALS 相同：1 Si (p)、2 STI SiO₂、3 Si fin、4 HfO₂、5 TiN、6 Poly-Si、7 SiN。
import type { Volume } from './volume';

export const D17 = { X: 48, Y: 38, Z: 40 };
/** 兩根 fin 的 x 範圍、兩根閘極的 z 範圍（含端點）。 */
export const D17_FINS: [number, number][] = [
  [11, 16],
  [31, 36],
];
export const D17_GATES: [number, number][] = [
  [8, 15],
  [24, 31],
];

/** prototype 的 y（往上變大）→ 這裡的 y。 */
export const flipY = (y: number) => D17.Y - 1 - y;

export function demo17Volume(): Volume {
  const { X, Y, Z } = D17;
  const data = new Uint8Array(X * Y * Z);
  // y0, y1 是 prototype 的座標（往上變大）
  const fill = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, mat: number, keep?: (m: number) => boolean) => {
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = (z * Y + flipY(y)) * X + x;
          if (keep && !keep(data[i])) continue;
          data[i] = mat;
        }
  };
  fill(0, X - 1, 0, 5, 0, Z - 1, 1);
  fill(0, X - 1, 6, 10, 0, Z - 1, 2);
  for (const [a, b] of D17_FINS) fill(a, b, 6, 20, 0, Z - 1, 3);
  const notFin = (m: number) => m !== 3;
  for (const [z0, z1] of D17_GATES) {
    fill(4, 43, 11, 28, z0, z1, 6, (m) => m === 0);
    for (const [a, b] of D17_FINS) {
      fill(a - 2, b + 2, 11, 22, z0, z1, 5, notFin);
      fill(a - 1, b + 1, 11, 21, z0, z1, 4, notFin);
    }
    fill(4, 43, 29, 31, z0, z1, 7);
  }
  return { X, Y, Z, data };
}
