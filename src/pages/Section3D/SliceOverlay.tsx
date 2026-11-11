// 切面上疊的線（小切面與放大的切面共用，plan v18 §3.2）：範圍的藍色虛線框、十字線。
import type { Axis, Vec3 } from '../../volume/volume';
import { type Scope, axisLen, planeAxes } from '../../volume/scope';

const FRAME = { fill: 'var(--c-primary)', fillOpacity: 0.08, stroke: 'var(--c-primary)', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' } as const;

export function SliceOverlay({
  vol,
  axis,
  W,
  H,
  cursor,
  scope,
}: {
  vol: { X: number; Y: number; Z: number };
  axis: Axis;
  W: number;
  H: number;
  cursor: Vec3;
  /** 範圍；沿別的軸時在切面上畫藍色虛線框（null = 不畫）。 */
  scope: Scope | null;
}) {
  const [ua, va] = planeAxes(axis);
  const cu = cursor[ua];
  const cv = cursor[va];
  const partial = !!scope && scope.axis !== axis && (scope.lo > 0 || scope.hi < axisLen(vol, scope.axis) - 1);
  const z0 = scope?.lo ?? 0;
  const z1 = (scope?.hi ?? 0) + 1;
  // scope 的軸在切面上是橫的（u）還是直的（v）
  const vertical = !!scope && (axis === 'y' ? scope.axis === 'z' : axis === 'z' ? scope.axis === 'y' : scope.axis === 'y');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {partial && (vertical ? <rect x={0} y={z0} width={W} height={z1 - z0} {...FRAME} /> : <rect x={z0} y={0} width={z1 - z0} height={H} {...FRAME} />)}
      <line x1={cu + 0.5} y1={0} x2={cu + 0.5} y2={H} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={0} y1={cv + 0.5} x2={W} y2={cv + 0.5} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
