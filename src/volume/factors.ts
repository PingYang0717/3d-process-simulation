// 實驗變數（Factor）與水平（level）（plan v11 §4.1～§4.3）：純函式，主執行緒與測試共用。
// Factor／Design 是標註，不是第二份真相（§9 D11）：產生出來的 Op 全是絕對格數，刪掉 factors 仍然完整可重播。
import { type Backfill, type BBox, type Labeled, type Vec3, type Volume, maskOf, thicknessOf, unionBBox } from './volume';
import { type DefectShape, type LevelRef, type Op, type Policy, defectBox, levelRefTo } from './ops';
import { type Scope, fullScope } from './scope';
import { roundOp } from '../slice/round';
import type { RoundGesture } from '../slice/round';

export type FactorOp = 'cd' | 'push' | 'translate' | 'level' | 'round' | 'dilate' | 'taper' | 'defect';

export interface Factor {
  /** ASCII id：檔名、manifest、命名樣板用；預設自動產生（defaultId），可改，同一個 Design 內唯一。 */
  id: string;
  /** 顯示名，可中文；預設同 id。 */
  name: string;
  keys: string[];
  op: FactorOp;
  /**
   * 變數欄位：cd→delta、push→n、translate→d、level→offset（有 ref）或 to、round→r、dilate→n、
   * taper→top|bottom|both、defect→size[0..2] 或 center[0..2]。
   */
  param: string;
  /** 其他固定欄位（dir、axis、anchor、face、along、shape、center、size、mat、ref、corners、follow、backfill、policy、scope…）；缺的用 ctx 補。 */
  template: Record<string, unknown>;
  unit: 'nm' | 'vx';
  /** 標稱：絕對量的基準（vx）。cd＝現在的寬、push／level＝那一面的座標（level 有 ref＝面 − 參照）、dilate＝量到的厚度；其他 0。 */
  nominal: number;
  /** 水平輸入：有標稱可量的絕對、本質是位移的相對（§9 D4）。 */
  mode: 'absolute' | 'relative';
  /**
   * 結構沿這個變數的尺寸（格；plan v14 §5.4，預設水平依它）：圓頭＝半徑上限 min(半寬, 半高)、cd／移動＝沿軸寬、
   * 長縮／方頭＝沿那一面法線的長、斜度＝沿那一面的寬、保形層＝最短的一邊；缺陷沒有。舊的變數沒有這一欄。
   */
  size?: number;
}

export interface Design {
  /** 哪一次產生（manifest 的 designs[].id）。 */
  id?: string;
  factors: Factor[];
  /** 每個 factor 的水平（以 unit 為單位；mode 決定是絕對還是相對）。 */
  levels: Record<string, number[]>;
  /** 單變數掃描（其他維持標稱）／全因子／手動勾選的組合。 */
  combine: 'ofat' | 'full' | 'manual';
  picks?: Record<string, number>[];
  from: 'base' | 'active' | 'all';
  /** 每個變數一段，多變數用 '_' 連；可用 {id}、{name}、{value}、{unit}、{n}。 */
  nameTemplate: string;
  /** 產生的時間（實驗頁的分組標題，plan v12 §5.4）。 */
  at?: number;
}

export const DEFAULT_NAME_TEMPLATE = '{id}={value}{unit}';

export interface FactorCtx {
  L: Labeled;
  vol: Volume;
  nmPerVoxel: number;
  follow: boolean;
  backfill: Backfill;
  policy: Policy;
}

/** 這個 factor 的水平是不是「格數／nm」（defect 的 center 是 0～1，不換單位）。 */
const isFraction = (f: Pick<Factor, 'op' | 'param'>) => f.op === 'defect' && f.param.startsWith('center');
const paramAxis = (p: string) => Number(p.match(/\[(\d)\]/)?.[1] ?? 0) as 0 | 1 | 2;

/** 水平（unit）→ 格數（浮點）。 */
export const toVx = (f: Pick<Factor, 'unit' | 'op' | 'param'>, v: number, nm: number) => (isFraction(f) || f.unit === 'vx' ? v : v / nm);
/** 格數 → 水平（unit）。 */
export const fromVx = (f: Pick<Factor, 'unit' | 'op' | 'param'>, v: number, nm: number) => (isFraction(f) || f.unit === 'vx' ? v : v * nm);

/** 標稱那一個水平（unit）：絕對＝標稱、相對＝0。 */
export const nominalLevel = (f: Factor, nm: number) => (f.mode === 'absolute' ? fromVx(f, f.nominal, nm) : 0);

