// 拖拉中超過即時預覽上限時的 3D 顯示（plan v8 §8.3）：把 profile 要加／拿的格子沿範圍擠出成小方塊（綠／紅、半透明）。
// 不算 kernel，只是把 2D 的格子沿軸複製，所以被擋住的格子也會畫出來（概略）；放開後正式結果覆蓋。
import type { Volume } from '../../volume/volume';
import type { BBox } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { decodeRle } from '../../volume/rle';
import { to3D } from '../../volume/scope';

export interface CellCloud {
  /** 體素座標 xyz 連續存放。 */
  add: Int32Array;
  remove: Int32Array;
}

/** 上限：超過就不畫（只剩切面的預覽）。 */
export const CLOUD_MAX = 200_000;

export function cellCloud(op: Op, vol: Volume, max = CLOUD_MAX): CellCloud | null {
  if (op.kind !== 'profile') return null;
  const lo = Math.max(0, op.scope.lo);
  const hi = Math.min(op.scope.axis === 'x' ? vol.X - 1 : op.scope.axis === 'y' ? vol.Y - 1 : vol.Z - 1, op.scope.hi);
  const n = hi - lo + 1;
  const adds = Object.values(op.perKey).flatMap((p) => decodeRle(p.add));
  const rems = Object.values(op.perKey).flatMap((p) => decodeRle(p.remove));
  if (n <= 0 || (adds.length + rems.length) * n > max) return null;
  const extrude = (cells: { u: number; v: number }[]) => {
    const out = new Int32Array(cells.length * n * 3);
    let k = 0;
    for (let t = lo; t <= hi; t++)
      for (const c of cells) {
        const p = to3D(op.scope.axis, c.u, c.v, t);
        out[k++] = p[0];
        out[k++] = p[1];
        out[k++] = p[2];
      }
    return out;
  };
  return { add: extrude(adds), remove: extrude(rems) };
}

/** 裁切範圍裡的 index → 整個陣列的 index（被擋住的格子）。 */
export function globalIndex(box: BBox, vol: Volume, idx: number[]): number[] {
  const W = box.x1 - box.x0 + 1;
  const H = box.y1 - box.y0 + 1;
  return idx.map((i) => {
    const x = i % W;
    const y = ((i - x) / W) % H;
    const z = (i - x - y * W) / (W * H);
    return ((z + box.z0) * vol.Y + y + box.y0) * vol.X + x + box.x0;
  });
}
