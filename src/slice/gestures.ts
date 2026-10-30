// 聰明游標（plan v7 §6）：熱區判斷、拖節點／推邊／搬區域的形狀、手勢 → Op。純函式，不碰 DOM。
import type { Axis, Backfill, Vec3 } from '../volume/volume';
import type { Op } from '../volume/ops';
import type { Scope } from '../volume/scope';
import { uvTo3D } from '../volume/scope';
import { encodeRle } from '../volume/profile';
import { type Ring, type XY, ringPolygon } from './trace';
import { deltaOf, editRing, rasterize } from './raster';

export type HandleKind = 'node' | 'edge' | 'region';
export interface Handle {
  kind: HandleKind;
  key: string;
  ring: number;
  /** node：pts 的索引；edge：段的索引（pts[i] → pts[i+1]）。 */
  index: number;
}

/** 熱區（螢幕像素，不隨縮放變）。 */
export const NODE_PX = 8;
export const EDGE_PX = 6;
/** 角：前後夾角 ≥ 50°（smoothEdgeGroup 停在角上）。 */

const segDist = (p: XY, a: XY, b: XY) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/**
 * 游標在 p（切面座標，格子角＝整數）時抓到什麼：節點 > 邊 > 區域。zoom = 每格幾個螢幕像素。
 * inside(key, u, v)：那一格是不是這個結構（區域判斷用）。only：按住 V／E／R 時只看一種。
 */
export function hitTest(
  rings: Map<string, Ring[]>,
  p: XY,
  zoom: number,
  inside: (key: string, u: number, v: number) => boolean,
  only?: HandleKind,
): Handle | null {
  const nodeR = NODE_PX / zoom;
  const edgeR = EDGE_PX / zoom;
  let best: Handle | null = null;
  let bd = Infinity;
  if (!only || only === 'node')
    for (const [key, rs] of rings)
      rs.forEach((r, ri) =>
        r.nodes.forEach((i) => {
          const d = Math.hypot(r.pts[i][0] - p[0], r.pts[i][1] - p[1]);
          if (d <= nodeR && d < bd) {
            bd = d;
            best = { kind: 'node', key, ring: ri, index: i };
          }
        }),
      );
  if (best) return best;
  if (!only || only === 'edge')
    for (const [key, rs] of rings)
      rs.forEach((r, ri) =>
        r.raw.forEach((seg, i) => {
          for (let k = 0; k + 1 < seg.length; k++) {
            const d = segDist(p, seg[k], seg[k + 1]);
            if (d <= edgeR && d < bd) {
              bd = d;
              best = { kind: 'edge', key, ring: ri, index: i };
            }
          }
        }),
      );
  if (best) return best;
  if (!only || only === 'region') {
    const u = Math.floor(p[0]);
    const v = Math.floor(p[1]);
    for (const key of rings.keys()) if (inside(key, u, v)) return { kind: 'region', key, ring: -1, index: -1 };
  }
  return null;
}

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

/** 拖動後每個頂點的位移（整數格）。 */
export function dragDisp(r: Ring, h: Handle, delta: XY, shift = false): XY[] {
  const n = r.pts.length;
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
    void n;
    return out;
  }
  return r.pts.map(() => [Math.round(delta[0]), Math.round(delta[1])]);
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

const DIR_WORD: Record<string, string> = { '0,-1': '往上', '0,1': '往下', '-1,0': '往左', '1,0': '往右' };
/** 切面上的方向 → 字（主要那一軸）。 */
export function uvWord(du: number, dv: number) {
  if (Math.abs(du) >= Math.abs(dv)) return du > 0 ? '往右' : '往左';
  return dv > 0 ? '往下' : '往上';
}

export interface GestureCtx {
  axis: Axis;
  /** 手勢做在哪一片。 */
  at: number;
  scope: Scope;
  follow: boolean;
  backfill: Backfill;
  /** 所有已選結構（區域拖動時一起搬）。 */
  selKeys: string[];
  /** 這個結構在這一片的格子（切面座標）。 */
  inside: (key: string, u: number, v: number) => boolean;
  /** 這個結構在這一片的外框（切面座標，含端點）。 */
  sliceBox: (key: string) => { u0: number; v0: number; u1: number; v1: number } | null;
  nm: number;
}

