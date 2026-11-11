// Scope：「只有這個範圍裡的體素可以被改」＝一個軸＋起止索引（含端點）。plan v17 的 UI 一律是整個陣列（fullScope）。
import type { Axis, BBox } from './volume';

export interface Scope {
  axis: Axis;
  lo: number;
  hi: number;
}

type Dims = { X: number; Y: number; Z: number };

export const axisIndex = (a: Axis): 0 | 1 | 2 => (a === 'x' ? 0 : a === 'y' ? 1 : 2);
export const axisLen = (v: Dims, a: Axis) => (a === 'x' ? v.X : a === 'y' ? v.Y : v.Z);

/** 整個陣列（沿 axis 的全部索引）。 */
export const fullScope = (v: Dims, axis: Axis = 'z'): Scope => ({ axis, lo: 0, hi: axisLen(v, axis) - 1 });

/** 陣列 ∩ scope 的外框（含端點）；沒有交集回傳 null。 */
export function scopeBox(v: Dims, s: Scope): BBox | null {
  const b: BBox = { x0: 0, x1: v.X - 1, y0: 0, y1: v.Y - 1, z0: 0, z1: v.Z - 1 };
  const lo = Math.max(0, s.lo);
  const hi = Math.min(axisLen(v, s.axis) - 1, s.hi);
  if (lo > hi) return null;
  if (s.axis === 'x') [b.x0, b.x1] = [lo, hi];
  else if (s.axis === 'y') [b.y0, b.y1] = [lo, hi];
  else [b.z0, b.z1] = [lo, hi];
  return b;
}

/** 外框沿 axis 的起止。 */
export const boxRange = (b: BBox, a: Axis): [number, number] => (a === 'x' ? [b.x0, b.x1] : a === 'y' ? [b.y0, b.y1] : [b.z0, b.z1]);

/** 值相同（plan v15 B1：scope 以值比較，身分不變）。 */
export const sameScope = (a: Scope | null, b: Scope | null) => a === b || (!!a && !!b && a.axis === b.axis && a.lo === b.lo && a.hi === b.hi);

/** 外框 ∩ scope；沒有交集回傳 null。 */
export function clipBox(b: BBox, s: Scope): BBox | null {
  const [l, h] = boxRange(b, s.axis);
  const lo = Math.max(l, s.lo);
  const hi = Math.min(h, s.hi);
  if (lo > hi) return null;
  if (s.axis === 'x') return { ...b, x0: lo, x1: hi };
  if (s.axis === 'y') return { ...b, y0: lo, y1: hi };
  return { ...b, z0: lo, z1: hi };
}

/** 切面上的 (u, v) 是哪兩個體素軸：XY 正面 u=x v=y；XZ 上視 u=x v=z；YZ 側面 u=z v=y。 */
export const planeAxes = (axis: Axis): [0 | 1 | 2, 0 | 1 | 2] => (axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1]);
