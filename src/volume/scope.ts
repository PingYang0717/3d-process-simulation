// Scope：「只有這個範圍裡的體素可以被改」＝一個軸＋起止索引（含端點）。取代舊的 zRange（只能沿 z）。
import type { Axis, BBox, Vec3 } from './volume';

export interface Scope {
  axis: Axis;
  lo: number;
  hi: number;
}

type Dims = { X: number; Y: number; Z: number };

export const AXES: Axis[] = ['x', 'y', 'z'];
export const axisIndex = (a: Axis): 0 | 1 | 2 => (a === 'x' ? 0 : a === 'y' ? 1 : 2);
export const axisLen = (v: Dims, a: Axis) => (a === 'x' ? v.X : a === 'y' ? v.Y : v.Z);

/** 整個陣列（沿 axis 的全部索引）。 */
export const fullScope = (v: Dims, axis: Axis = 'z'): Scope => ({ axis, lo: 0, hi: axisLen(v, axis) - 1 });
export const isFullScope = (s: Scope, v: Dims) => s.lo <= 0 && s.hi >= axisLen(v, s.axis) - 1;

/** 夾到陣列範圍內、lo ≤ hi。 */
export const clampScope = (s: Scope, v: Dims): Scope => {
  const max = axisLen(v, s.axis) - 1;
  const a = Math.max(0, Math.min(max, Math.round(Math.min(s.lo, s.hi))));
  const b = Math.max(0, Math.min(max, Math.round(Math.max(s.lo, s.hi))));
  return { axis: s.axis, lo: a, hi: b };
};

export const inScope = (s: Scope, c: Vec3) => {
  const t = c[axisIndex(s.axis)];
  return t >= s.lo && t <= s.hi;
};

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

/** 舊 Op 的 zRange: [a, b] → scope。 */
export const fromZRange = (r: [number, number]): Scope => ({ axis: 'z', lo: r[0], hi: r[1] });

/** 「z 40～80」這種範圍詞。 */
export const scopeText = (s: Scope) => (s.lo === s.hi ? `${s.axis} = ${s.lo}` : `${s.axis} ${s.lo}～${s.hi}`);
