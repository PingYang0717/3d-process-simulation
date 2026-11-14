// 一步的白話說明（plan v17 §5.5）：純函式，可單獨測試。
// 第一句：誰、哪一面、外推或內縮（或往哪邊搬）、幾格、幾 nm；之後每一句一種鄰居怎麼了（都寫出幾格）；沒做滿再加一句為什麼。
import type { Vec3 } from '../../volume/volume';
import type { Block } from '../../volume/kernel';
import type { Effects } from '../../volume/report';

export type FaceName = '上' | '下' | '左' | '右' | '前' | '後';

/** 六個面／方向（和面板按鈕、鍵盤、3D 箭頭上的字一致）：上＝y 變小，前＝z 變大（朝向觀者）。 */
export const FACES: { name: FaceName; d: Vec3; key: string; cap: string }[] = [
  { name: '上', d: [0, -1, 0], key: 'ArrowUp', cap: '↑' },
  { name: '下', d: [0, 1, 0], key: 'ArrowDown', cap: '↓' },
  { name: '左', d: [-1, 0, 0], key: 'ArrowLeft', cap: '←' },
  { name: '右', d: [1, 0, 0], key: 'ArrowRight', cap: '→' },
  { name: '前', d: [0, 0, 1], key: 'PageDown', cap: 'PgDn' },
  { name: '後', d: [0, 0, -1], key: 'PageUp', cap: 'PgUp' },
];
export const OPPOSITE: Record<FaceName, FaceName> = { 上: '下', 下: '上', 左: '右', 右: '左', 前: '後', 後: '前' };
export const faceOf = (name: FaceName) => FACES.find((f) => f.name === name)!;
export const faceName = (d: Vec3): FaceName => FACES.find((f) => f.d[0] === Math.sign(d[0]) && f.d[1] === Math.sign(d[1]) && f.d[2] === Math.sign(d[2]))?.name ?? '上';

/** 選到的結構怎麼稱呼：一個＝名字；兩三個＝全部列出（「Si fin 1、Si fin 2」）；更多＝「HfO₂ ×4」。 */
export function namesOf(comps: { label: string; mat: number }[], matName: (id: number) => string) {
  if (!comps.length) return '';
  if (comps.length <= 3) return comps.map((c) => c.label).join('、');
  return `${matName(comps[0].mat)} ×${comps.length}`;
}

/** 被擋的那一格是誰：有結構名字（who）就用名字，否則用材質名。 */
const blockWho = (b: Block, matName: (id: number) => string, who?: string) => who ?? (b.mat !== undefined ? matName(b.mat) : '');

/** 完全鎖定（volume.ts 的 LOCK_FULL）。 */
const FULL = 255;

/** 「做不到」的原因（擋下來的那一刻）。 */
export function blockText(b: Block | null, matName: (id: number) => string, who?: string) {
  if (!b) return '';
  if (b.why === 'edge') return '已經到模型邊界';
  if (b.why === 'self') return '會碰到自己';
  if (b.why === 'min') return '已經沒有東西可以縮';
  if (b.why === 'lock') return b.keep === FULL ? `被完全鎖定的 ${blockWho(b, matName, who)} 擋住` : `${blockWho(b, matName, who)} 已經壓到它的最少厚度`;
  return `${blockWho(b, matName, who)} 在模型邊界只剩 1 格`;
}

/** 「最多可以做到哪裡」的說明（面板事先告知用）。 */
export function limitText(b: Block | null, matName: (id: number) => string, who?: string) {
  if (!b) return '';
  if (b.why === 'edge') return '到模型邊界為止';
  if (b.why === 'self') return '到碰到自己為止';
  if (b.why === 'min') return '到縮完為止';
  if (b.why === 'lock') return b.keep === FULL ? `到完全鎖定的 ${blockWho(b, matName, who)} 為止` : `到 ${blockWho(b, matName, who)} 壓到最少厚度為止`;
  return `到 ${blockWho(b, matName, who)} 在模型邊界剩 1 格為止`;
}

export const nmText = (n: number, nmPerVoxel: number) => `${(Math.abs(n) * nmPerVoxel).toFixed(1)} nm`;

export interface StepInfo {
  kind: 'push' | 'translate';
  /** 選到的結構怎麼稱呼（namesOf）。 */
  who: string;
  /** push：哪一面；translate：往哪邊搬（要求的方向）。 */
  face: FaceName;
  /** 要求的格數（push 帶正負號：正＝外推、負＝內縮；translate 為正）。 */
  n: number;
  /** 實際做了幾格。 */
  done: number;
  nmPerVoxel: number;
  /** 舊版欄位，不再使用。 */
  follow?: boolean;
  effects?: Effects;
  /** 完全鎖定、沒有跟著而留空的材質。 */
  gaps?: number[];
  /** 這一步之後整個消失的結構（名字）。 */
  gone?: string;
  stop?: Block | null;
  /** 擋住的那個結構的名字（有的話）。 */
  stopWho?: string;
}

/** 一步的說明，一句一個元素（plan v17 §5.5）；done = 0 時回傳空陣列（不進清單，用 blockedText）。 */
export function stepParts(s: StepInfo, matName: (id: number) => string): string[] {
  const k = Math.abs(s.done);
  if (!k) return [];
  const parts: string[] = [];
  const nm = nmText(k, s.nmPerVoxel);
  parts.push(s.kind === 'push' ? `${s.who} ${s.face}面${s.n > 0 ? '外推' : '內縮'} ${k} 格（${nm}）` : `${s.who} 往${s.face}搬 ${k} 格（${nm}）`);
  const names = (ms: number[]) => ms.map(matName).join('、');
  const e = s.effects;
  if (e) {
    if (e.follow.length) parts.push(`${names(e.follow)} 跟著移動 ${k} 格`);
    if (e.lost.length) parts.push(`${names(e.lost)} 變薄 ${k} 格`);
    if (e.gained.length) parts.push(`${names(e.gained)} 變厚 ${k} 格`);
    if (e.both.length) parts.push(`${names(e.both)} 一側變薄、另一側變厚 ${k} 格`);
  }
  if (s.gaps?.length) parts.push(`${names(s.gaps)} 完全鎖定、沒有跟著：中間留空`);
  if (s.gone) parts.push(`⚠ ${s.gone} 整個消失`);
  if (k < Math.abs(s.n) && s.stop && !(s.gone && s.stop.why === 'min')) parts.push(`只做了 ${k} 格：${blockText(s.stop, matName, s.stopWho)}`);
  return parts;
}

/** 一格都沒做：「擋下來了：Poly-Si 1 只剩 1 格」。 */
export const blockedText = (b: Block | null | undefined, matName: (id: number) => string, who?: string) => `擋下來了：${blockText(b ?? null, matName, who) || '這個方向做不到'}`;

/** 換材質的說明：「SiN 1 換成 SiGe（現在叫 SiGe 1）」。 */
export function materialParts(who: string, toName: string, nowName?: string) {
  return [`${who} 換成 ${toName}${nowName && nowName !== who ? `（現在叫 ${nowName}）` : ''}`];
}
