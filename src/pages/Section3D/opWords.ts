// 卡片第一行「會發生什麼」（plan v10 §4.4）：一步操作 → 一句白話。純函式，不碰 React。
import { type BBox, type Labeled, type Vec3, directionName, unionBBox } from '../../volume/volume';
import type { Op } from '../../volume/ops';

export interface WordsCtx {
  L: Labeled;
  nm: number;
  matName: (id: number) => string;
  /** 範圍詞：「整根」「此片」「z 40～80」。 */
  scope: string;
}

const AXIS = ['x', 'y', 'z'] as const;
const axisOf = (d: Vec3) => (d[0] ? 0 : d[1] ? 1 : 2);
/** 方向 → 那一面的名字（體素 y 向下：−y＝頂面）。 */
export function faceName(d: Vec3) {
  const a = axisOf(d);
  const s = d[a] > 0;
  return a === 1 ? (s ? '底面' : '頂面') : a === 0 ? (s ? '右面' : '左面') : s ? '後面' : '前面';
}
const lo = (b: BBox) => [b.x0, b.y0, b.z0];
const hi = (b: BBox) => [b.x1, b.y1, b.z1];
/** 結構那一面現在的座標（面的外側那一格）。 */
const faceAt = (b: BBox, d: Vec3) => {
  const a = axisOf(d);
  return d[a] > 0 ? hi(b)[a] : lo(b)[a];
};
const nmText = (n: number, nm: number) => `${(Math.abs(n) * nm).toFixed(1)} nm`;

/** 「Poly-Si 2」「Si fin ×3」「2 個結構」。 */
export function whoText(L: Labeled, keys: string[], matName: (id: number) => string) {
  const comps = keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  if (comps.length === 1) return comps[0].label;
  const mats = new Set(comps.map((c) => c.mat));
  if (mats.size === 1 && comps.length) return `${matName([...mats][0])} ×${comps.length}`;
  return `${keys.length} 個結構`;
}

