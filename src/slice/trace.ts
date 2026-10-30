// 描輪廓（plan v7 §10.1）：一片上「屬於已選結構」的格子 → 封閉的環（外環、內環），
// 頂點在格子角上（整數座標，格子 (u, v) 佔 [u, u+1]×[v, v+1]）。
// 再用 Douglas-Peucker 簡化成少數幾個頂點，每一段記下原始的折線，沒動的段重新光柵化逐格相同。

export type XY = [number, number];

export interface Ring {
  /** 簡化後的頂點（封閉，不重複第一點）。 */
  pts: XY[];
  /** raw[i]：pts[i] → pts[i+1] 之間原始的折線（含兩端）。 */
  raw: XY[][];
  /** 可以拖的節點（pts 的索引）：角。 */
  nodes: Set<number>;
  /** 內環（洞）。 */
  hole: boolean;
}

/** 多邊形有號面積（y 向下的座標裡外環是負的）。 */
export function signedArea(p: XY[]) {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i];
    const [x1, y1] = p[(i + 1) % p.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/**
 * 邊界鏈：每個 inside 格子和 outside 鄰居之間的邊，方向固定（inside 在同一側），接成封閉的折線。
 * 只留轉彎的點。回傳每條鏈的頂點（整數角座標）。
 */
export function boundaryLoops(inside: (u: number, v: number) => boolean, u0: number, v0: number, u1: number, v1: number): XY[][] {
  // 邊以起點為 key：起點 → 終點列表
  const W = u1 - u0 + 3;
  const key = (u: number, v: number) => (v - v0 + 1) * W + (u - u0 + 1);
  const out = new Map<number, XY[]>();
  const push = (a: XY, b: XY) => {
    const k = key(a[0], a[1]);
    const l = out.get(k);
    if (l) l.push(b);
    else out.set(k, [b]);
  };
  for (let v = v0; v <= v1; v++)
    for (let u = u0; u <= u1; u++) {
      if (!inside(u, v)) continue;
      if (!inside(u, v - 1)) push([u + 1, v], [u, v]);
      if (!inside(u, v + 1)) push([u, v + 1], [u + 1, v + 1]);
      if (!inside(u - 1, v)) push([u, v], [u, v + 1]);
      if (!inside(u + 1, v)) push([u + 1, v + 1], [u + 1, v]);
    }
  const loops: XY[][] = [];
  while (out.size) {
    const k0 = out.keys().next().value!;
    const start: XY = [((k0 % W) - 1 + u0), (Math.floor(k0 / W) - 1 + v0)];
    const pts: XY[] = [start];
    let cur = start;
    let prevDir: XY | null = null;
    for (;;) {
      const k = key(cur[0], cur[1]);
      const list = out.get(k);
      if (!list || !list.length) break;
      // 一個角有兩條出去的邊（斜對角的兩格）：選轉向那一格自己的那條，兩格各自成環（4 鄰接）
      let pick = 0;
      if (list.length > 1 && prevDir) {
        let best = Infinity;
        list.forEach((b, j) => {
          const d: XY = [b[0] - cur[0], b[1] - cur[1]];
          const cross = prevDir![0] * d[1] - prevDir![1] * d[0];
          if (cross < best) {
            best = cross;
            pick = j;
          }
        });
      }
      const nb = list.splice(pick, 1)[0];
      if (!list.length) out.delete(k);
      prevDir = [nb[0] - cur[0], nb[1] - cur[1]];
      cur = nb;
      if (cur[0] === start[0] && cur[1] === start[1]) break;
      pts.push(cur);
    }
    // 只留轉彎的點
    const corners: XY[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length];
      const b = pts[i];
      const c = pts[(i + 1) % pts.length];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) corners.push(b);
    }
    if (corners.length >= 3) loops.push(corners);
  }
  return loops;
}

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p: XY, a: XY, b: XY) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  if (!L) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Douglas-Peucker：開放折線，兩端固定；回傳留下的索引。 */
function dp(pts: XY[], eps: number, lo: number, hi: number, keep: number[]) {
  let best = -1;
  let bd = eps;
  for (let i = lo + 1; i < hi; i++) {
    const d = segDist(pts[i], pts[lo], pts[hi]);
    if (d > bd) {
      bd = d;
      best = i;
    }
  }
  if (best < 0) return;
  dp(pts, eps, lo, best, keep);
  keep.push(best);
  dp(pts, eps, best, hi, keep);
}

