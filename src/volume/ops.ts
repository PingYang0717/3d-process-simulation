// 操作（Op）與重播：純函式，主執行緒與 Worker 共用，可單獨測試。
// plan v17：只剩推拉一面（push）、整塊平移（translate）、換材質（material）；UI 產生的推拉與平移一律帶 policy 'adjacent'。
import { newReport } from './kernel';
import { type Backfill, type Labeled, type Material, type Vec3, type Volume, adjacentMasks, growMask, maskOf, relabel, setMaskMaterial, translateMask } from './volume';
import type { Scope } from './scope';

/** 推面碰到厚的別的材質：block＝擋住、overwrite＝蓋過去（省略＝overwrite）。plan v17 的 UI 不產生這兩種。 */
export type Policy = 'block' | 'overwrite';
/**
 * plan v17 §5.4：相鄰材質規則（一步只改緊貼那一層的厚度、至少留 1 格、整面一起擋）。
 * liners＝這一步當時的薄層材質編號（留作紀錄，重算時不依賴外部狀態）。
 */
export type Adjacent = { policy: 'adjacent'; liners: number[] };

export type PushOp = { kind: 'push'; keys: string[]; scope: Scope; dir: Vec3; n: number; follow: boolean; backfill: Backfill; policy?: Policy };
/** follow：外面的薄襯層（殼）一起搬；省略＝不帶。 */
export type TranslateOp = { kind: 'translate'; keys: string[]; scope: Scope; d: Vec3; backfill: Backfill; follow?: boolean };
/** 相鄰材質規則的推拉一面（plan v17）：每個選到的結構各推自己的那一面。 */
export type AdjPushOp = Omit<PushOp, 'policy'> & Adjacent;
/** 相鄰材質規則的整塊平移：d 只能沿單一軸，內部一格一格做。 */
export type AdjTranslateOp = Omit<TranslateOp, 'follow'> & { follow: boolean } & Adjacent;
export type MaterialOp = { kind: 'material'; keys: string[]; scope: Scope; m: number };

export type Op = PushOp | TranslateOp | AdjPushOp | AdjTranslateOp | MaterialOp;

export const isAdjacent = (op: Op): op is AdjPushOp | AdjTranslateOp => (op.kind === 'push' || op.kind === 'translate') && 'policy' in op && op.policy === 'adjacent';

/** 'adjacent' 的方向與格數：push＝面的法線與 n（帶正負號）；translate＝單位方向與格數。 */
export function adjacentDir(op: AdjPushOp | AdjTranslateOp): { dir: Vec3; n: number } {
  if (op.kind === 'push') return { dir: op.dir, n: op.n };
  const a = op.d[0] ? 0 : op.d[1] ? 1 : 2;
  const v = op.d[a];
  const dir: Vec3 = [0, 0, 0];
  dir[a] = Math.sign(v) || 1;
  return { dir, n: Math.abs(v) };
}

export interface EditState {
  vol: Volume;
  L: Labeled;
  /**
   * 版本號：同一個號碼＝同一份體素與 labels（Worker 常駐狀態、網格、diff 的快取 key）。
   * 主執行緒的狀態都有；純函式（applyOp／replay）不看它，結果也不帶。
   */
  version?: number;
  /** 這份內容在哪一本帳簿：'base'＝原始（省略同義），'cur'＝目前。 */
  owner?: string;
}

export interface OpContext {
  orig: Volume;
  matName: (id: number) => string;
  newKey: () => string;
}

export const matNameOf = (materials: Material[]) => (id: number) => materials.find((m) => m.id === id)?.name ?? `材質 ${id}`;

/** 整個陣列套一步（對照版本；正式路徑是 apply.ts 只在外框裡算）。 */
export function applyOp(s: EditState, op: Op, ctx: OpContext): EditState {
  const mask = maskOf(s.L, new Set(op.keys));
  if (!mask) return s;
  let vol: Volume;
  let shift: Vec3 = [0, 0, 0];
  if (isAdjacent(op)) {
    const { dir, n } = adjacentDir(op);
    const masks = [...new Set(op.keys)].map((k) => maskOf(s.L, new Set([k]))).filter((m): m is Uint8Array => !!m);
    const r = newReport();
    vol = adjacentMasks(s.vol, masks, op.kind, dir, n, op.follow, op.liners, r);
    if (op.kind === 'translate') shift = dir.map((v) => v * (r.done ?? 0)) as Vec3;
    return { vol, L: relabel(s.vol, s.L, mask, shift, vol, ctx.matName, ctx.newKey) };
  }
  if (op.kind === 'push') vol = growMask(s.vol, ctx.orig, mask, op.scope, op.dir, op.n, op.backfill, op.follow, undefined, op.policy ?? 'overwrite');
  else if (op.kind === 'translate') {
    vol = translateMask(s.vol, ctx.orig, mask, op.scope, op.d, op.backfill, !!op.follow);
    shift = op.d;
  } else vol = setMaskMaterial(s.vol, mask, op.scope, op.m);
  return { vol, L: relabel(s.vol, s.L, mask, shift, vol, ctx.matName, ctx.newKey) };
}

/** 從某個狀態（通常是原始）重播一串操作。 */
export const replay = (base: EditState, ops: Op[], ctx: OpContext) => ops.reduce((s, op) => applyOp(s, op, ctx), base);
