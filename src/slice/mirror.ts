// 對應到長得一樣的結構（plan v7 §7.7、§10.5）：多選時，在一個結構上做的手勢，
// 對其他結構找對應的節點／邊（座標正規化到各自外框的 [0,1]²），一起做成一個 Op。
// 保險：只對同材質、外框長寬比相差 ≤ 20%、面積相差 ≤ 30% 的結構配對；配不到的不動並回報。
import type { Op } from '../volume/ops';
import type { Rle2D } from '../volume/rle';
import type { Ring, XY } from './trace';
import { type GestureCtx, type Handle, dragDisp, edgeAmount, gestureToOp, groupNormal, profileDelta, smoothEdgeGroup } from './gestures';
import { type RelGesture, recordGesture } from './relative';

export const NODE_TOL = 0.12;
export const EDGE_TOL = 0.2;

export interface Shape {
  /** 這一片上的外框（切面座標，含端點）。 */
  box: { u0: number; v0: number; u1: number; v1: number };
  mat: number;
  /** 這一片上的格數。 */
  area: number;
}

const norm = (s: Shape, p: XY): XY => [(p[0] - s.box.u0) / (s.box.u1 - s.box.u0 + 1), (p[1] - s.box.v0) / (s.box.v1 - s.box.v0 + 1)];

/** 保險條件：同材質、長寬比 ≤ 20%、面積 ≤ 30%。 */
export function alike(a: Shape, b: Shape) {
  if (a.mat !== b.mat) return false;
  const ra = (a.box.u1 - a.box.u0 + 1) / (a.box.v1 - a.box.v0 + 1);
  const rb = (b.box.u1 - b.box.u0 + 1) / (b.box.v1 - b.box.v0 + 1);
  if (Math.abs(ra - rb) / Math.max(ra, rb) > 0.2) return false;
  return Math.abs(a.area - b.area) / Math.max(a.area, b.area) <= 0.3;
}

/** 其他結構上對應的把手；配不到的是 null。 */
export function counterparts(rings: Map<string, Ring[]>, h: Handle, shapes: Map<string, Shape>): Map<string, Handle | null> {
  const out = new Map<string, Handle | null>();
  const src = shapes.get(h.key);
  const sr = rings.get(h.key)?.[h.ring];
  if (!src || !sr) return out;
  for (const [key, rs] of rings) {
    if (key === h.key) continue;
    const sh = shapes.get(key);
    if (!sh || !alike(src, sh)) {
      out.set(key, null);
      continue;
    }
    let best: Handle | null = null;
    let bd = Infinity;
    if (h.kind === 'node') {
      const p = norm(src, sr.pts[h.index]);
      rs.forEach((r, ri) => {
        if (r.hole !== sr.hole) return;
        r.nodes.forEach((i) => {
          const q = norm(sh, r.pts[i]);
          const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
          if (d < NODE_TOL && d < bd) {
            bd = d;
            best = { kind: 'node', key, ring: ri, index: i };
          }
        });
      });
    } else if (h.kind === 'edge') {
      const g = smoothEdgeGroup(sr, h.index);
      const a = norm(src, sr.pts[g[0]]);
      const b = norm(src, sr.pts[g[g.length - 1]]);
      rs.forEach((r, ri) => {
        if (r.hole !== sr.hole) return;
        for (let i = 0; i < r.pts.length; i++) {
          const gg = smoothEdgeGroup(r, i);
          const c = norm(sh, r.pts[gg[0]]);
          const e = norm(sh, r.pts[gg[gg.length - 1]]);
          const d = Math.min(Math.hypot(a[0] - c[0], a[1] - c[1]) + Math.hypot(b[0] - e[0], b[1] - e[1]), Math.hypot(a[0] - e[0], a[1] - e[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]));
          if (d < EDGE_TOL && d < bd) {
            bd = d;
            best = { kind: 'edge', key, ring: ri, index: i };
          }
        }
      });
    }
    out.set(key, best);
  }
  return out;
}

/**
 * 同一個手勢做在每個對應的結構上，合成一個 Op（keys 多個）。
 * 全部都是同方向、同格數的 push → 一個 push；否則全部用 profile（每個結構一份 perKey）。
 * missed：配不到、沒有動的結構。
 */
export function mirroredOp(
  rings: Map<string, Ring[]>,
  h: Handle,
  delta: XY,
  shift: boolean,
  g: GestureCtx,
  shapes: Map<string, Shape>,
): { op: Op | null; missed: string[] } {
  const main = gestureToOp(rings, h, delta, shift, g);
  if (!main || h.kind === 'region') return { op: main, missed: [] };
  const cps = counterparts(rings, h, shapes);
  const missed = [...cps].filter(([, c]) => !c).map(([k]) => k);
  const pairs = [...cps].filter((x): x is [string, Handle] => !!x[1]);
  if (!pairs.length) return { op: main, missed };
  const sr = rings.get(h.key)![h.ring];
  const amt = h.kind === 'edge' ? edgeAmount(sr, h, delta, shift) : 0;
  const deltaFor = (c: Handle): XY => {
    if (c.kind !== 'edge') return delta;
    const n = groupNormal(rings.get(c.key)![c.ring], smoothEdgeGroup(rings.get(c.key)![c.ring], c.index, shift));
    return [n[0] * amt, n[1] * amt];
  };
  const ops = pairs.map(([, c]) => gestureToOp(rings, c, deltaFor(c), shift, g));
  if (main.kind === 'push' && ops.every((o) => o?.kind === 'push' && o.n === main.n && o.dir.join() === main.dir.join()))
    return { op: { ...main, keys: [main.keys[0], ...pairs.map(([k]) => k)] }, missed };
  // 混在一起：每個結構各自一份 profile
  const perKey: Record<string, { add: Rle2D; remove: Rle2D }> = {};
  const gestures: Record<string, RelGesture> = {};
  for (const [, c] of [[h.key, h] as [string, Handle], ...pairs]) {
    const r = rings.get(c.key)![c.ring];
    const dl = c === h ? delta : deltaFor(c);
    const pd = profileDelta(rings.get(c.key)!, c.ring, dragDisp(r, c, dl, shift), (u, v) => g.inside(c.key, u, v));
    if (pd) {
      perKey[c.key] = pd;
      const rel = recordGesture(rings.get(c.key)!, c, dl, c.kind === 'edge' ? amt : 0, shift);
      if (rel) gestures[c.key] = rel;
    } else missed.push(c.key);
  }
  const keys = Object.keys(perKey);
  if (!keys.length) return { op: null, missed };
  const text = main.kind === 'profile' ? main.text : h.kind === 'edge' ? `邊往${amt > 0 ? '外' : '內'} ${Math.abs(amt)} vx` : '剖面調整';
  return { op: { kind: 'profile', keys, scope: g.scope, at: g.at, perKey, follow: g.follow, backfill: g.backfill, text: `${text}（對應 ${keys.length} 個）`, gestures }, missed };
}