/** 水平 → 相對標稱的位移（格，取整；defect center 不取整）。 */
export function deltaOf(f: Factor, v: number, nm: number) {
  const vx = toVx(f, v, nm);
  if (isFraction(f)) return f.mode === 'absolute' ? vx - f.nominal : vx;
  return Math.round(vx) - (f.mode === 'absolute' ? Math.round(f.nominal) : 0);
}

/** 兩欄顯示：「18 nm（−2 nm）」的另一欄（絕對 → 相對、相對 → 絕對）。 */
export function otherColumn(f: Factor, v: number, nm: number) {
  const d = deltaOf(f, v, nm);
  if (f.mode === 'absolute') return fromVx(f, d, nm);
  return fromVx(f, (isFraction(f) ? f.nominal : Math.round(f.nominal)) + d, nm);
}

const sameDir = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const axisOf = (d: Vec3) => (d[0] ? 0 : d[1] ? 1 : 2);
const loOf = (b: BBox) => [b.x0, b.y0, b.z0];
const hiOf = (b: BBox) => [b.x1, b.y1, b.z1];
/** 那一面的座標（dir 正＝hi、負＝lo）。 */
const faceCoord = (b: BBox, dir: Vec3) => {
  const a = axisOf(dir);
  return dir[a] > 0 ? hiOf(b)[a] : loOf(b)[a];
};

/** 從現在的狀態量標稱（vx）：cd／push／level／dilate 用；量不到回 0。 */
export function measureNominal(L: Labeled, vol: Volume, f: Pick<Factor, 'keys' | 'op' | 'template' | 'param'>): number {
  const ks = new Set(f.keys);
  const comps = L.comps.filter((c) => ks.has(c.key));
  const b = unionBBox(comps);
  if (!b) return 0;
  const t = f.template;
  if (f.op === 'cd') {
    const a = (t.axis as number) ?? 0;
    return hiOf(b)[a] - loOf(b)[a] + 1;
  }
  if (f.op === 'push') return faceCoord(b, t.dir as Vec3);
  if (f.op === 'level') {
    const dir = t.dir as Vec3;
    const face = faceCoord(b, dir);
    const ref = t.ref as Omit<LevelRef, 'offset'> | undefined;
    if (!ref) return face;
    const r = levelRefTo(L, dir, { ...ref, offset: 0 });
    return r === null ? 0 : face - r;
  }
  if (f.op === 'dilate') return thicknessOf(vol, maskOf(L, ks, vol)!, b);
  if (f.op === 'defect' && f.param.startsWith('center')) return ((t.center as Vec3) ?? [0.5, 0.5, 0.5])[paramAxis(f.param)];
  return 0;
}

/** 這個操作的預設參數、水平輸入模式。 */
export function factorDefaults(op: FactorOp): { param: string; mode: Factor['mode'] } {
  switch (op) {
    case 'cd':
      return { param: 'delta', mode: 'absolute' };
    case 'push':
      return { param: 'n', mode: 'relative' };
    case 'translate':
      return { param: 'd', mode: 'relative' };
    case 'level':
      return { param: 'to', mode: 'absolute' };
    case 'round':
      return { param: 'r', mode: 'absolute' };
    case 'dilate':
      return { param: 'n', mode: 'absolute' };
    case 'taper':
      return { param: 'bottom', mode: 'relative' };
    case 'defect':
      return { param: 'size[1]', mode: 'relative' };
  }
}