/**
 * 手勢 → Op（plan v7 §6.3）：
 * - 推了一條和軸平行、而且就是結構在那一側最外面、橫跨整個結構的直邊 → push
 * - 搬了整個剖面 → translate（多選時每個結構各自搬）
 * - 其他（節點、斜邊、圓弧、部分邊、Shift 單段）→ profile
 * 沒有任何改動回傳 null。
 */
export function gestureToOp(rings: Map<string, Ring[]>, h: Handle, delta: XY, shift: boolean, g: GestureCtx): Op | null {
  const keys = h.kind === 'region' ? g.selKeys : [h.key];
  if (h.kind === 'region') {
    const du = Math.round(delta[0]);
    const dv = Math.round(delta[1]);
    if (!du && !dv) return null;
    return { kind: 'translate', keys, scope: g.scope, d: uvTo3D(g.axis, du, dv), backfill: g.backfill, follow: g.follow };
  }
  const r = rings.get(h.key)![h.ring];
  if (h.kind === 'edge') {
    const group = smoothEdgeGroup(r, h.index, shift);
    const nrm = groupNormal(r, group);
    const n = edgeAmount(r, h, delta, shift);
    if (!n) return null;
    const box = g.sliceBox(h.key);
    const axisN = Math.abs(nrm[0]) > 0.999 || Math.abs(nrm[1]) > 0.999;
    if (axisN && !shift && isAxisEdge(r, group) && box && !r.hole) {
      const du = Math.round(nrm[0]);
      const dv = Math.round(nrm[1]);
      const us = group.map((i) => r.pts[i][0]);
      const vs = group.map((i) => r.pts[i][1]);
      // 最外側：上邊 v = v0、下邊 v = v1+1、左邊 u = u0、右邊 u = u1+1；而且橫跨整個結構
      const outer = dv < 0 ? vs[0] === box.v0 : dv > 0 ? vs[0] === box.v1 + 1 : du < 0 ? us[0] === box.u0 : us[0] === box.u1 + 1;
      const span = dv ? Math.min(...us) === box.u0 && Math.max(...us) === box.u1 + 1 : Math.min(...vs) === box.v0 && Math.max(...vs) === box.v1 + 1;
      if (outer && span) {
        const dir: Vec3 = uvTo3D(g.axis, du, dv);
        return { kind: 'push', keys, scope: g.scope, dir, n, follow: g.follow, backfill: g.backfill };
      }
    }
  }
  const disp = dragDisp(r, h, delta, shift);
  if (disp.every((d) => !d[0] && !d[1])) return null;
  const perKey = profileDelta(rings.get(h.key)!, h.ring, disp, (u, v) => g.inside(h.key, u, v));
  if (!perKey) return null;
  const text =
    h.kind === 'node'
      ? `${shift ? '單點' : '節點'}${uvWord(Math.round(delta[0]), Math.round(delta[1]))}移 (${Math.round(delta[0])}, ${Math.round(delta[1])})`
      : `${shift ? '單段' : '邊'}往${edgeAmount(r, h, delta, shift) > 0 ? '外' : '內'} ${Math.abs(edgeAmount(r, h, delta, shift))} vx（${(Math.abs(edgeAmount(r, h, delta, shift)) * g.nm).toFixed(1)} nm）`;
  return { kind: 'profile', keys, scope: g.scope, at: g.at, perKey: { [h.key]: perKey }, follow: g.follow, backfill: g.backfill, text };
}

/** 一個結構的環（第 ring 個改了 disp）→ 這一片要加、要拿的格子（RLE）。沒有改到回傳 null。 */
export function profileDelta(rs: Ring[], ring: number, disp: XY[], inside: (u: number, v: number) => boolean) {
  const after = rs.map((r, i) => (i === ring ? editRing(r, disp) : ringPolygon(r)));
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of [...after, ...rs.map(ringPolygon)])
    for (const [u, v] of p) {
      u0 = Math.min(u0, Math.floor(u) - 1);
      v0 = Math.min(v0, Math.floor(v) - 1);
      u1 = Math.max(u1, Math.ceil(u) + 1);
      v1 = Math.max(v1, Math.ceil(v) + 1);
    }
  const W = u1 - u0 + 1;
  const H = v1 - v0 + 1;
  const before = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u + u0, v + v0)) before[v * W + u] = 1;
  const aft = rasterize(after, u0, v0, W, H);
  const { add, remove } = deltaOf(before, aft, u0, v0, W, H);
  if (!add.length && !remove.length) return null;
  return { add: encodeRle(add), remove: encodeRle(remove) };
}

export { DIR_WORD };
