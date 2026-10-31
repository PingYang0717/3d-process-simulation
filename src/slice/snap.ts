// 拖拉中的位移（plan v8 §7.2）：dragDispFloat＝不取整、跟手的 ghost；dragDisp＝放開時（和拖拉中第二層預覽）用的整數位移。
// dragDisp 搬自 gestures.ts；衰減（falloff）那條路和 v7 逐欄相同，v10 加了 corner／single（預設依形狀自動選）：先把手勢的量取整（節點的位移、邊沿法線的格數），再乘權重取整。
// 所以 snap 是「取手勢的量」而不是逐頂點四捨五入浮點位移——後者在衰減的地方會差一格。
import type { Ring, XY } from './trace';
import type { Handle } from './gestures';

/**
 * 節點的拖法（plan v10 §4.2、D6）：
 * - corner：像拖矩形的角。兩側直邊各自整條平移（橫邊沿 v、直邊沿 u），遠端的角只沿一軸動，拖完四邊仍和軸平行。
 * - single：只動這一點，相鄰兩段是直線。
 * - falloff：v7～v9 的 cos 衰減（節點到左右兩個角之間的頂點一起跟著走）；Alt＋拖。
 */
export type NodeDrag = 'corner' | 'single' | 'falloff';
/** auto＝依局部形狀自動選：兩側都是和軸平行的直邊 → corner，否則 single。 */
export type DragMode = NodeDrag | 'auto';
/** 舊呼叫端傳布林（shift／single）：true ≡ single、false ≡ auto。 */
export type DragArg = boolean | DragMode | undefined;

/** 這個參數是不是「只動這一點／這一段」（邊把手只看這個）。 */
export const isSingle = (mode: DragArg) => mode === true || mode === 'single';
/** 布林 → 拖法（true ≡ single、false／undefined ≡ auto）。 */
export const dragModeOf = (mode: DragArg): DragMode => (mode === true ? 'single' : mode === false || mode === undefined ? 'auto' : mode);

/** 節點往 step（±1）那一側走到下一個節點：回傳沿途的頂點索引（不含自己、含遠端的角）。 */
function sidePath(r: Ring, node: number, step: number): number[] {
  const n = r.pts.length;
  const out: number[] = [];
  let i = node;
  for (let g = 0; g < n; g++) {
    i = (i + step + n) % n;
    if (i === node) break;
    out.push(i);
    if (r.nodes.has(i)) break;
  }
  return out;
}

/** 節點一側的直邊方向：'h'＝橫邊（同一個 v）、'v'＝直邊（同一個 u）、null＝不是和軸平行的直邊（弧、斜邊）。 */
function sideAxis(r: Ring, node: number, step: number): 'h' | 'v' | null {
  const path = sidePath(r, node, step);
  // 只有一個角（走一圈都沒碰到別的角）：不算直邊
  if (!path.length || !r.nodes.has(path[path.length - 1])) return null;
  const [u0, v0] = r.pts[node];
  if (path.every((i) => r.pts[i][1] === v0)) return 'h';
  if (path.every((i) => r.pts[i][0] === u0)) return 'v';
  return null;
}

/** 這個節點兩側是不是都是和軸平行的直邊（而且一橫一直）：預設拖法用 corner。 */
export function isAxisCorner(r: Ring, node: number) {
  const a = sideAxis(r, node, 1);
  const b = sideAxis(r, node, -1);
  return !!a && !!b && a !== b;
}

/** 節點實際用的拖法：auto（或 false）依局部形狀選 corner／single；true ≡ single。 */
export function resolveNodeDrag(r: Ring, node: number, mode: DragArg = 'auto'): NodeDrag {
  const m = dragModeOf(mode);
  if (m !== 'auto') return m;
  return isAxisCorner(r, node) ? 'corner' : 'single';
}