/** 一步操作的一句話：「Poly-Si 2 頂面 y 40 → 37（長高 3 格 = 1.5 nm）· 襯層跟著 · 整根」。 */
export function describeOp(w: WordsCtx, op: Op, extra?: { count?: number }): string {
  const who = whoText(w.L, op.keys, w.matName);
  const keys = new Set(op.keys);
  const b = unionBBox(w.L.comps.filter((c) => keys.has(c.key)));
  const tail = ` · ${w.scope}`;
  if (op.kind === 'push') {
    const a = axisOf(op.dir);
    const s = op.dir[a];
    const n = Math.abs(op.n);
    const grow = op.n > 0;
    const verb = a === 1 && s < 0 ? (grow ? '長高' : '縮短') : grow ? '長' : '縮';
    const from = b ? faceAt(b, op.dir) : null;
    const to = from === null ? null : from + s * op.n;
    const coord = from === null ? '' : ` ${AXIS[a]} ${from} → ${to}`;
    const brush = op.local && op.local.radius !== null ? `（筆刷 r${op.local.radius}）` : '';
    return `${who}${brush} ${faceName(op.dir)}${coord}（${verb} ${n} 格 = ${nmText(n, w.nm)}）· 襯層${op.follow ? '跟著' : '不跟'}${op.policy === 'overwrite' ? ' · 允許穿層' : ''}${tail}`;
  }
  if (op.kind === 'level') {
    const a = axisOf(op.dir);
    const brush = op.local.radius === null ? '每一排' : `筆刷 r${op.local.radius} 內每一排`;
    const ref = op.ref ? w.L.comps.find((c) => c.key === op.ref!.key) : undefined;
    const rel = op.ref && ref ? `（= ${ref.label} ${a === 1 ? (op.ref.side === 'lo' ? '頂' : '底') : op.ref.side === 'lo' ? AXIS[a] + ' 小端' : AXIS[a] + ' 大端'} ${op.ref.offset >= 0 ? '+' : '−'}${Math.abs(op.ref.offset)} 格 = ${nmText(op.ref.offset, w.nm)}）` : `（${nmText(op.to, w.nm)}）`;
    return `${who} 方頭：${faceName(op.dir)}${brush}補到 ${AXIS[a]} = ${op.to}${rel}· 只填空氣${op.follow ? '、襯層跟著' : ''}${tail}`;
  }
  if (op.kind === 'translate') {
    const parts: string[] = [];
    const [dx, dy, dz] = op.d;
    if (dx) parts.push(`往${dx > 0 ? '右' : '左'} ${Math.abs(dx)}`);
    if (dy) parts.push(`往${dy < 0 ? '上' : '下'} ${Math.abs(dy)}`);
    if (dz) parts.push(`往${dz > 0 ? '後' : '前'} ${Math.abs(dz)}`);
    return `${who} 整塊${parts.join('、')} 格${op.follow ? ' · 襯層一起搬' : ''}${tail}`;
  }
  if (op.kind === 'material') {
    const comps = w.L.comps.filter((c) => keys.has(c.key));
    const mats = new Set(comps.map((c) => c.mat));
    const from = mats.size === 1 ? w.matName([...mats][0]) : `${mats.size} 種材質`;
    const count = extra?.count ?? comps.reduce((s, c) => s + c.count, 0);
    return `${who}（${from}）→ ${w.matName(op.m)}，${count.toLocaleString()} 格${tail}`;
  }
  if (op.kind === 'cd') {
    const a = AXIS[op.axis];
    const w0 = b ? [b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1][op.axis] : null;
    const W = op.axis === 1 ? 'H' : op.axis === 2 ? 'D' : 'W';
    const m = Math.abs(op.delta);
    const sides = op.anchor === 'center' ? (m % 2 ? `兩側 +${Math.floor(m / 2)}／+${Math.ceil(m / 2)} 格` : `兩側各 ${op.delta > 0 ? '+' : '−'}${m / 2} 格`) : `單側 ${op.delta > 0 ? '+' : '−'}${m} 格`;
    const anchor = op.anchor === 'center' ? '中心不動' : op.anchor === 'lo' ? `${a} 小的一側不動` : `${a} 大的一側不動`;
    return `${who} ${W}（${a}）${w0 !== null ? `${w0} → ${w0 + op.delta}` : ''}（${sides} = ${nmText(op.delta, w.nm)}）· ${anchor} · 襯層${op.follow ? '跟著' : '不跟'}${op.policy === 'overwrite' ? ' · 允許穿層' : ''}${tail}`;
  }
  if (op.kind === 'dilate')
    return `${who} 整層${op.n > 0 ? '加厚' : '減薄'} ${Math.abs(op.n)} 格（${nmText(op.n, w.nm)}）：沿每一面${op.n > 0 ? '往外長' : '往內退'}${op.follow ? '，外面的薄層跟著' + (op.n > 0 ? '推開' : '退回') : ''}${tail}`;
  if (op.kind === 'defect') {
    const shape = op.shape === 'sphere' ? '球' : op.shape === 'slab' ? '片' : '盒';
    return `${who} 裡放 ${w.matName(op.mat)} ${shape}：中心 (${op.center.map((v) => v.toFixed(2)).join(', ')})、${op.size.join('×')} 格（${op.size.map((v) => (v * w.nm).toFixed(1).replace(/\.0$/, '')).join('×')} nm）`;
  }
  if (op.kind === 'taper') {
    const [t0, t1] = op.along === 1 ? ['頂', '底'] : op.along === 0 ? ['左端', '右端'] : ['前端', '後端'];
    const sg = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');
    const kind = op.bottom > op.top ? '（footing）' : op.bottom < op.top ? '（倒梯形）' : '';
    return `${who} ${faceName(op.face)}側壁：${t0} ${sg(op.top)}、${t1} ${sg(op.bottom)} 格（線性${kind}）${op.both ? ' · 兩側對稱' : ''}${op.policy === 'overwrite' ? ' · 允許穿層' : ''}${tail}`;
  }
  return `${who} ${op.text ?? '剖面調整'}${tail}`;
}

/** 方向的短名：「↑ 往上（−y）」。 */
export function dirLabel(d: Vec3) {
  const a = axisOf(d);
  return `${directionName(d)}（${d[a] > 0 ? '+' : '−'}${AXIS[a]}）`;
}

// ---- plan v12 §5.6：實驗變數卡第一行 ----

