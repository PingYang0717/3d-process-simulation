// 操作（Op）與重播：純函式，主執行緒與 Worker 共用，可單獨測試。
import {
  type BBox,
  type Backfill,
  type BrushShape,
  type PushStep,
  type Labeled,
  type Material,
  type Vec3,
  type Volume,
  directionName,
  dilateMask,
  growMask,
  levelMask,
  localMask,
  maskOf,
  pushSeq,
  relabel,
  setMaskMaterial,
  setRegionMaterial,
  unionBBox,
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
/** 推面碰到厚的別的材質：block＝擋住（plan v11 §4.10 新預設）、overwrite＝蓋過去（v10 以前；省略＝overwrite，舊 Op 重播不變）。 */
export type Policy = 'block' | 'overwrite';

/** level 的相對參照（plan v11 §4.9）：to = 參照結構外框在 dir 軸的 lo|hi + offset；apply 只看 to。 */
export interface LevelRef {
  key: string;
  side: 'lo' | 'hi';
  offset: number;
}

export type CdOp = { kind: 'cd'; keys: string[]; scope: Scope; axis: 0 | 1 | 2; delta: number; anchor: 'center' | 'lo' | 'hi'; follow: boolean; backfill: Backfill; policy?: Policy };
export type DilateOp = { kind: 'dilate'; keys: string[]; scope: Scope; n: number; metric: 'euclid'; follow: boolean; backfill: Backfill };
export type DefectShape = 'slab' | 'sphere' | 'box';
export type DefectOp = {
  kind: 'defect';
  keys: string[];
  scope: Scope;
  shape: DefectShape;
  /** 相對 host 外框的 0～1（§9 D5）。 */
  center: Vec3;
  /** 格數。 */
  size: Vec3;
  mat: number;
  /** 產生時算好的絕對外框（含端點），apply 只看它（重播不變）。 */
  abs: BBox;
};
export type TaperOp = {
  kind: 'taper';
  keys: string[];
  scope: Scope;
  /** 哪個側壁（往外的法線）。 */
  face: Vec3;
  /** 高度軸。 */
  along: 0 | 1 | 2;
  /** along 軸 lo 端（y：頂）與 hi 端（y：底）的位移，格，正＝往外。 */
  top: number;
  bottom: number;
  /** 對面也做（鏡像）。 */
  both?: boolean;
  follow: boolean;
  backfill: Backfill;
  policy?: Policy;
};

export type Op =
  | { kind: 'push'; keys: string[]; scope: Scope; dir: Vec3; n: number; follow: boolean; backfill: Backfill; local?: Local; policy?: Policy }
  /** follow：外面的薄襯層（殼）一起搬；省略＝不帶（舊 Op）。 */
  | { kind: 'translate'; keys: string[]; scope: Scope; d: Vec3; backfill: Backfill; follow?: boolean }
  | { kind: 'material'; keys: string[]; scope: Scope; m: number }
  /** 補平：筆刷範圍內每一列的最外側面補到／削到座標 to（沿 dir 軸）；follow = 襯層跟推（同 push）。 */
  | { kind: 'level'; keys: string[]; scope: Scope; dir: Vec3; to: number; local: Local; backfill: Backfill; follow?: boolean; ref?: LevelRef }
  | CdOp
  | DilateOp
  | DefectOp
  | TaperOp
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

const unit = (a: number, s: number): Vec3 => {
  const d: Vec3 = [0, 0, 0];
  d[a] = s;
  return d;
};

/**
 * cd 展開成推面（plan v11 §4.5）：center → lo 側 floor(|δ|/2)、hi 側 ceil(|δ|/2)（奇數多的給 hi，§9 D8）；
 * lo 錨定＝只推 hi 側 δ；hi 錨定＝只推 lo 側 δ。先 lo 後 hi。
 */
export function cdSteps(op: CdOp): PushStep[] {
  const s = Math.sign(op.delta);
  const m = Math.abs(op.delta);
  const [nlo, nhi] = op.anchor === 'lo' ? [0, m] : op.anchor === 'hi' ? [m, 0] : [Math.floor(m / 2), Math.ceil(m / 2)];
  const out: PushStep[] = [];
  if (nlo) out.push({ scope: op.scope, dir: unit(op.axis, -1), n: s * nlo });
  if (nhi) out.push({ scope: op.scope, dir: unit(op.axis, 1), n: s * nhi });
  return out;
}

/** taper 某一片的位移：沿 along 從 lo（top）到 hi（bottom）線性插值、四捨五入（Math.round）。 */
export const taperDelta = (top: number, bottom: number, lo: number, hi: number, t: number) =>
  Math.round(top + (bottom - top) * (hi === lo ? 0 : (t - lo) / (hi - lo)));

/**
 * taper 展開成推面（plan v11 §4.8）：結構沿 along 從 lo 到 hi 每一片算位移，相鄰同值合成一段，每段一個推面
 * （scope 夾在這一段；使用者的 scope 另外夾，插值仍按整根算）；both 時對面鏡像再做一次。
 */
export function taperSteps(op: TaperOp, bbox: BBox): PushStep[] {
  const A = (['x', 'y', 'z'] as const)[op.along];
  const lo = [bbox.x0, bbox.y0, bbox.z0][op.along];
  const hi = [bbox.x1, bbox.y1, bbox.z1][op.along];
  const segs: { a: number; b: number; n: number }[] = [];
  for (let t = lo; t <= hi; t++) {
    const n = taperDelta(op.top, op.bottom, lo, hi, t);
    const last = segs[segs.length - 1];
    if (last && last.n === n) last.b = t;
    else segs.push({ a: t, b: t, n });
  }
  const faces = op.both ? [op.face, op.face.map((v) => -v) as Vec3] : [op.face];
  const out: PushStep[] = [];
  for (const dir of faces)
    for (const s of segs) if (s.n) out.push({ scope: { axis: A, lo: s.a, hi: s.b }, dir, n: s.n, clip: op.scope });
  return out;
}

/** 缺陷的絕對外框：中心＝host 外框 lo + center·大小，size 格（含端點）；size 0 那一軸回傳 null（沒有缺陷）。 */
export function defectBox(host: BBox, center: Vec3, size: Vec3): BBox | null {
  if (size.some((v) => v <= 0)) return null;
  const lo = [host.x0, host.y0, host.z0];
  const hi = [host.x1, host.y1, host.z1];
  const r = [0, 1, 2].map((a) => {
    const c = lo[a] + center[a] * (hi[a] - lo[a] + 1);
    const s = Math.round(size[a]);
    const a0 = Math.round(c - s / 2);
    return [a0, a0 + s - 1];
  });
  return { x0: r[0][0], x1: r[0][1], y0: r[1][0], y1: r[1][1], z0: r[2][0], z1: r[2][1] };
}

/** level 的相對參照 → 絕對 to（沿 dir 軸）；參照結構不在回傳 null。 */
export function levelRefTo(L: Labeled, dir: Vec3, ref: LevelRef): number | null {
  const c = L.comps.find((x) => x.key === ref.key);
  if (!c) return null;
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const v = ref.side === 'lo' ? [c.bbox.x0, c.bbox.y0, c.bbox.z0][a] : [c.bbox.x1, c.bbox.y1, c.bbox.z1][a];
  return v + ref.offset;
}

/** 結構（keys 聯集）的外框。 */
export const bboxOfKeys = (L: Labeled, keys: string[]) => {
  const ks = new Set(keys);
  return unionBBox(L.comps.filter((c) => ks.has(c.key)));
};

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
    vol = growMask(s.vol, ctx.orig, mask, op.scope, op.dir, op.n, op.backfill, op.follow, undefined, op.policy ?? 'overwrite');
  } else if (op.kind === 'cd') {
    vol = pushSeq(s.vol, ctx.orig, mask, cdSteps(op), op.backfill, op.follow, op.policy ?? 'overwrite');
  } else if (op.kind === 'taper') {
    const b = bboxOfKeys(s.L, op.keys)!;
    vol = pushSeq(s.vol, ctx.orig, mask, taperSteps(op, b), op.backfill, op.follow, op.policy ?? 'overwrite');
  } else if (op.kind === 'dilate') {
    vol = dilateMask(s.vol, ctx.orig, mask, op.scope, op.n, op.backfill, op.follow);
  } else if (op.kind === 'defect') {
    vol = setRegionMaterial(s.vol, mask, op.scope, op.shape, op.abs, op.mat);
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
  const nm = (n: number) => `${(Math.abs(n) * nmPerVoxel).toFixed(1)} nm`;
  const pol = (p?: Policy) => (p === 'overwrite' ? ' · 允許穿層' : '');
  if (op.kind === 'push') {
    const n = Math.abs(op.n);
    return `${who}${part}${op.local ? `（${brush(op.local)}）` : ''} ${directionName(op.dir)}${op.n > 0 ? '長' : '縮'} ${n} vx（${nm(n)}）${op.policy ? pol(op.policy) : ''}`;
  }
  if (op.kind === 'cd') {
    const a = 'xyz'[op.axis];
    const anchor = op.anchor === 'center' ? '中心不動' : op.anchor === 'lo' ? `${a} 小的一側不動` : `${a} 大的一側不動`;
    return `${who}${part} 沿 ${a} 寬度 ${op.delta > 0 ? '+' : ''}${op.delta} vx（${nm(op.delta)}，${anchor}）${pol(op.policy)}`;
  }
  if (op.kind === 'dilate') return `${who}${part} 整層${op.n > 0 ? '加厚' : '減薄'} ${Math.abs(op.n)} vx（${nm(op.n)}，保形）`;
  if (op.kind === 'defect') {
    const s = op.size.map((v) => v).join('×');
    return `${who}${part} 放 ${matName(op.mat)}（${op.shape === 'sphere' ? '球' : op.shape === 'slab' ? '片' : '盒'}，${s} vx）`;
  }
  if (op.kind === 'taper') return `${who}${part} ${directionName(op.face)}側壁斜度：${op.along === 1 ? '頂' : '起端'} ${op.top > 0 ? '+' : ''}${op.top}、${op.along === 1 ? '底' : '末端'} ${op.bottom > 0 ? '+' : ''}${op.bottom} vx${op.both ? '（兩側）' : ''}${pol(op.policy)}`;
  if (op.kind === 'level') {
    const axis = op.dir[0] ? 'x' : op.dir[1] ? 'y' : 'z';
    return `${who}${part}（${brush(op.local)}）方頭到 ${axis} = ${op.to}（${(op.to * nmPerVoxel).toFixed(1)} nm）${op.ref ? `（相對參照 ${op.ref.offset > 0 ? '+' : ''}${op.ref.offset} vx）` : ''}`;
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

/** 掃描：同一個操作、不同數值，每個數值一個 op。@deprecated plan v11：由 factors.ts（Factor／Design）取代。 */
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
