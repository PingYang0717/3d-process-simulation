// 操作（Op）與重播：純函式，主執行緒與 Worker 共用，可單獨測試。
import {
  type Backfill,
  type BrushShape,
  type Labeled,
  type Material,
  type Vec3,
  type Volume,
  type ZRange,
  directionName,
  growMask,
  levelMask,
  localMask,
  maskOf,
  relabel,
  setMaskMaterial,
  translateMask,
} from './volume';

/** 筆刷：只推離 center 半徑 radius 內的列（shape 省略 = 圓；radius = Infinity 以 null 存，表示整面）。 */
export interface Local {
  center: Vec3;
  radius: number | null;
  shape?: BrushShape;
}
export const radiusOf = (l: Local) => (l.radius === null ? Infinity : l.radius);

export type Op =
  | { kind: 'push'; keys: string[]; zRange: ZRange; dir: Vec3; n: number; follow: boolean; backfill: Backfill; local?: Local }
  | { kind: 'translate'; keys: string[]; zRange: ZRange; d: Vec3; backfill: Backfill }
  | { kind: 'material'; keys: string[]; zRange: ZRange; m: number }
  /** 補平：筆刷範圍內每一列的最外側面補到／削到座標 to（沿 dir 軸）。 */
  | { kind: 'level'; keys: string[]; zRange: ZRange; dir: Vec3; to: number; local: Local; backfill: Backfill };

export interface EditState {
  vol: Volume;
  L: Labeled;
}

export interface OpContext {
  orig: Volume;
  matName: (id: number) => string;
  newKey: () => string;
}

export const matNameOf = (materials: Material[]) => (id: number) =>
  materials.find((m) => m.id === id)?.name ?? `材質 ${id}`;

export function applyOp(s: EditState, op: Op, ctx: OpContext): EditState {
  let mask = maskOf(s.L, new Set(op.keys));
  if (!mask) return s;
  let vol: Volume;
  let shift: Vec3 = [0, 0, 0];
  if (op.kind === 'push') {
    if (op.local) mask = localMask(s.vol, mask, op.dir, op.local.center, radiusOf(op.local), op.local.shape ?? 'round');
    vol = growMask(s.vol, ctx.orig, mask, op.zRange, op.dir, op.n, op.backfill, op.follow);
  } else if (op.kind === 'level') {
    const l = op.local;
    vol = levelMask(s.vol, ctx.orig, mask, op.zRange, op.dir, l.center, radiusOf(l), l.shape ?? 'round', op.to, op.backfill);
  } else if (op.kind === 'translate') {
    vol = translateMask(s.vol, ctx.orig, mask, op.zRange, op.d, op.backfill);
    shift = op.d;
  } else vol = setMaskMaterial(s.vol, mask, op.zRange, op.m);
  return { vol, L: relabel(s.vol, s.L, mask, shift, vol, ctx.matName, ctx.newKey) };
}

/** 從某個狀態（通常是原始）重播一串操作。 */
export const replay = (base: EditState, ops: Op[], ctx: OpContext) => ops.reduce((s, op) => applyOp(s, op, ctx), base);

/** 操作的白話描述，例如「Poly-Si ×3 往上長 2 vx（1.0 nm）」。 */
export function opText(op: Op, L: Labeled, Z: number, nmPerVoxel: number, matName: (id: number) => string) {
  const comps = op.keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  const mats = new Set(comps.map((c) => c.mat));
  const who =
    comps.length === 1
      ? comps[0].label
      : mats.size === 1 && comps.length
        ? `${matName([...mats][0])} ×${comps.length}`
        : `${op.keys.length} 個結構`;
  const part = op.zRange[0] === 0 && op.zRange[1] === Z - 1 ? '' : `（z ${op.zRange[0]}～${op.zRange[1]}）`;
  const brush = (l: Local) => (l.radius === null ? '整面' : `筆刷 ${l.shape === 'square' ? '方' : '圓'} r${l.radius}`);
  if (op.kind === 'push') {
    const n = Math.abs(op.n);
    return `${who}${part}${op.local ? `（${brush(op.local)}）` : ''} ${directionName(op.dir)}${op.n > 0 ? '長' : '縮'} ${n} vx（${(n * nmPerVoxel).toFixed(1)} nm）`;
  }
  if (op.kind === 'level') {
    const axis = op.dir[0] ? 'x' : op.dir[1] ? 'y' : 'z';
    return `${who}${part}（${brush(op.local)}）補平到 ${axis} = ${op.to}（${(op.to * nmPerVoxel).toFixed(1)} nm）`;
  }
  if (op.kind === 'translate') {
    const parts = ['x', 'y', 'z']
      .map((a, i) => (op.d[i] ? `${a}${op.d[i] > 0 ? '+' : ''}${op.d[i]}` : ''))
      .filter(Boolean)
      .join(' ');
    return `${who}${part} 移動 ${parts}`;
  }
  return `${who}${part} 換成 ${matName(op.m)}`;
}

export type SweepKind = { kind: 'push'; dir: Vec3 } | { kind: 'translate'; axis: 0 | 1 | 2 };

/** 掃描：同一個操作、不同數值，每個數值一個 op。 */
export function sweepOps(
  kind: SweepKind,
  keys: string[],
  zRange: ZRange,
  voxels: number[],
  follow: boolean,
  backfill: Backfill,
): Op[] {
  return voxels.map((n) =>
    kind.kind === 'push'
      ? { kind: 'push', keys, zRange, dir: kind.dir, n, follow, backfill }
      : {
          kind: 'translate',
          keys,
          zRange,
          d: [kind.axis === 0 ? n : 0, kind.axis === 1 ? n : 0, kind.axis === 2 ? n : 0],
          backfill,
        },
  );
}
