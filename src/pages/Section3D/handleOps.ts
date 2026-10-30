// 右欄數值輸入、浮動工具列、方向鍵和拖拉產生完全相同的 Op（plan v7 §5.5）：
// 都從同一片重新描輪廓、用同一個 gestureToOp（多選且「對應」開著時用 mirroredOp）。
import type { Axis, Labeled, Volume } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { planeAxes, to3D } from '../../volume/scope';
import type { Ring, XY } from '../../slice/trace';
import { type GestureCtx, type Handle, gestureToOp, hitTest } from '../../slice/gestures';
import { type Shape, mirroredOp } from '../../slice/mirror';
import { type GestureOpts, type PickedHandle, sliceRings } from './SliceEditor';

/** 一片上的手勢環境：環、inside、外框、形狀（對應用）。 */
export function sliceContext(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[], opts: GestureOpts, rings?: Map<string, Ring[]>) {
  const rs = rings ?? sliceRings(L, vol, axis, at, keys);
  const [ua, va] = planeAxes(axis);
  const dims = [vol.X, vol.Y, vol.Z];
  const idxOf = new Map(L.comps.map((c, i) => [c.key, i]));
  const inside = (key: string, u: number, v: number) => {
    const k = idxOf.get(key);
    if (k === undefined || u < 0 || v < 0 || u >= dims[ua] || v >= dims[va]) return false;
    const p = to3D(axis, u, v, at);
    return L.labels[(p[2] * vol.Y + p[1]) * vol.X + p[0]] === k;
  };
  const shapes = new Map<string, Shape>();
  for (const [key, list] of rs) {
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (const r of list)
      if (!r.hole)
        for (const [u, v] of r.pts) {
          u0 = Math.min(u0, u);
          v0 = Math.min(v0, v);
          u1 = Math.max(u1, u - 1);
          v1 = Math.max(v1, v - 1);
        }
    if (u0 > u1) continue;
    let area = 0;
    for (let v = v0; v <= v1; v++) for (let u = u0; u <= u1; u++) if (inside(key, u, v)) area++;
    shapes.set(key, { box: { u0, v0, u1, v1 }, mat: L.comps[idxOf.get(key)!].mat, area });
  }
  const g: GestureCtx = {
    axis,
    at,
    scope: opts.scope,
    follow: opts.follow,
    backfill: opts.backfill,
    nm: opts.nm,
    selKeys: keys,
    inside,
    sliceBox: (key) => shapes.get(key)?.box ?? null,
  };
  return { rings: rs, inside, shapes, g };
}

/** 手勢 → Op：多選且 mirror 開著時對應到其他結構；missed＝配不到的 key。 */
export function opOfGesture(
  ctx: ReturnType<typeof sliceContext>,
  h: Handle,
  delta: XY,
  shift: boolean,
  mirror: boolean,
): { op: Op | null; missed: string[] } {
  if (mirror && ctx.rings.size > 1 && h.kind !== 'region') return mirroredOp(ctx.rings, h, delta, shift, ctx.g, ctx.shapes);
  return { op: gestureToOp(ctx.rings, h, delta, shift, ctx.g), missed: [] };
}

/** 選到的把手在目前的環上（重描之後索引可能變了，用記下的位置重新找）。 */
export function resolveHandle(ctx: ReturnType<typeof sliceContext>, h: PickedHandle): Handle | null {
  return hitTest(ctx.rings, h.p, 8 / 3, ctx.inside, h.kind);
}
