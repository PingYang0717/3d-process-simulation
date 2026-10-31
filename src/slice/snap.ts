// 拖拉中的位移（plan v8 §7.2）：dragDispFloat＝不取整、跟手的 ghost；dragDisp＝放開時（和拖拉中第二層預覽）用的整數位移。
// dragDisp 搬自 gestures.ts、行為不變（v7 的 Op 逐欄相同）：先把手勢的量取整（節點的位移、邊沿法線的格數），再乘權重取整。
// 所以 snap 是「取手勢的量」而不是逐頂點四捨五入浮點位移——後者在衰減的地方會差一格。
import type { Ring, XY } from './trace';
import type { Handle } from './gestures';

/** 段 i 往兩側走到節點（角）為止：回傳這一組的頂點索引（含兩端的角）。single = 只要這一段。 */
export function smoothEdgeGroup(r: Ring, seg: number, single = false): number[] {
  const n = r.pts.length;
  if (single) return [seg, (seg + 1) % n];
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

/** 拖動後每個頂點的位移（整數格）＝snap：放開後 commit 的、拖拉中第二層顯示的。 */
export function dragDisp(r: Ring, h: Handle, delta: XY, shift = false): XY[] {
  const zero = (): XY[] => r.pts.map(() => [0, 0]);
  if (h.kind === 'node') {
    const d: XY = [Math.round(delta[0]), Math.round(delta[1])];
    if (shift) {
      const out = zero();
      out[h.index] = d;
      return out;
    }
    const w = falloffWeights(r, h.index);
    return w.map((k) => [Math.round(d[0] * k), Math.round(d[1] * k)]);
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

/** 拖動中每個頂點的浮點位移（ghost 用，同一套衰減／法線規則，不取整）。 */
export function dragDispFloat(r: Ring, h: Handle, delta: XY, shift = false): XY[] {
  if (h.kind === 'node') {
    if (shift) {
      const out: XY[] = r.pts.map(() => [0, 0]);
      out[h.index] = [delta[0], delta[1]];
      return out;
    }
    return falloffWeights(r, h.index).map((k) => [delta[0] * k, delta[1] * k]);
  }
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
export function snapAmount(r: Ring | undefined, h: Handle, delta: XY, shift = false): { raw: XY; snapped: XY; amount?: { raw: number; snapped: number } } {
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
export function edgeAmount(r: Ring, h: Handle, delta: XY, shift = false) {
  const nrm = groupNormal(r, smoothEdgeGroup(r, h.index, shift));
  return Math.round(delta[0] * nrm[0] + delta[1] * nrm[1]);
}

