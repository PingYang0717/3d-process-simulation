// 相對式套用（plan v7 §7.8，M4）：profile Op 另外記下手勢本身（拖哪一種把手、它在結構外框裡的正規化位置、位移），
// 套用時每一片先描自己的輪廓、找到同一個節點／邊、重做同一個手勢；對不到的片退回絕對座標的 add／remove。
// 這樣結構沿法線方向有偏移（每片位置略有不同）時，每片都改到「同一條邊」。
import type { ProfileCell } from '../volume/rle';
import { type Ring, type XY, ringPolygon, traceRings } from './trace';
import { deltaOf, editRing, rasterize } from './raster';
import { type Handle, dragDisp, groupNormal, smoothEdgeGroup } from './gestures';
import { type DragArg, type NodeDrag, isSingle, resolveNodeDrag } from './snap';

export interface RelGesture {
  kind: 'node' | 'edge';
  /** 正規化到結構這一片外框 [0,1]² 的位置：節點一個點；邊兩個端點。 */
  ref: XY[];
  /** 節點：位移（格）；邊：沿法線的格數放在 amount。 */
  delta: XY;
  amount: number;
  /** 邊：只推這一段；節點：拖法是 single（舊版 Op 只有這個欄位）。 */
  shift: boolean;
  /** 節點的拖法（v10）：每一片重做同一種。舊 Op 沒有這個欄位＝shift ? 'single' : 'falloff'（和舊版逐格相同）。 */
  drag?: NodeDrag;
  hole: boolean;
}

/** 這個手勢的節點拖法（沒記錄的舊 Op：shift ? single : falloff）。 */
export const gestureDrag = (g: RelGesture): NodeDrag => g.drag ?? (g.shift ? 'single' : 'falloff');

export const NODE_TOL = 0.12;
export const EDGE_TOL = 0.2;

type Box = { u0: number; v0: number; u1: number; v1: number };

/** 環的外框（外環的頂點；格子座標，含端點）。 */
export function ringsBox(rs: Ring[]): Box | null {
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const r of rs)
    if (!r.hole)
      for (const [u, v] of r.pts) {
        u0 = Math.min(u0, u);
        v0 = Math.min(v0, v);
        u1 = Math.max(u1, u - 1);
        v1 = Math.max(v1, v - 1);
      }
  return u0 <= u1 ? { u0, v0, u1, v1 } : null;
}
export const normIn = (b: Box, p: XY): XY => [(p[0] - b.u0) / (b.u1 - b.u0 + 1), (p[1] - b.v0) / (b.v1 - b.v0 + 1)];

/** 這個把手的手勢記錄（建立 profile Op 時呼叫）。shift：拖法（DragArg；節點記下決定好的拖法）。 */
export function recordGesture(rs: Ring[], h: Handle, delta: XY, amount: number, shift: DragArg): RelGesture | null {
  const b = ringsBox(rs);
  const r = rs[h.ring];
  if (!b || !r || h.kind === 'region') return null;
  const ref = h.kind === 'node' ? [normIn(b, r.pts[h.index])] : (() => {
    const g = smoothEdgeGroup(r, h.index, shift);
    return [normIn(b, r.pts[g[0]]), normIn(b, r.pts[g[g.length - 1]])];
  })();
  if (h.kind === 'node') {
    const drag = resolveNodeDrag(r, h.index, shift);
    return { kind: h.kind, ref, delta: [Math.round(delta[0]), Math.round(delta[1])], amount, shift: drag === 'single', drag, hole: r.hole };
  }
  return { kind: h.kind, ref, delta: [Math.round(delta[0]), Math.round(delta[1])], amount, shift: isSingle(shift), hole: r.hole };
}

/** 在這一片的環裡找同一個把手；對不到回傳 null。 */
export function findHandle(rs: Ring[], g: RelGesture, key = ''): Handle | null {
  const b = ringsBox(rs);
  if (!b) return null;
  let best: Handle | null = null;
  let bd = Infinity;
  rs.forEach((r, ri) => {
    if (r.hole !== g.hole) return;
    if (g.kind === 'node')
      r.nodes.forEach((i) => {
        const q = normIn(b, r.pts[i]);
        const d = Math.hypot(q[0] - g.ref[0][0], q[1] - g.ref[0][1]);
        if (d < NODE_TOL && d < bd) {
          bd = d;
          best = { kind: 'node', key, ring: ri, index: i };
        }
      });
    else
      for (let i = 0; i < r.pts.length; i++) {
        const gg = smoothEdgeGroup(r, i, g.shift);
        const c = normIn(b, r.pts[gg[0]]);
        const e = normIn(b, r.pts[gg[gg.length - 1]]);
        const [a, bb] = g.ref;
        const d = Math.min(
          Math.hypot(a[0] - c[0], a[1] - c[1]) + Math.hypot(bb[0] - e[0], bb[1] - e[1]),
          Math.hypot(a[0] - e[0], a[1] - e[1]) + Math.hypot(bb[0] - c[0], bb[1] - c[1]),
        );
        if (d < EDGE_TOL && d < bd) {
          bd = d;
          best = { kind: 'edge', key, ring: ri, index: i };
        }
      }
  });
  return best;
}

