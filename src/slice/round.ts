// 圓頭（plan v10 §4.6，M10.6）：帶參數的頭型——哪些角、半徑（可不對稱 ru／rv，rv 介面上叫肩高）、
// 方圓度 n（超橢圓指數：1 斜切、2 正圓、越大越方）、凹角（內圓角，往外填）、只削／只填／對齊。
// 存成 profile Op（kind 'profile'），rounds[key] 是 RoundGesture：每一片用自己的外框重算（永遠對得到、沒有 fallback），
// 之後和 profile 一樣先拿再加、由近到遠、要 4 鄰接、kernel 規則、襯層跟著；apply.ts 不必改。
import type { Axis, Backfill, Labeled, Volume } from '../volume/volume';
import type { Scope } from '../volume/scope';
import { type ProfileCell, encodeRle } from '../volume/rle';
import type { ProfileOp } from '../volume/profile';
import type { XY } from './trace';
import { deltaOf } from './raster';
import { sliceOfKey } from './model';

/** 角：u 往右、v 往下；ul = (u0, v0) 那個角。 */
export type CornerId = 'ul' | 'ur' | 'll' | 'lr';

export interface RoundGesture {
  kind: 'round';
  /** 哪些角；concave = 內圓角（在角外側、貼著側壁往外填，只填空氣——kernel 決定）。 */
  corners: { id: CornerId; concave?: boolean }[];
  /** 半徑（格）；ru／rv 沒給＝r。rv 在介面上叫「肩高」（弧從離頂 rv 處開始）。 */
  r: number;
  ru?: number;
  rv?: number;
  /** 方圓度（超橢圓指數）：1 斜切、2 正圓、8 幾乎方。 */
  n: number;
  /** 對齊到目標形狀（削＋填）／只削／只填。 */
  mode: 'cut' | 'fill' | 'match';
}

export type RoundBox = { u0: number; v0: number; u1: number; v1: number };

/** 角的方向：su = −1 左、+1 右；sv = −1 上、+1 下。 */
const SIGN: Record<CornerId, [number, number]> = { ul: [-1, -1], ur: [1, -1], lr: [1, 1], ll: [-1, 1] };
/** 順時針（u 右 v 下的畫面上）走外框的角順序。 */
const ORDER: CornerId[] = ['ul', 'ur', 'lr', 'll'];

/** 這個外框上實際用的半徑：外圓角夾到半寬／半高；內圓角的 rv 夾到整個高、ru 不夾。 */
export function roundRadii(box: RoundBox, g: RoundGesture, concave = false): { ru: number; rv: number } {
  const W = box.u1 - box.u0 + 1;
  const H = box.v1 - box.v0 + 1;
  const ru = Math.max(0, g.ru ?? g.r);
  const rv = Math.max(0, g.rv ?? g.r);
  return concave ? { ru, rv: Math.min(rv, H) } : { ru: Math.min(ru, W / 2), rv: Math.min(rv, H / 2) };
}

/** 半徑上限（外圓角）：min(半寬, 半高)，給面板夾住並提示用。 */
export const roundLimit = (box: RoundBox) => Math.min((box.u1 - box.u0 + 1) / 2, (box.v1 - box.v0 + 1) / 2);

/** 角點 K（格子角座標）與弧的圓心 C：外圓角圓心在往內 (ru, rv)；內圓角在外側、貼著側壁（u 往外、v 往內）。 */
function cornerGeom(box: RoundBox, id: CornerId, ru: number, rv: number, concave: boolean) {
  const [su, sv] = SIGN[id];
  const K: XY = [su < 0 ? box.u0 : box.u1 + 1, sv < 0 ? box.v0 : box.v1 + 1];
  const C: XY = concave ? [K[0] + su * ru, K[1] - sv * rv] : [K[0] - su * ru, K[1] - sv * rv];
  return { K, C };
}

/** 超橢圓 |a|^n + |b|^n（a、b 已正規化到 [0, 1]）。 */
const superE = (a: number, b: number, n: number) => Math.pow(a, n) + Math.pow(b, n);

/** 結構在 [u0..u1]×[v0..v1] 裡的外框（含端點）；沒有回傳 null。 */
function scanBox(inside: (u: number, v: number) => boolean, u0: number, v0: number, u1: number, v1: number): RoundBox | null {
  let a0 = Infinity;
  let b0 = Infinity;
  let a1 = -Infinity;
  let b1 = -Infinity;
  for (let v = v0; v <= v1; v++)
    for (let u = u0; u <= u1; u++)
      if (inside(u, v)) {
        if (u < a0) a0 = u;
        if (u > a1) a1 = u;
        if (v < b0) b0 = v;
        if (v > b1) b1 = v;
      }
  return a0 <= a1 ? { u0: a0, v0: b0, u1: a1, v1: b1 } : null;
}

/**
 * 這一片的圓頭：inside(u, v) = 這一片的結構；[u0..u1]×[v0..v1] 是找結構外框的範圍。
 * 只改被勾的角附近（ru×rv 的角區），不會把整個外框補成矩形（L 形不會被填滿）。
 * 回傳要加、要拿的格子（切面座標，帶方向碼，加的由近到遠；和 relativeCells 同一套格式）；這一片沒有結構回傳 null。
 */
