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
    return `${who}${brush} ${faceName(op.dir)}${coord}（${verb} ${n} 格 = ${nmText(n, w.nm)}）· 襯層${op.follow ? '跟著' : '不跟'}${tail}`;
  }
  if (op.kind === 'level') {
    const a = axisOf(op.dir);
    const brush = op.local.radius === null ? '每一排' : `筆刷 r${op.local.radius} 內每一排`;
    return `${who} 方頭：${faceName(op.dir)}${brush}補到 ${AXIS[a]} = ${op.to}（${nmText(op.to, w.nm)}）· 只填空氣${op.follow ? '、襯層跟著' : ''}${tail}`;
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
  return `${who} ${op.text ?? '剖面調整'}${tail}`;
}

/** 方向的短名：「↑ 往上（−y）」。 */
export function dirLabel(d: Vec3) {
  const a = axisOf(d);
  return `${directionName(d)}（${d[a] > 0 ? '+' : '−'}${AXIS[a]}）`;
}