/** 節點拖動的浮點位移（三種拖法共用；dragDisp 傳已取整的 d、dragDispFloat 傳原始的 delta）。 */
function nodeDisp(r: Ring, node: number, d: XY, drag: NodeDrag, round: boolean): XY[] {
  const out: XY[] = r.pts.map(() => [0, 0]);
  if (drag === 'falloff') {
    const w = falloffWeights(r, node);
    return w.map((k) => (round ? [Math.round(d[0] * k), Math.round(d[1] * k)] : [d[0] * k, d[1] * k]));
  }
  out[node] = [d[0], d[1]];
  if (drag === 'single') return out;
  // corner：橫邊整條沿 v 平移 d[1]、直邊整條沿 u 平移 d[0]（含遠端的角）；不是直邊的那一側只動節點自己
  for (const step of [1, -1]) {
    const ax = sideAxis(r, node, step);
    if (!ax) continue;
    for (const i of sidePath(r, node, step)) {
      if (ax === 'h') out[i][1] = d[1];
      else out[i][0] = d[0];
    }
  }
  out[node] = [d[0], d[1]];
  return out;
}

/** 段 i 往兩側走到節點（角）為止：回傳這一組的頂點索引（含兩端的角）。single（true 或 'single'）= 只要這一段。 */
export function smoothEdgeGroup(r: Ring, seg: number, single: DragArg = false): number[] {
  const n = r.pts.length;
  if (isSingle(single)) return [seg, (seg + 1) % n];
  let a = seg;
  for (let g = 0; g < n && !r.nodes.has(a); g++) a = (a - 1 + n) % n;
  let b = (seg + 1) % n;
  for (let g = 0; g < n && !r.nodes.has(b); g++) b = (b + 1) % n;
  const out = [a];
  for (let i = a; i !== b; ) {
    i = (i + 1) % n;
    out.push(i);
  }
  return out;
}

/** 一組頂點（連續）的平均外法線（單位向量）。外＝離開結構那一側（內環是往洞裡）。 */
export function groupNormal(r: Ring, group: number[]): XY {
  let nx = 0;
  let ny = 0;
  for (let k = 0; k + 1 < group.length; k++) {
    const a = r.pts[group[k]];
    const b = r.pts[group[k + 1]];
    nx += -(b[1] - a[1]);
    ny += b[0] - a[0];
  }
  const l = Math.hypot(nx, ny) || 1;
  return [nx / l, ny / l];
}

/** 節點拖動時，它和左右兩個節點之間的頂點依 cos 衰減跟著走；回傳每個頂點的權重。 */
export function falloffWeights(r: Ring, node: number): number[] {
  const n = r.pts.length;
  const w = new Array(n).fill(0);
  w[node] = 1;
  for (const step of [1, -1]) {
    // 走到下一個節點，沿途累積長度
    const path: number[] = [];
    const lens: number[] = [0];
    let i = node;
    for (let g = 0; g < n; g++) {
      const j = (i + step + n) % n;
      lens.push(lens[lens.length - 1] + Math.hypot(r.pts[j][0] - r.pts[i][0], r.pts[j][1] - r.pts[i][1]));
      path.push(j);
      i = j;
      if (r.nodes.has(j)) break;
    }
    const L = lens[lens.length - 1] || 1;
    path.forEach((j, k) => {
      if (r.nodes.has(j)) return;
      w[j] = Math.max(w[j], 0.5 * (1 + Math.cos((Math.PI * lens[k + 1]) / L)));
    });
  }
  return w;
}

/**
 * 拖動後每個頂點的位移（整數格）＝snap：放開後 commit 的、拖拉中第二層顯示的。
 * shift：節點的拖法（true ≡ single、false ≡ auto，見 resolveNodeDrag）；邊只看是不是 single（只推這一段）。
 */