/** 一個 factor 在 delta（格）時的 Op；delta 為 0（＝標稱）回傳 null。 */
export function opOfFactor(f: Factor, v: number, ctx: FactorCtx): Op | null {
  const d = deltaOf(f, v, ctx.nmPerVoxel);
  if (!d) return null;
  const t = f.template;
  const keys = f.keys;
  const follow = (t.follow as boolean | undefined) ?? ctx.follow;
  const backfill = (t.backfill as Backfill | undefined) ?? ctx.backfill;
  const policy = (t.policy as Policy | undefined) ?? ctx.policy;
  const scope = (t.scope as Scope | undefined) ?? fullScope(ctx.vol, 'z');
  const b = unionBBox(ctx.L.comps.filter((c) => keys.includes(c.key)));
  if (!b) return null;
  switch (f.op) {
    case 'cd':
      return { kind: 'cd', keys, scope, axis: ((t.axis as number) ?? 0) as 0 | 1 | 2, delta: d, anchor: (t.anchor as 'center' | 'lo' | 'hi') ?? 'center', follow, backfill, policy };
    case 'push': {
      const dir = t.dir as Vec3;
      // 絕對：水平是那一面的新座標 → 沿法線的格數＝(新 − 舊)·方向
      const n = f.mode === 'absolute' ? d * dir[axisOf(dir)] : d;
      return n ? { kind: 'push', keys, scope, dir, n, follow, backfill, policy } : null;
    }
    case 'translate': {
      const a = ((t.axis as number) ?? 0) as 0 | 1 | 2;
      const dv: Vec3 = [0, 0, 0];
      dv[a] = d;
      return { kind: 'translate', keys, scope, d: dv, backfill, ...(t.follow !== undefined ? { follow: !!t.follow } : {}) };
    }
    case 'level': {
      const dir = t.dir as Vec3;
      const refT = t.ref as Omit<LevelRef, 'offset'> | undefined;
      let to: number;
      let ref: LevelRef | undefined;
      if (refT) {
        const offset = Math.round(f.nominal) + d;
        const r = levelRefTo(ctx.L, dir, { ...refT, offset });
        if (r === null) return null;
        to = r;
        ref = { ...refT, offset };
      } else to = Math.round(f.nominal) + d;
      const center: Vec3 = [(b.x0 + b.x1) >> 1, (b.y0 + b.y1) >> 1, (b.z0 + b.z1) >> 1];
      return { kind: 'level', keys, scope, dir, to, local: { center, radius: null }, backfill, follow, ...(ref ? { ref } : {}) };
    }
    case 'round': {
      const r = Math.round(f.nominal) + d;
      if (r <= 0) return null;
      const g = { kind: 'round', corners: [{ id: 'ul' }, { id: 'ur' }], n: 2, mode: 'match', ...(t.gesture as object), r } as RoundGesture;
      const rs = (t.scope as Scope | undefined) ?? fullScope(ctx.vol, ((t.axis as Scope['axis']) ?? 'z'));
      const at = (t.at as number | undefined) ?? Math.round((loOf(b)[axisIdx(rs.axis)] + hiOf(b)[axisIdx(rs.axis)]) / 2);
      // 圓頭預設不帶襯層（plan v14 §5.3）；樣板明確寫了才照樣板
      return roundOp(ctx.L, ctx.vol, keys, rs, at, g, (t.follow as boolean | undefined) ?? false, backfill, ctx.nmPerVoxel);
    }
    case 'dilate':
      return { kind: 'dilate', keys, scope, n: d, metric: 'euclid', follow, backfill };
    case 'taper': {
      const top0 = (t.top as number) ?? 0;
      const bottom0 = (t.bottom as number) ?? 0;
      const [top, bottom] = f.param === 'top' ? [d, bottom0] : f.param === 'both' ? [-d, d] : [top0, d];
      if (!top && !bottom) return null;
      return { kind: 'taper', keys, scope, face: t.face as Vec3, along: ((t.along as number) ?? 1) as 0 | 1 | 2, top, bottom, ...(t.both ? { both: true } : {}), follow, backfill, policy };
    }
    case 'defect': {
      const center: Vec3 = [...((t.center as Vec3) ?? [0.5, 0.5, 0.5])];
      const size: Vec3 = [...((t.size as Vec3) ?? [1, 1, 1])];
      const a = paramAxis(f.param);
      if (f.param.startsWith('center')) center[a] = (f.mode === 'absolute' ? f.nominal : center[a]) + d;
      else size[a] = d;
      const abs = defectBox(b, center, size);
      if (!abs) return null;
      return { kind: 'defect', keys, scope, shape: (t.shape as DefectShape) ?? 'slab', center, size, mat: (t.mat as number) ?? 254, abs };
    }
  }
}
const axisIdx = (a: Scope['axis']) => (a === 'x' ? 0 : a === 'y' ? 1 : 2);

/** 一個組合 → 一串 Op（每個 factor 一個；水平等於標稱的 factor 不產生 Op）。純函式。 */
export function opsOfCombo(design: Design, combo: Record<string, number>, ctx: FactorCtx): Op[] {
  const out: Op[] = [];
  for (const f of design.factors) {
    const v = combo[f.id];
    if (v === undefined) continue;
    const op = opOfFactor(f, v, ctx);
    if (op) out.push(op);
  }
  return out;
}

