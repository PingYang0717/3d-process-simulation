// 操作（Op）與重播：純函式，主執行緒與 Worker 共用，可單獨測試。
import {
  type Backfill,
  type BrushShape,
  type Labeled,
  type Material,
  type Vec3,
  type Volume,
  directionName,
  growMask,
  levelMask,
  localMask,
  maskOf,
  relabel,
  setMaskMaterial,
  translateMask,
} from './volume';
import { type Scope, fromZRange, isFullScope, scopeText } from './scope';
import { type ProfileOp, applyProfileMask } from './profile';

export type { ProfileOp } from './profile';

/** 筆刷：只推離 center 半徑 radius 內的列（shape 省略 = 圓；radius = Infinity 以 null 存，表示整面）。 */
export interface Local {
  center: Vec3;
  radius: number | null;
  shape?: BrushShape;
}
export const radiusOf = (l: Local) => (l.radius === null ? Infinity : l.radius);

/** scope：只有這個範圍裡的體素可以被改（推面時新格子落在 scope 外就不寫）。 */
export type Op =
  | { kind: 'push'; keys: string[]; scope: Scope; dir: Vec3; n: number; follow: boolean; backfill: Backfill; local?: Local }
  /** follow：外面的薄襯層（殼）一起搬；省略＝不帶（舊 Op）。 */
  | { kind: 'translate'; keys: string[]; scope: Scope; d: Vec3; backfill: Backfill; follow?: boolean }
  | { kind: 'material'; keys: string[]; scope: Scope; m: number }
  /** 補平：筆刷範圍內每一列的最外側面補到／削到座標 to（沿 dir 軸）；follow = 襯層跟推（同 push）。 */
  | { kind: 'level'; keys: string[]; scope: Scope; dir: Vec3; to: number; local: Local; backfill: Backfill; follow?: boolean }
  /** 2D 剖面編輯（拖節點、斜邊、圓弧）：每個結構一份要加、要拿的格子，套用到 scope 裡的每一片（§7.3）。 */
  | ProfileOp;

/** 舊格式（v6／v11 的 manifest、重播紀錄）：用 zRange: [a, b] 而不是 scope。 */
export type LegacyOp = Exclude<Op, ProfileOp> extends infer O ? (O extends { scope: Scope } ? Omit<O, 'scope'> & { zRange: [number, number] } : never) : never;

/** 讀進來的 Op 一律先過這裡：zRange → scope（axis z）；已是新格式原樣回傳。 */
export function upgradeOp(op: Op | LegacyOp): Op {
  if ('scope' in op) return op;
  const { zRange, ...rest } = op;
  return { ...rest, scope: fromZRange(zRange) } as Op;
}

export interface EditState {
  vol: Volume;
  L: Labeled;
  /**
   * 版本號：同一個號碼＝同一份體素與 labels（Worker 常駐狀態、網格、diff、計數的快取 key）。
   * 主執行緒的狀態都有；純函式（applyOp／replay）不看它，結果也不帶。
   */
  version?: number;
  /** 這份內容在哪一本帳簿（plan v9 §4.1）：'base'＝原始（省略同義），否則是 split id。 */
  owner?: string;
}

export interface OpContext {
  orig: Volume;
  matName: (id: number) => string;
  newKey: () => string;
}

export const matNameOf = (materials: Material[]) => (id: number) =>
  materials.find((m) => m.id === id)?.name ?? `材質 ${id}`;

export function applyOp(s: EditState, input: Op | LegacyOp, ctx: OpContext): EditState {
  const op = upgradeOp(input);
  let mask = maskOf(s.L, new Set(op.keys));
  if (!mask) return s;
  if (op.kind === 'profile') {
    const masks = new Map(op.keys.map((k) => [k, maskOf(s.L, new Set([k]))!] as const).filter(([, m]) => !!m));
    const vol = applyProfileMask(s.vol, ctx.orig, masks, op, [0, 0, 0]);
    return { vol, L: relabel(s.vol, s.L, mask, [0, 0, 0], vol, ctx.matName, ctx.newKey) };
  }
  let vol: Volume;
  let shift: Vec3 = [0, 0, 0];
  if (op.kind === 'push') {
    if (op.local) mask = localMask(s.vol, mask, op.dir, op.local.center, radiusOf(op.local), op.local.shape ?? 'round');
    vol = growMask(s.vol, ctx.orig, mask, op.scope, op.dir, op.n, op.backfill, op.follow);
  } else if (op.kind === 'level') {
    const l = op.local;
    vol = levelMask(s.vol, ctx.orig, mask, op.scope, op.dir, l.center, radiusOf(l), l.shape ?? 'round', op.to, op.backfill, !!op.follow);
  } else if (op.kind === 'translate') {
    vol = translateMask(s.vol, ctx.orig, mask, op.scope, op.d, op.backfill, !!op.follow);
    shift = op.d;
  } else vol = setMaskMaterial(s.vol, mask, op.scope, op.m);
  return { vol, L: relabel(s.vol, s.L, mask, shift, vol, ctx.matName, ctx.newKey) };
}

/** 從某個狀態（通常是原始）重播一串操作。 */
export const replay = (base: EditState, ops: (Op | LegacyOp)[], ctx: OpContext) => ops.reduce((s, op) => applyOp(s, op, ctx), base);

/** 操作的白話描述，例如「Poly-Si ×3 往上長 2 vx（1.0 nm）」。 */
export function opText(input: Op | LegacyOp, L: Labeled, dims: { X: number; Y: number; Z: number }, nmPerVoxel: number, matName: (id: number) => string) {
  const op = upgradeOp(input);
  const comps = op.keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  const mats = new Set(comps.map((c) => c.mat));
  const who =
    comps.length === 1
      ? comps[0].label
      : mats.size === 1 && comps.length
        ? `${matName([...mats][0])} ×${comps.length}`
        : `${op.keys.length} 個結構`;
  const part = isFullScope(op.scope, dims) ? '' : `（${scopeText(op.scope)}）`;
  if (op.kind === 'profile') {
    const plane = op.scope.axis === 'z' ? 'XY' : op.scope.axis === 'y' ? 'XZ' : 'YZ';
    return `${who}（${plane}，${scopeText(op.scope)}）${op.text ?? '剖面調整'}`;
  }
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
  scope: Scope,
  voxels: number[],
  follow: boolean,
  backfill: Backfill,
): Op[] {
  return voxels.map((n) =>
    kind.kind === 'push'
      ? { kind: 'push', keys, scope, dir: kind.dir, n, follow, backfill }
      : {
          kind: 'translate',
          keys,
          scope,
          d: [kind.axis === 0 ? n : 0, kind.axis === 1 ? n : 0, kind.axis === 2 ? n : 0],
          backfill,
        },
  );
}