/** 變數的操作名（下拉、表頭）。 */
export const OP_LABEL: Record<string, string> = {
  cd: '對稱 CD（寬度）',
  push: '長／縮一面',
  translate: '整塊移動',
  level: '方頭到（recess）',
  round: '圓頭半徑',
  dilate: '保形層厚度',
  taper: '側壁斜度',
  defect: '缺陷（void）',
};
/** 一句說明（tooltip）。 */
export const OP_HELP: Record<string, string> = {
  cd: '對稱 CD：沿一個軸改總寬度，兩側各推一半（奇數格多的給大的一側），也可以固定一側；襯層跟著推。',
  push: '長／縮一面：結構在那個方向最外側的表面沿法線推 n 格（正＝長、負＝縮）；碰到厚的別的材質預設擋住。',
  translate: '整塊移動：結構沿一個軸平移 n 格，空出來的地方回填原本的內容。',
  level: '方頭到：那一面每一排補到同一個座標（只補空氣與可跟推的襯層）；可以相對另一個結構的面（相對 recess）。',
  round: '圓頭半徑：結構頂端兩個角改成半徑 r 的圓角（0＝方角），每一片用自己的外框重算。',
  dilate: '保形層厚度：沿表面法線整圈加厚／減薄，外面的薄層會被推開，厚的別的材質擋住。',
  taper: '側壁斜度：側壁頂、底各推不同格數，中間線性內插（footing／倒梯形）。',
  defect: '缺陷：在結構裡面放一塊別的材質（預設 VOID），位置相對結構外框、大小用格數。',
};

interface FactorLike {
  keys: string[];
  op: string;
  param: string;
  template: Record<string, unknown>;
  unit: 'nm' | 'vx';
  nominal: number;
}

/** 變數卡第一行（plan v12 §5.6）：「Poly-Si 2」＋「沿 z 的寬度（CD）· 現在 24 格＝12 nm」。 */
export function factorWords(f: FactorLike, L: Labeled, nm: number, matName: (id: number) => string): { who: string; what: string; now: string } {
  const who = whoText(L, f.keys, matName);
  const t = f.template;
  const n = Math.round(f.nominal);
  const nmOf = (v: number) => `${(Math.round(v * nm * 10) / 10).toString()} nm`;
  const fromZero = '從 0 起';
  switch (f.op) {
    case 'cd':
      return { who, what: `沿 ${AXIS[(t.axis as number) ?? 0]} 的寬度（CD）`, now: `現在 ${n} 格＝${nmOf(n)}` };
    case 'push': {
      const d = t.dir as Vec3;
      return { who, what: `${faceName(d)}長／縮（沿 ${AXIS[axisOf(d)]}）`, now: `現在${faceName(d)}在 ${AXIS[axisOf(d)]} = ${n}` };
    }
    case 'translate':
      return { who, what: `整塊沿 ${AXIS[(t.axis as number) ?? 0]} 移動`, now: fromZero };
    case 'level': {
      const d = t.dir as Vec3;
      const ref = t.ref as { key: string; side: string } | undefined;
      const rc = ref ? L.comps.find((c) => c.key === ref.key) : undefined;
      return ref
        ? { who, what: `${faceName(d)}方頭到 ${rc?.label ?? '參照'} 的面 + 偏移`, now: `現在差 ${n} 格＝${nmOf(n)}` }
        : { who, what: `${faceName(d)}方頭到 ${AXIS[axisOf(d)]} =`, now: `現在 ${n}` };
    }
    case 'round':
      return { who, what: '頂端圓頭的半徑', now: n ? `現在 ${n} 格＝${nmOf(n)}` : '現在是方角（0）' };
    case 'dilate':
      return { who, what: '整層厚度（保形）', now: `現在 ${n} 格＝${nmOf(n)}` };
    case 'taper': {
      const face = (t.face as Vec3) ?? [1, 0, 0];
      const which = f.param === 'top' ? '頂' : f.param === 'both' ? '整體傾斜' : '底';
      return { who, what: `${faceName(face)}側壁斜度（${which}）`, now: fromZero };
    }
    case 'defect': {
      const k = Number(f.param.match(/\[(\d)\]/)?.[1] ?? 0);
      return f.param.startsWith('center')
        ? { who, what: `裡的缺陷位置 ${AXIS[k]}（0～1）`, now: `現在 ${f.nominal.toFixed(2)}` }
        : { who, what: `裡的缺陷大小 ${AXIS[k]}`, now: fromZero };
    }
  }
  return { who, what: OP_LABEL[f.op] ?? f.op, now: '' };
}