export function roundCells(
  inside: (u: number, v: number) => boolean,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  g: RoundGesture,
): { add: ProfileCell[]; remove: ProfileCell[] } | null {
  const box = scanBox(inside, u0, v0, u1, v1);
  if (!box) return null;
  const n = Math.max(0.1, g.n);
  const doCut = g.mode !== 'fill';
  const doFill = g.mode !== 'cut';
  // 視窗：外框往外留內圓角的半徑＋1 圈（拿的格子要從外面 BFS 走進來）
  let m = 1;
  for (const c of g.corners)
    if (c.concave) {
      const { ru, rv } = roundRadii(box, g, true);
      m = Math.max(m, Math.ceil(Math.max(ru, rv)) + 1);
    }
  const a0 = box.u0 - m;
  const b0 = box.v0 - m;
  const W = box.u1 - box.u0 + 1 + 2 * m;
  const H = box.v1 - box.v0 + 1 + 2 * m;
  const before = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u + a0, v + b0)) before[v * W + u] = 1;
  const after = before.slice();
  for (const c of g.corners) {
    const concave = !!c.concave;
    const { ru, rv } = roundRadii(box, g, concave);
    if (ru <= 0 || rv <= 0) continue;
    const { K, C } = cornerGeom(box, c.id, ru, rv, concave);
    // 角區：K 與 C 之間的矩形（格子中心在裡面才算）；a、b = 從圓心往角點正規化的距離（0, 1]
    const uLo = Math.floor(Math.min(K[0], C[0]));
    const uHi = Math.ceil(Math.max(K[0], C[0])) - 1;
    const vLo = Math.floor(Math.min(K[1], C[1]));
    const vHi = Math.ceil(Math.max(K[1], C[1])) - 1;
    const zone: { i: number; out: boolean }[] = [];
    let any = false;
    for (let v = vLo; v <= vHi; v++)
      for (let u = uLo; u <= uHi; u++) {
        const a = (u + 0.5 - C[0]) / (K[0] - C[0]);
        const b = (v + 0.5 - C[1]) / (K[1] - C[1]);
        if (!(a > 0 && a <= 1 && b > 0 && b <= 1)) continue;
        const i = (v - b0) * W + (u - a0);
        if (before[i]) any = true;
        zone.push({ i, out: superE(a, b, n) > 1 });
      }
    if (concave) {
      // 內圓角：角區裡、四分之一圓外面（靠角點那一側）的空格子補上
      if (doFill) for (const z of zone) if (z.out && !before[z.i]) after[z.i] = 1;
    } else {
      for (const z of zone) {
        if (z.out && before[z.i] && doCut) after[z.i] = 0;
        // 角區裡完全沒有結構（例如 L 形缺的那個角）就不填：沒有東西可以圓
        if (!z.out && !before[z.i] && doFill && any) after[z.i] = 1;
      }
    }
  }
  return deltaOf(before, after, a0, b0, W, H);
}

/** 一個 key 在參考片上的圓頭格子（builder 與統計共用）。 */
function keyCells(L: Labeled, vol: Volume, axis: Axis, at: number, key: string, g: RoundGesture) {
  const s = sliceOfKey(L, vol, axis, at, key);
  if (!s) return null;
  const c = roundCells(s.inside, s.u0, s.v0, s.u1, s.v1, g);
  return c ? { ...c, box: scanBox(s.inside, s.u0, s.v0, s.u1, s.v1)! } : null;
}

const CORNER_WORD: Record<CornerId, string> = { ul: '左上角', ur: '右上角', ll: '左下角', lr: '右下角' };
/** 「上面兩個角」「四個角」「左上角、右下角」 */
function cornersWord(ids: CornerId[]) {
  const s = new Set(ids);
  if (s.size === 4) return '四個角';
  if (s.size === 2) {
    if (s.has('ul') && s.has('ur')) return '上面兩個角';
    if (s.has('ll') && s.has('lr')) return '下面兩個角';
    if (s.has('ul') && s.has('ll')) return '左邊兩個角';
    if (s.has('ur') && s.has('lr')) return '右邊兩個角';
  }
  return ORDER.filter((id) => s.has(id))
    .map((id) => CORNER_WORD[id])
    .join('、');
}

const fmt = (x: number) => (Number.isInteger(x) ? `${x}` : x.toFixed(1));

/** 一句話：「上面兩個角圓角 r = 6（3.0 nm）、n = 2」。 */
export function roundText(g: RoundGesture, nm?: number) {
  const len = (x: number) => (nm ? `${fmt(x)}（${(x * nm).toFixed(1)} nm）` : fmt(x));
  const convex = g.corners.filter((c) => !c.concave).map((c) => c.id);
  const concave = g.corners.filter((c) => c.concave).map((c) => c.id);
  const parts: string[] = [];
  if (convex.length) parts.push(`${cornersWord(convex)}圓角`);
  if (concave.length) parts.push(`${cornersWord(concave)}內圓角`);
  const ru = g.ru ?? g.r;
  const rv = g.rv ?? g.r;
  const r = ru === rv ? `r = ${len(ru)}` : `ru = ${len(ru)}、肩高 rv = ${len(rv)}`;
  const mode = g.mode === 'cut' ? '（只削）' : g.mode === 'fill' ? '（只填）' : '';
  return `${parts.join('、') || '圓頭'} ${r}、n = ${fmt(g.n)}${mode}`;
}

