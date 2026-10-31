// 右欄數值輸入、浮動工具列、方向鍵和拖拉產生完全相同的 Op（plan v7 §5.5、v8 §7.8）：
// 都從同一份切面幾何層（SliceModel）取環、用同一個 gestureToOp（多選且「對應」開著時用 mirroredOp），
// 放開／Enter 時同一個 commitGesture：先更新幾何（不等 Worker），再送 Op。
import type { Axis, Labeled, Volume } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { planeAxes, to3D } from '../../volume/scope';
import type { Ring, XY } from '../../slice/trace';
import { type GestureCtx, type Handle, dragDisp, gestureToOp, hitTest } from '../../slice/gestures';
import { type Shape, mirroredOp } from '../../slice/mirror';
import { type ModelStore, type SliceModel, applyDisp, exactOp, locate, ringsOf, translateKeys } from '../../slice/model';
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
export type SliceCtx = ReturnType<typeof sliceContext> & { model?: SliceModel };

/** 編輯器裡和幾何層有關的部分（editor.ts 的 useEditor 回傳值有這些）。 */
export interface ModelHost {
  L: Labeled;
  vol: Volume;
  models: ModelStore;
  version: number;
  stepSeq: number;
  commit: (op: Op) => void;
}

/** 從幾何層取這一片的手勢環境（右欄、浮動工具列用；主切面自己取同一份）。 */
export function modelContext(ed: ModelHost, axis: Axis, at: number, keys: string[], opts: GestureOpts): SliceCtx {
  const { model } = ed.models.get(ed.L, ed.vol, axis, at, keys, ed.version, ed.stepSeq);
  return { ...sliceContext(ed.L, ed.vol, axis, at, keys, opts, ringsOf(model, keys)), model };
}

/** 手勢 → Op：多選且 mirror 開著時對應到其他結構；missed＝配不到的 key。幾何改過的結構參考片用絕對格子。 */
export function opOfGesture(ctx: SliceCtx, h: Handle, delta: XY, shift: boolean, mirror: boolean): { op: Op | null; missed: string[] } {
  const r = mirror && ctx.rings.size > 1 && h.kind !== 'region' ? mirroredOp(ctx.rings, h, delta, shift, ctx.g, ctx.shapes) : { op: gestureToOp(ctx.rings, h, delta, shift, ctx.g), missed: [] };
  return { ...r, op: r.op ? exactOp(ctx.model, r.op) : null };
}

/**
 * 放開＝一步（§7.3）：幾何層立刻用整數位移更新（先存這個版本的快照、標記等 Worker），再送 Op。
 * 對應到的其他結構不在這裡移動：Worker 回來驗證時對不上就以 voxel 為準重描（節點 id 保留）。
 */
export function commitGesture(ed: ModelHost, ctx: SliceCtx, h: Handle, delta: XY, shift: boolean, op: Op | null) {
  if (!op) return;
  const m = ctx.model;
  if (m) {
    ed.models.begin(m, ed.version, ed.stepSeq);
    if (h.kind === 'region') translateKeys(m, op.keys, [Math.round(delta[0]), Math.round(delta[1])]);
    else {
      const r = ctx.rings.get(h.key)?.[h.ring];
      if (r) applyDisp(m, h.key, h.ring, dragDisp(r, h, delta, shift));
    }
  }
  ed.commit(op);
}

/** 選到的把手在目前的幾何上：先用頂點 id 找（幾何沒重描就一定找得到），找不到才用記下的位置。 */
export function resolveHandle(ctx: SliceCtx, h: PickedHandle): Handle | null {
  if (h.vid && ctx.model) {
    const at = locate(ctx.model, h.vid);
    if (at && ctx.rings.get(at.key)?.[at.ring]) return { kind: h.kind, ...at };
  }
  return hitTest(ctx.rings, h.p, 8 / 3, ctx.inside, h.kind);
}