/** 組合展開：ofat → 每個 factor 各自掃、其他取標稱（重複的組合只留一個）；full → 笛卡兒積（後面的變數變得快）；manual → picks。 */
export function combosOf(design: Design, nm = 1): Record<string, number>[] {
  const fs = design.factors;
  const lv = (f: Factor) => design.levels[f.id] ?? [];
  if (design.combine === 'manual') return (design.picks ?? []).map((p) => ({ ...p }));
  if (design.combine === 'full') {
    let out: Record<string, number>[] = [{}];
    for (const f of fs) {
      const ls = lv(f);
      if (!ls.length) continue;
      out = out.flatMap((c) => ls.map((v) => ({ ...c, [f.id]: v })));
    }
    return fs.some((f) => lv(f).length) ? out : [];
  }
  const nominal = Object.fromEntries(fs.map((f) => [f.id, nominalLevel(f, nm)]));
  const seen = new Set<string>();
  const out: Record<string, number>[] = [];
  for (const f of fs)
    for (const v of lv(f)) {
      const c = { ...nominal, [f.id]: v };
      const key = fs.map((g) => deltaOf(g, c[g.id], nm)).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  return out;
}

/** nm 保留一位小數但去掉 .0；vx 整數；defect center 兩位。 */
export function formatLevel(f: Pick<Factor, 'unit' | 'op' | 'param'>, v: number, signed = false) {
  const s = isFraction(f) ? v.toFixed(2) : f.unit === 'nm' ? (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  const z = s.replace(/^-/, '');
  const neg = v < 0 && Number(z) !== 0;
  return `${neg ? '-' : signed && Number(z) !== 0 ? '+' : ''}${z}`;
}
const unitText = (f: Pick<Factor, 'unit' | 'op' | 'param'>) => (isFraction(f) ? '' : f.unit);

/** 名字：每個變數照樣板一段（{id}={value}{unit}），多變數用 '_' 連；value 依 mode 是絕對值或帶號相對值；{n}＝序號（1 起）。 */
export function nameOfCombo(design: Design, combo: Record<string, number>, n?: number): string {
  const tpl = design.nameTemplate || DEFAULT_NAME_TEMPLATE;
  const parts = design.factors
    .filter((f) => combo[f.id] !== undefined)
    .map((f) =>
      tpl
        .replace(/\{id\}/g, f.id)
        .replace(/\{name\}/g, f.name)
        .replace(/\{value\}/g, formatLevel(f, combo[f.id], f.mode === 'relative'))
        .replace(/\{unit\}/g, unitText(f))
        .replace(/\{n\}/g, String(n ?? '')),
    );
  return parts.join('_') || `split${n ?? ''}`;
}

/**
 * 水平輸入：「16, 18, 20」「±2 step 1」「-2..2 step 1」「nominal ±10%」（可加 step 5%）。
 * ± 與 nominal 都是相對標稱：mode 絕對時加上標稱（unit）、相對時就是位移。回傳 null＝讀不懂。
 */
export function parseLevels(text: string, f: Factor, nm: number): number[] | null {
  const s = text.replace(/[−–—]/g, '-').replace(/＋/g, '+').replace(/，|、/g, ',').trim().toLowerCase();
  if (!s) return [];
  const nom = f.mode === 'absolute' ? fromVx(f, f.nominal, nm) : 0;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  const range = (a: number, b: number, step: number) => {
    if (!(step > 0)) return null;
    const out: number[] = [];
    for (let v = a; v <= b + step * 1e-9; v += step) out.push(round(v));
    return out.length > 200 ? null : out;
  };
  let m = s.match(/^(?:nominal|nom|標稱)\s*±\s*([\d.]+)\s*%(?:\s*step\s*([\d.]+)\s*%)?$/);
  if (m) {
    const p = Number(m[1]) / 100;
    const base = f.mode === 'absolute' ? nom : fromVx(f, f.nominal, nm);
    const step = m[2] ? Number(m[2]) / 100 : p;
    const fr = range(-p, p, step);
    if (!fr) return null;
    return fr.map((k) => round(f.mode === 'absolute' ? base * (1 + k) : base * k));
  }
  m = s.match(/^±\s*([\d.]+)\s*(?:step\s*([\d.]+))?$/);
  if (m) {
    const a = Number(m[1]);
    const r = range(-a, a, m[2] ? Number(m[2]) : a);
    return r && r.map((v) => round(nom + v));
  }
  m = s.match(/^(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*(?:step\s*([\d.]+))?$/);
  if (m) {
    const r = range(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1);
    return r;
  }
  const vals = s.split(/[,\s]+/).filter(Boolean).map(Number);
  return vals.every((v) => Number.isFinite(v)) ? vals : null;
}

/** 水平小於半格（取整後和標稱相同、但不是標稱本身）：警告用。 */
export const belowHalf = (f: Factor, v: number, nm: number) => !isFraction(f) && deltaOf(f, v, nm) === 0 && Math.abs(v - nominalLevel(f, nm)) > 1e-9;

// ---- 預設 id（§4.3）----

const SUB = '₀₁₂₃₄₅₆₇₈₉';
/** 結構名 → ASCII：去空白與符號、× → x、下標數字轉半形；非 ASCII 回 null。 */
export function slug(s: string): string | null {
  const t = s
    .replace(/[₀-₉]/g, (c) => String(SUB.indexOf(c)))
    .replace(/[×✕]/g, 'x')
    .replace(/[\s\-–—_()（）.,:;/\\'"]+/g, '');
  return /^[A-Za-z0-9]*$/.test(t) && t ? t : null;
}
const labelNumber = (label: string) => parseInt(label.split(' ').pop() ?? '0', 10) || 0;

const FACE_SUFFIX = (d: Vec3) => {
  const a = axisOf(d);
  const s = d[a] > 0;
  return a === 1 ? (s ? 'bot' : 'top') : a === 0 ? (s ? 'R' : 'L') : s ? 'B' : 'F';
};

/** 參數後綴：cd→W／H／D、push→面、translate→軸、level→to、round→r、dilate→t、taper→taper、defect→void。 */
function suffixOf(op: FactorOp, t: Record<string, unknown>) {
  switch (op) {
    case 'cd':
      return ['W', 'H', 'D'][(t.axis as number) ?? 0];
    case 'push':
      return FACE_SUFFIX(t.dir as Vec3);
    case 'translate':
      return 'xyz'[(t.axis as number) ?? 0];
    case 'level':
      return 'to';
    case 'round':
      return 'r';
    case 'dilate':
      return 't';
    case 'taper':
      return 'taper';
    case 'defect':
      return 'void';
  }
}

/** 預設 id：slug(結構名) + '_' + 參數後綴；非 ASCII 用 m{材質編號}；多個結構＝材質 + x{n}；重複加 _2、_3。 */
export function defaultId(L: Labeled, keys: string[], op: FactorOp, template: Record<string, unknown>, matName: (id: number) => string, taken: Iterable<string> = []): string {
  const comps = keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  let who = 'S';
  if (comps.length === 1) {
    const c = comps[0];
    const n = labelNumber(c.label);
    const m = slug(c.label.slice(0, c.label.length - String(n).length).trim() || matName(c.mat));
    who = m ? `${m}${n || ''}` : `m${c.mat}_${n}`;
  } else if (comps.length) {
    const mats = new Set(comps.map((c) => c.mat));
    if (mats.size === 1) {
      const mat = [...mats][0];
      const m = slug(matName(mat));
      who = `${m ?? `m${mat}`}x${comps.length}`;
    } else who = `S${comps.length}`;
  }
  const base = `${who}_${suffixOf(op, template)}`;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let k = 2; ; k++) if (!used.has(`${base}_${k}`)) return `${base}_${k}`;
}

/** 新變數：量標稱、選預設參數與模式、給預設 id。 */
export function makeFactor(L: Labeled, vol: Volume, keys: string[], op: FactorOp, template: Record<string, unknown>, matName: (id: number) => string, taken: Iterable<string>, unit: Factor['unit'] = 'nm', param?: string): Factor {
  const d = factorDefaults(op);
  const p = param ?? (op === 'level' && template.ref ? 'offset' : d.param);
  const id = defaultId(L, keys, op, template, matName, taken);
  const f: Factor = { id, name: id, keys, op, param: p, template, unit, nominal: 0, mode: d.mode };
  f.nominal = measureNominal(L, vol, f);
  const size = factorSize(L, f);
  if (size !== undefined) f.size = size;
  if (op === 'level' && template.ref) f.mode = 'absolute';
  return f;
}

const AXIS_OF: Record<string, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const dirAxis = (d: unknown): 0 | 1 | 2 | null => (Array.isArray(d) ? (d[0] ? 0 : d[1] ? 1 : d[2] ? 2 : null) : null);
/** 見 Factor.size。 */
export function factorSize(L: Labeled, f: Pick<Factor, 'keys' | 'op' | 'template'>): number | undefined {
  const b = unionBBox(L.comps.filter((c) => f.keys.includes(c.key)));
  if (!b) return undefined;
  const ext = [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1];
  const t = f.template;
  const num = (a: unknown) => (typeof a === 'number' ? (a as 0 | 1 | 2) : typeof a === 'string' && a in AXIS_OF ? AXIS_OF[a] : null);
  switch (f.op) {
    case 'round': {
      // 剖面法線＝axis（或 scope.axis）；半徑上限＝剖面上 min(半寬, 半高)
      const n = num(t.axis) ?? num((t.scope as Scope | undefined)?.axis) ?? 2;
      const plane = [0, 1, 2].filter((k) => k !== n);
      return Math.max(1, Math.floor(Math.min(ext[plane[0]], ext[plane[1]]) / 2));
    }
    case 'cd':
    case 'translate': {
      const a = num(t.axis);
      return a === null ? undefined : ext[a];
    }
    case 'push':
    case 'level': {
      const a = dirAxis(t.dir);
      return a === null ? undefined : ext[a];
    }
    case 'taper': {
      const a = dirAxis(t.face);
      return a === null ? undefined : ext[a];
    }
    case 'dilate':
      return Math.min(...ext);
    default:
      return undefined;
  }
}

// ---- 範本（§4.3）----

/** 結構的對法：材質名稱＋同材質裡第幾個（label 裡的序號）。 */
export interface Match {
  material: string;
  ordinal?: number;
  ordinals?: number[];
}
export interface TemplateFactor extends Omit<Factor, 'keys' | 'nominal'> {
  match: Match;
  levels: number[];
}
export interface DesignTemplate {
  version: 1;
  name: string;
  factors: TemplateFactor[];
  combine: Design['combine'];
  nameTemplate: string;
}

function matchOf(L: Labeled, keys: string[], matName: (id: number) => string): Match {
  const comps = keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  const material = comps.length ? matName(comps[0].mat) : '';
  const ords = comps.map((c) => labelNumber(c.label));
  return ords.length === 1 ? { material, ordinal: ords[0] } : { material, ordinals: ords };
}
function keysOf(L: Labeled, m: Match, matName: (id: number) => string): string[] | null {
  const want = m.ordinals ?? (m.ordinal !== undefined ? [m.ordinal] : []);
  const keys = want.map((o) => L.comps.find((c) => matName(c.mat) === m.material && labelNumber(c.label) === o)?.key);
  return keys.length && keys.every((k) => !!k) ? (keys as string[]) : null;
}

/** Design → 範本（keys 換成 match；level 的 ref.key 也換成 match）。 */
export function toTemplate(design: Design, name: string, L: Labeled, matName: (id: number) => string): DesignTemplate {
  return {
    version: 1,
    name,
    combine: design.combine,
    nameTemplate: design.nameTemplate,
    factors: design.factors.map(({ keys, nominal: _n, ...f }) => {
      const template = { ...f.template };
      const ref = template.ref as Omit<LevelRef, 'offset'> | undefined;
      if (ref) template.ref = { side: ref.side, match: matchOf(L, [ref.key], matName) };
      delete template.scope;
      return { ...f, template, match: matchOf(L, keys, matName), levels: design.levels[f.id] ?? [] };
    }),
  };
}

/** 範本 → Design：對回結構、重新量標稱；對不到的變數列在 missing（keys 為空，不擋其他變數）。 */
export function fromTemplate(tpl: DesignTemplate, L: Labeled, vol: Volume, matName: (id: number) => string): { design: Design; missing: string[] } {
  if (tpl.version !== 1) throw new Error(`不支援的範本版本 ${tpl.version}`);
  const missing: string[] = [];
  const factors: Factor[] = tpl.factors.map(({ match, levels: _l, ...f }) => {
    const keys = keysOf(L, match, matName);
    const template = { ...f.template };
    const ref = template.ref as { side: 'lo' | 'hi'; match: Match } | undefined;
    let ok = !!keys;
    if (ref?.match) {
      const rk = keysOf(L, ref.match, matName);
      if (rk) template.ref = { key: rk[0], side: ref.side };
      else ok = false;
    }
    if (!ok) missing.push(f.id);
    const out: Factor = { ...f, template, keys: keys ?? [], nominal: 0 };
    delete out.size;
    if (ok) {
      out.nominal = measureNominal(L, vol, out);
      const size = factorSize(L, out);
      if (size !== undefined) out.size = size;
    }
    return out;
  });
  return {
    design: { factors, levels: Object.fromEntries(tpl.factors.map((f) => [f.id, f.levels])), combine: tpl.combine, from: 'base', nameTemplate: tpl.nameTemplate || DEFAULT_NAME_TEMPLATE },
    missing,
  };
}

/** 用來檢查：兩個方向相同。 */
export { sameDir };

// ---- plan v12 §5.6：水平的驗證與預設 ----

/** 一個水平的問題：error＝不能產生（紅）；noop＝不改動（灰，對照組）。 */
export interface Problem {
  v: number;
  level: 'error' | 'noop';
  msg: string;
}

/** 驗證要的情境：結構、陣列大小、nm 比例。 */
export interface CheckCtx {
  L: Labeled;
  dims: { X: number; Y: number; Z: number };
  nm: number;
}

/**
 * 每個水平先擋（plan v12 §5.6）：負半徑／負厚度、寬度變 0、超出陣列、推到 0 格、側壁削穿、缺陷大小 0、位置不在 0～1；
 * 等於標稱（或改動 0）標「不改動」。純函式。
 */
export function validateLevels(f: Factor, levels: number[], ctx: CheckCtx): Problem[] {
  const out: Problem[] = [];
  const ks = new Set(f.keys);
  const b = unionBBox(ctx.L.comps.filter((c) => ks.has(c.key)));
  const dim = [ctx.dims.X, ctx.dims.Y, ctx.dims.Z];
  const t = f.template;
  for (const v of levels) {
    const err = (msg: string) => out.push({ v, level: 'error', msg });
    const noop = (msg: string) => out.push({ v, level: 'noop', msg });
    if (!Number.isFinite(v)) {
      err('不是數字');
      continue;
    }
    if (!b) {
      err('對不到結構，請重選');
      continue;
    }
    const lo = loOf(b);
    const hi = hiOf(b);
    if (isFraction(f)) {
      const c = f.mode === 'absolute' ? v : f.nominal + v;
      if (c < 0 || c > 1) err('位置要在 0～1');
      else if (deltaOf(f, v, ctx.nm) === 0) noop('等於標稱（不改動）');
      continue;
    }
    const d = deltaOf(f, v, ctx.nm);
    const nom = Math.round(f.nominal);
    switch (f.op) {
      case 'cd': {
        const a = ((t.axis as number) ?? 0) as 0 | 1 | 2;
        if (nom + d < 1) err('寬度會變成 0（最少 1 格）');
        else if (!d) noop('等於標稱（不改動）');
        else {
          const anchor = (t.anchor as string) ?? 'center';
          const grow = Math.max(0, d);
          const [gl, gh] = anchor === 'center' ? [Math.floor(grow / 2), Math.ceil(grow / 2)] : anchor === 'lo' ? [0, grow] : [grow, 0];
          if (lo[a] - gl < 0 || hi[a] + gh > dim[a] - 1) err('超出陣列');
        }
        break;
      }
      case 'push': {
        const dir = t.dir as Vec3;
        const a = axisOf(dir);
        const n = f.mode === 'absolute' ? d * dir[a] : d;
        if (!n) noop('等於標稱（不改動）');
        else if (n < 0 && -n >= hi[a] - lo[a] + 1) err('會把結構推到 0 格');
        else if (n > 0 && (dir[a] > 0 ? hi[a] + n > dim[a] - 1 : lo[a] - n < 0)) err('超出陣列');
        break;
      }
      case 'translate': {
        const a = ((t.axis as number) ?? 0) as 0 | 1 | 2;
        if (!d) noop('不移動（對照組）');
        else if (lo[a] + d < 0 || hi[a] + d > dim[a] - 1) err('超出陣列');
        break;
      }
      case 'level': {
        const dir = t.dir as Vec3;
        const a = axisOf(dir);
        if (!d) {
          noop('等於標稱（不改動）');
          break;
        }
        let to = nom + d;
        if (t.ref) {
          const r = levelRefTo(ctx.L, dir, { ...(t.ref as Omit<LevelRef, 'offset'>), offset: nom + d });
          if (r === null) {
            err('參照結構不見了');
            break;
          }
          to = r;
        }
        if (to < 0 || to > dim[a] - 1) err('目標在陣列外');
        break;
      }
      case 'round': {
        const r = nom + d;
        if (r < 0) err('半徑不能小於 0');
        else if (!d || r === 0) noop(r === 0 ? '半徑 0＝方角（不改動）' : '等於標稱（不改動）');
        break;
      }
      case 'dilate': {
        const th = f.mode === 'absolute' ? nom + d : nom + d;
        if (th < 0) err('厚度不能小於 0');
        else if (!d) noop('等於標稱（不改動）');
        break;
      }
      case 'taper': {
        const face = (t.face as Vec3) ?? [1, 0, 0];
        const a = axisOf(face);
        const w = hi[a] - lo[a] + 1;
        if (!d) noop('不傾斜（對照組）');
        else if (Math.abs(d) >= (t.both ? Math.floor(w / 2) : w)) err('會把側壁削穿');
        break;
      }
      case 'defect': {
        if (d <= 0) {
          if (!d) noop('大小 0（不改動）');
          else err('大小要大於 0');
        }
        break;
      }
    }
  }
  return out;
}

/** 一個組合的問題（每個變數的水平各自驗證）；全部是標稱＝對照組。 */
export function comboProblems(design: Design, combo: Record<string, number>, ctx: CheckCtx): { errors: string[]; control: boolean } {
  const errors: string[] = [];
  let changes = 0;
  for (const f of design.factors) {
    const v = combo[f.id];
    if (v === undefined) continue;
    const ps = validateLevels(f, [v], ctx);
    for (const p of ps) if (p.level === 'error') errors.push(`${f.name || f.id}：${p.msg}`);
    if (!ps.some((p) => p.level === 'noop')) changes++;
  }
  return { errors, control: !errors.length && changes === 0 };
}

/** 標稱量不到的操作（水平只能相對、從 0 起）：移動、斜度、缺陷大小。 */
export const lockedNominal = (f: Pick<Factor, 'op' | 'param'>) => f.op === 'translate' || f.op === 'taper' || (f.op === 'defect' && !f.param.startsWith('center'));

/**
 * 預設水平按鈕（plan v12 §5.4 第 2 點）：用使用者的單位寫、括號附格數；值是這個 factor 的 unit＋mode。
 * size（格，預設 f.size；plan v14 §5.4）：有的話第一組依結構尺寸——圓頭 ¼、½、¾ 的半徑上限；
 * 其他 ±1 步、步距＝max(1 格, 尺寸 × 5%)。固定的 2、4、6 格與 ±0.5／1／2 nm 留在後面。
 */
export function presetLevels(f: Factor, nm: number, size: number | undefined = f.size): { label: string; values: number[] }[] {
  if (isFraction(f)) return [{ label: '0.25、0.5、0.75', values: [0.25, 0.5, 0.75] }];
  const r1 = (v: number) => Math.round(v * 1e6) / 1e6;
  const nomU = f.mode === 'absolute' ? fromVx(f, f.nominal, nm) : 0;
  const vxOf = (u: number) => Math.round(toVx(f, u, nm));
  const around = (a: number) => [r1(nomU - a), r1(nomU), r1(nomU + a)];
  const sized = size !== undefined && size > 0 && f.op !== 'defect';
  // 從 0 起的（半徑標稱 0、缺陷大小）：2, 4, 6 格
  if ((f.op === 'round' && Math.round(f.nominal) === 0) || (f.op === 'defect' && !f.param.startsWith('center'))) {
    const fixed = [{ label: '2、4、6 格', values: [2, 4, 6].map((k) => r1(fromVx(f, k, nm))) }, { label: '1、2、3 格', values: [1, 2, 3].map((k) => r1(fromVx(f, k, nm))) }];
    if (f.op !== 'round' || !sized) return fixed;
    const ks = [...new Set([0.25, 0.5, 0.75].map((q) => Math.max(1, Math.floor(size * q))))];
    return [{ label: `${ks.join('、')} 格（依結構：半徑上限 ${size} 格）`, values: ks.map((k) => r1(fromVx(f, k, nm))) }, ...fixed];
  }
  const out: { label: string; values: number[] }[] = [];
  if (sized && f.op !== 'round') {
    const k = Math.max(1, Math.round(size * 0.05));
    const a = r1(fromVx(f, k, nm));
    out.push({ label: f.unit === 'nm' ? `±${a} nm（±${k} 格，依結構尺寸 ${size} 格的 5%）` : `±${k} 格（依結構尺寸 ${size} 格的 5%）`, values: around(a) });
  }
  if (f.unit === 'nm') {
    for (const a of [0.5, 1, 2]) {
      const g = vxOf(a) - vxOf(0);
      if (g >= 1) out.push({ label: `±${a} nm（±${g} 格）`, values: around(a) });
    }
    // 比例小於 0.5 nm／格時 0.5 nm 不到一格：至少給 ±1 格
    if (!out.length) out.push({ label: `±1 格（±${nm} nm）`, values: around(nm) });
  } else
    for (const a of [1, 2, 4]) out.push({ label: `±${a} 格`, values: around(a) });
  if (!lockedNominal(f) && f.nominal > 0 && f.op !== 'push' && f.op !== 'level') {
    const p = Math.max(1, Math.round(f.nominal * 0.1));
    const a = fromVx(f, p, nm);
    out.push({ label: `±10%（±${p} 格）`, values: f.mode === 'absolute' ? around(a) : [r1(-a), 0, r1(a)] });
  }
  return out;
}

/** n 個等距水平：標稱置中、間距 step（unit）。 */
export function evenLevels(f: Factor, nm: number, n: number, step: number): number[] {
  const nomU = f.mode === 'absolute' ? fromVx(f, f.nominal, nm) : 0;
  const k0 = -Math.floor((n - 1) / 2);
  return Array.from({ length: n }, (_, i) => Math.round((nomU + (k0 + i) * step) * 1e6) / 1e6);
}

/** 換顯示模式（絕對 ⇄ 相對）：格數位移不變，水平換算成另一種寫法（plan v12 §5.4：只是顯示切換）。 */
export function switchMode(f: Factor, levels: number[], nm: number): { factor: Factor; levels: number[] } {
  const mode: Factor['mode'] = f.mode === 'absolute' ? 'relative' : 'absolute';
  return { factor: { ...f, mode }, levels: levels.map((v) => Math.round(otherColumn(f, v, nm) * 1e6) / 1e6) };
}

/** 設計的簽名（變數、水平、組合方式）：組合表的試算換了它就重來。 */
export const levelsSig = (d: Design) =>
  JSON.stringify([d.factors.map((f) => [f.id, f.keys, f.op, f.param, f.template, f.unit, f.nominal, f.mode]), d.levels, d.combine, d.picks ?? null, d.from]);