/** 封閉折線簡化：先在離起點最遠的點切兩段，各自 Douglas-Peucker；回傳留下的索引（遞增）。 */
export function simplifyClosed(pts: XY[], eps = 0.6): number[] {
  if (pts.length <= 4) return pts.map((_, i) => i);
  let far = 0;
  let fd = -1;
  pts.forEach((p, i) => {
    const d = dist(p, pts[0]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  });
  const loop = [...pts, pts[0]];
  const keep = [0];
  dp(loop, eps, 0, far, keep);
  keep.push(far);
  dp(loop, eps, far, pts.length, keep);
  return [...new Set(keep)].filter((i) => i < pts.length).sort((a, b) => a - b);
}

/** 沿封閉折線從 i 往前（dir = −1）或往後走 len 長度後的位置。 */
function walk(pts: XY[], i: number, dirn: 1 | -1, len: number): XY {
  let left = len;
  let cur = pts[i];
  let j = i;
  for (let guard = 0; guard < pts.length; guard++) {
    const k = (j + dirn + pts.length) % pts.length;
    const d = dist(cur, pts[k]);
    if (d >= left) {
      const t = left / d;
      return [cur[0] + (pts[k][0] - cur[0]) * t, cur[1] + (pts[k][1] - cur[1]) * t];
    }
    left -= d;
    cur = pts[k];
    j = k;
  }
  return cur;
}

/** 角：沿原始折線前後各走 reach 長度，夾角（轉向）≥ deg 度。 */
export function isCorner(loop: XY[], i: number, reach = 6, deg = 50) {
  const a = walk(loop, i, -1, reach);
  const c = walk(loop, i, 1, reach);
  const b = loop[i];
  const v1: XY = [b[0] - a[0], b[1] - a[1]];
  const v2: XY = [c[0] - b[0], c[1] - b[1]];
  const l = Math.hypot(...v1) * Math.hypot(...v2);
  if (!l) return false;
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / l;
  return Math.acos(Math.max(-1, Math.min(1, cos))) >= (deg * Math.PI) / 180;
}

/**
 * 一片上的環：inside(u, v) = 這格屬於結構；範圍 [u0..u1]×[v0..v1]（外面當 outside）。
 */
export function traceRings(inside: (u: number, v: number) => boolean, u0: number, v0: number, u1: number, v1: number, eps = 0.6): Ring[] {
  const test = (u: number, v: number) => u >= u0 && v >= v0 && u <= u1 && v <= v1 && inside(u, v);
  return boundaryLoops(test, u0, v0, u1, v1).map((loop) => {
    const keep = simplifyClosed(loop, eps);
    const pts = keep.map((i) => loop[i]);
    const raw: XY[][] = keep.map((i, k) => {
      const j = keep[(k + 1) % keep.length];
      const seg: XY[] = [];
      for (let t = i; ; t = (t + 1) % loop.length) {
        seg.push(loop[t]);
        if (t === j) break;
      }
      return seg;
    });
    const nodes = new Set<number>();
    keep.forEach((i, k) => {
      if (isCorner(loop, i)) nodes.add(k);
    });
    // 圓滑的環（沒有角）：至少給左右兩個把手
    if (nodes.size < 2) {
      let l = 0;
      let r = 0;
      pts.forEach((p, k) => {
        if (p[0] < pts[l][0]) l = k;
        if (p[0] > pts[r][0]) r = k;
      });
      nodes.add(l);
      nodes.add(r);
    }
    return { pts, raw, nodes, hole: signedArea(loop) > 0 };
  });
}

/** 環的完整折線（所有原始點）。 */
export const ringPolygon = (r: Ring): XY[] => r.raw.flatMap((seg) => seg.slice(0, -1));