/** 參考片上的統計（面板上「削 1,240 格、填 0 格」）：cut／fill = 格數；limit = 半徑上限（各 key 外框的 min(半寬, 半高) 取最小）；clamped = 有被夾住的半徑。 */
export interface RoundStats {
  cut: number;
  fill: number;
  limit: number;
  clamped: boolean;
}

/**
 * 圓頭的 Op 與參考片統計一次算好（plan v14 P5：面板不再為統計多算一次 roundCells）。
 * op：每個 key 在參考片 at 上算一份絕對的 add／remove，rounds[key] = g（其他片用自己的外框重算），refExact；沒有任何格子會變＝null。
 */
export function roundBuild(
  L: Labeled,
  vol: Volume,
  keys: string[],
  scope: Scope,
  at: number,
  g: RoundGesture,
  follow: boolean,
  backfill: Backfill,
  nm?: number,
): { op: ProfileOp | null; stats: RoundStats } {
  const perKey: ProfileOp['perKey'] = {};
  const rounds: Record<string, RoundGesture> = {};
  let any = false;
  let cut = 0;
  let fill = 0;
  let limit = Infinity;
  for (const key of keys) {
    const c = keyCells(L, vol, scope.axis, at, key, g);
    if (!c) continue;
    if (c.add.length || c.remove.length) any = true;
    perKey[key] = { add: encodeRle(c.add), remove: encodeRle(c.remove) };
    rounds[key] = g;
    cut += c.remove.length;
    fill += c.add.length;
    limit = Math.min(limit, roundLimit(c.box));
  }
  const want = Math.max(g.ru ?? g.r, g.rv ?? g.r);
  const stats = { cut, fill, limit: Number.isFinite(limit) ? limit : 0, clamped: Number.isFinite(limit) && g.corners.some((c) => !c.concave) && want > limit };
  if (!any) return { op: null, stats };
  const ks = keys.filter((k) => perKey[k]);
  return { op: { kind: 'profile', keys: ks, scope, at, perKey, follow, backfill, text: roundText(g, nm), rounds, refExact: true }, stats };
}

/** 產生圓頭 Op（2D、3D 的面板、把手、右鍵、實驗頁都呼叫這一個）。沒有任何格子會變回傳 null。 */
export function roundOp(
  L: Labeled,
  vol: Volume,
  keys: string[],
  scope: Scope,
  at: number,
  g: RoundGesture,
  follow: boolean,
  backfill: Backfill,
  nm?: number,
): ProfileOp | null {
  return roundBuild(L, vol, keys, scope, at, g, follow, backfill, nm).op;
}

/** 只要參考片統計（測試與舊呼叫端）。 */
export function roundStats(L: Labeled, vol: Volume, keys: string[], axis: Axis, at: number, g: RoundGesture): RoundStats {
  return roundBuild(L, vol, keys, { axis, lo: at, hi: at }, at, g, false, 'orig').stats;
}

/**
 * 目標外框的多邊形（面板小圖用；格子角座標，u 右 v 下，順時針）：box 的矩形，被勾的角換成超橢圓弧
 * x = ru·cos^(2/n) t、y = rv·sin^(2/n) t；內圓角往外補一段貼著側壁的弧。每格弧長至少 2 個點。
 */
export function roundOutline(box: RoundBox, g: RoundGesture): XY[] {
  const n = Math.max(0.1, g.n);
  const e = 2 / n;
  const pts: XY[] = [];
  const byId = new Map(g.corners.map((c) => [c.id, c]));
  for (const id of ORDER) {
    const c = byId.get(id);
    const concave = !!c?.concave;
    const { ru, rv } = c ? roundRadii(box, g, concave) : { ru: 0, rv: 0 };
    const { K, C } = cornerGeom(box, id, ru, rv, concave);
    if (!c || ru <= 0 || rv <= 0) {
      pts.push(K);
      continue;
    }
    const [su, sv] = SIGN[id];
    const N = Math.max(4, Math.ceil(2 * (ru + rv)));
    // ul、lr：t 由 0 到 π/2；ur、ll：反過來（順時針走）
    const up = id === 'ul' || id === 'lr';
    for (let k = 0; k <= N; k++) {
      const t = ((up ? k : N - k) / N) * (Math.PI / 2);
      const x = ru * Math.pow(Math.cos(t), e);
      const y = rv * Math.pow(Math.sin(t), e);
      pts.push(concave ? [C[0] - su * x, C[1] + sv * y] : [C[0] + su * x, C[1] + sv * y]);
    }
  }
  return pts;
}