/** 一片描好的輪廓與找到的把手（拖拉中每片只描一次，plan v9 §4.5）。 */
export interface TracedHandle {
  rings: Ring[];
  handle: Handle | null;
}

/**
 * 拖拉中每片輪廓的快取（plan v9 §4.5）：key（片＋結構＋把手）→ 描好的輪廓；
 * 輪廓一模一樣的片共用同一份物件（沿法線擠出的結構多半每片都一樣），applyProfileMask 對同一份只重做一次手勢。
 */
export function ringCache(max = 8192) {
  const byKey = new Map<string, TracedHandle>();
  const byShape = new Map<string, TracedHandle>();
  const stats = { traced: 0, hits: 0 };
  const sig = (h: TracedHandle) =>
    `${h.handle ? `${h.handle.kind}${h.handle.ring}:${h.handle.index}` : '-'}|${h.rings.map((r) => `${r.hole ? 'h' : 'o'}${r.pts.join(';')}`).join('|')}`;
  return {
    stats,
    clear() {
      byKey.clear();
      byShape.clear();
    },
    get(key: string, make: () => TracedHandle): TracedHandle {
      const hit = byKey.get(key);
      if (hit) {
        stats.hits++;
        return hit;
      }
      stats.traced++;
      let h = make();
      const k = sig(h);
      const same = byShape.get(k);
      if (same) h = same;
      else byShape.set(k, h);
      if (byKey.size >= max) this.clear();
      byKey.set(key, h);
      return h;
    },
  };
}

/** 描這一片的輪廓、找同一個把手（relativeCells 的前半；結果可以快取，同一次拖拉裡不變）。 */
export function traceHandle(inside: (u: number, v: number) => boolean, u0: number, v0: number, u1: number, v1: number, g: RelGesture): TracedHandle {
  const rings = traceRings(inside, u0, v0, u1, v1);
  return { rings, handle: findHandle(rings, g) };
}

/**
 * 這一片重做手勢：inside(u, v) = 這一片的結構；[u0..u1]×[v0..v1] 是找輪廓的範圍。
 * 回傳要加、要拿的格子（切面座標，帶方向碼，加的已由近到遠排好）；對不到把手回傳 null。
 * pre：快取的 traceHandle 結果（不會被改動）。
 */
export function relativeCells(
  inside: (u: number, v: number) => boolean,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
  g: RelGesture,
  pre?: TracedHandle,
): { add: ProfileCell[]; remove: ProfileCell[] } | null {
  const { rings: rs, handle: h } = pre ?? traceHandle(inside, u0, v0, u1, v1, g);
  if (!h) return null;
  const r = rs[h.ring];
  let delta = g.delta;
  if (g.kind === 'edge') {
    const n = groupNormal(r, smoothEdgeGroup(r, h.index, g.shift));
    delta = [n[0] * g.amount, n[1] * g.amount];
  }
  const disp = dragDisp(r, h, delta, g.kind === 'node' ? gestureDrag(g) : g.shift);
  const after = rs.map((x, i) => (i === h.ring ? editRing(x, disp) : ringPolygon(x)));
  let a0 = Infinity;
  let b0 = Infinity;
  let a1 = -Infinity;
  let b1 = -Infinity;
  for (const p of [...after, ...rs.map(ringPolygon)])
    for (const [u, v] of p) {
      a0 = Math.min(a0, Math.floor(u) - 1);
      b0 = Math.min(b0, Math.floor(v) - 1);
      a1 = Math.max(a1, Math.ceil(u) + 1);
      b1 = Math.max(b1, Math.ceil(v) + 1);
    }
  const W = a1 - a0 + 1;
  const H = b1 - b0 + 1;
  const before = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u + a0, v + b0)) before[v * W + u] = 1;
  return deltaOf(before, rasterize(after, a0, b0, W, H), a0, b0, W, H);
}