export function dragDisp(r: Ring, h: Handle, delta: XY, shift: DragArg = false): XY[] {
  const zero = (): XY[] => r.pts.map(() => [0, 0]);
  if (h.kind === 'node') {
    const d: XY = [Math.round(delta[0]), Math.round(delta[1])];
    return nodeDisp(r, h.index, d, resolveNodeDrag(r, h.index, shift), true);
  }
  if (h.kind === 'edge') {
    const group = smoothEdgeGroup(r, h.index, shift);
    const nrm = groupNormal(r, group);
    const amt = Math.round(delta[0] * nrm[0] + delta[1] * nrm[1]);
    const out = zero();
    const straight = isAxisEdge(r, group);
    group.forEach((i, k) => {
      // 兩端的角是錨點（彎的邊）；和軸平行的直邊整段一起推（＝推面）
      if (!straight && (k === 0 || k === group.length - 1) && group.length > 2) return;
      out[i] = [Math.round(nrm[0] * amt), Math.round(nrm[1] * amt)];
    });
    return out;
  }
  return r.pts.map(() => [Math.round(delta[0]), Math.round(delta[1])]);
}

/** 拖動中每個頂點的浮點位移（ghost 用，同一套拖法／法線規則，不取整）。 */
export function dragDispFloat(r: Ring, h: Handle, delta: XY, shift: DragArg = false): XY[] {
  if (h.kind === 'node') return nodeDisp(r, h.index, delta, resolveNodeDrag(r, h.index, shift), false);
  if (h.kind === 'edge') {
    const group = smoothEdgeGroup(r, h.index, shift);
    const nrm = groupNormal(r, group);
    const amt = delta[0] * nrm[0] + delta[1] * nrm[1];
    const out: XY[] = r.pts.map(() => [0, 0]);
    const straight = isAxisEdge(r, group);
    group.forEach((i, k) => {
      if (!straight && (k === 0 || k === group.length - 1) && group.length > 2) return;
      out[i] = [nrm[0] * amt, nrm[1] * amt];
    });
    return out;
  }
  return r.pts.map(() => [delta[0], delta[1]]);
}

/** 手勢的量：浮點 → 放開後取的整數（節點／區域＝位移，邊＝沿法線格數）。提示文字「(+1.6, −2.3) → 取 (+2, −2)」用。 */
export function snapAmount(r: Ring | undefined, h: Handle, delta: XY, shift: DragArg = false): { raw: XY; snapped: XY; amount?: { raw: number; snapped: number } } {
  const snapped: XY = [Math.round(delta[0]), Math.round(delta[1])];
  if (h.kind !== 'edge' || !r) return { raw: delta, snapped };
  const nrm = groupNormal(r, smoothEdgeGroup(r, h.index, shift));
  const raw = delta[0] * nrm[0] + delta[1] * nrm[1];
  return { raw: delta, snapped, amount: { raw, snapped: Math.round(raw) } };
}

/** 這一組頂點是不是一條和軸平行的直邊（所有點同一個 u 或同一個 v）。 */
export function isAxisEdge(r: Ring, group: number[]) {
  const us = new Set(group.map((i) => r.pts[i][0]));
  const vs = new Set(group.map((i) => r.pts[i][1]));
  return us.size === 1 || vs.size === 1;
}

/** 邊拖動的量（沿法線幾格）。 */
export function edgeAmount(r: Ring, h: Handle, delta: XY, shift: DragArg = false) {
  const nrm = groupNormal(r, smoothEdgeGroup(r, h.index, shift));
  return Math.round(delta[0] * nrm[0] + delta[1] * nrm[1]);
}


/** 兩段嚴格相交（端點相碰、共線重疊不算）。 */
const crosses = (a: XY, b: XY, c: XY, d: XY) => {
  const o = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
};

/**
 * 封閉多邊形是不是自交（O(n²)；拖拉中檢查 editRing 的結果，自交的輪廓光柵化時偶奇規則會挖出洞）。
 * 點數超過 max 不檢查，回傳 null。
 */
export function selfIntersects(poly: XY[], max = 200): boolean | null {
  const n = poly.length;
  if (n > max) return null;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // 首尾相鄰
      if (crosses(a, b, poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}
