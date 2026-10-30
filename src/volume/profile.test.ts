import { describe, expect, it } from 'vitest';
import { type Labeled, MATERIALS, demoVolume, growMask, initialLabeled, maskOf } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { decodeRle, encodeRle } from './profile';
import { type Scope, toUV } from './scope';
import { traceRings } from '../slice/trace';
import { type GestureCtx, type Handle, gestureToOp } from '../slice/gestures';

const matName = matNameOf(MATERIALS);
const diffCount = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 某結構在 XY 第 z 片的環與 GestureCtx。 */
function sliceOf(s: EditState, key: string, z: number, scope: Scope, follow = true) {
  const k = s.L.comps.findIndex((c) => c.key === key);
  const { X, Y } = s.vol;
  const inside = (u: number, v: number) => u >= 0 && v >= 0 && u < X && v < Y && s.L.labels[(z * Y + v) * X + u] === k;
  const b = s.L.comps[k].bbox;
  const rings = new Map([[key, traceRings(inside, b.x0, b.y0, b.x1, b.y1)]]);
  let box: { u0: number; v0: number; u1: number; v1: number } | null = null;
  for (let v = b.y0; v <= b.y1; v++)
    for (let u = b.x0; u <= b.x1; u++)
      if (inside(u, v)) box = box ? { u0: Math.min(box.u0, u), v0: Math.min(box.v0, v), u1: Math.max(box.u1, u), v1: Math.max(box.v1, v) } : { u0: u, v0: v, u1: u, v1: v };
  const g: GestureCtx = { axis: 'z', at: z, scope, follow, backfill: 'orig', selKeys: [key], inside: (_k, u, v) => inside(u, v), sliceBox: () => box, nm: 0.5 };
  return { rings, g, box: box! };
}
/** 環上 v 最小（頂邊）那一段。 */
function topEdge(rings: Map<string, ReturnType<typeof traceRings>>, key: string): Handle {
  const r = rings.get(key)![0];
  let best = 0;
  let bv = Infinity;
  r.pts.forEach((p, i) => {
    const q = r.pts[(i + 1) % r.pts.length];
    if (p[1] === q[1] && p[1] < bv) {
      bv = p[1];
      best = i;
    }
  });
  return { kind: 'edge', key, ring: 0, index: best };
}

describe('profile Op 與手勢（§7.3、§6.3、§10.3）', () => {
  const vol = demoVolume();
  const base0: EditState = { vol, L: initialLabeled(vol, matName) };
  const fin0 = base0.L.comps.find((c) => c.mat === 3)!;
  const full: Scope = { axis: 'z', lo: 0, hi: vol.Z - 1 };
  let seq = 1000;
  const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
  // 先把 fin 補成方頭，頂邊才是橫跨整根的直邊
  const sq = applyOpLocal(base0, { kind: 'level', keys: [fin0.key], scope: full, dir: [0, -1, 0], to: fin0.bbox.y0, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true }, ctx).state;
  const base: EditState = { vol: sq.vol, L: sq.L };

  it('RLE 編碼、解碼回到一樣的格子', () => {
    const cells = [
      { u: 3, v: 1, dir: 3 },
      { u: 4, v: 1, dir: 3 },
      { u: 5, v: 1, dir: 0 },
      { u: 3, v: 2, dir: 3 },
    ];
    const r = encodeRle(cells);
    expect(r.runs.length).toBe(12);
    expect(decodeRle(r).sort((a, b) => a.v - b.v || a.u - b.u)).toEqual(cells);
  });

  it('方頭的 fin：推頂邊往上 3 → push，和 3D 長高 3 逐體素相同', () => {
    const { rings, g, box } = sliceOf(base, fin0.key, 64, full);
    const h = topEdge(rings, fin0.key);
    const op = gestureToOp(rings, h, [0, -3], false, g)!;
    expect(op.kind).toBe('push');
    if (op.kind !== 'push') return;
    expect(op.dir).toEqual([0, -1, 0]);
    expect(op.n).toBe(3);
    const got = applyOpLocal(base, op, ctx).state;
    const want = growMask(base.vol, vol, maskOf(base.L, new Set([fin0.key]))!, full, [0, -1, 0], 3, 'orig', true);
    expect(diffCount(got.vol.data, want.data)).toBe(0);
    expect(box.v0).toBe(fin0.bbox.y0);
  }, 30_000);

  it('拖頂角節點往外：profile；閘極底下的 HfO₂／TiN 被推開、沒有被擋', () => {
    const { rings, g } = sliceOf(base, fin0.key, 26, full);
    const r = rings.get(fin0.key)![0];
    // 右上角
    let corner = 0;
    r.pts.forEach((p, i) => {
      if (r.nodes.has(i) && p[1] <= r.pts[corner][1] && p[0] >= r.pts[corner][0]) corner = i;
    });
    const op = gestureToOp(rings, { kind: 'node', key: fin0.key, ring: 0, index: corner }, [2, -2], false, g)!;
    expect(op.kind).toBe('profile');
    const r1 = applyOpLocal(base, op, ctx);
    expect(r1.report.filled + r1.report.pushed).toBeGreaterThan(0);
    expect(r1.report.pushed).toBeGreaterThan(0);
    expect(r1.report.blocked).toBe(0);
    // 和整個陣列算的 applyOp 相同
    expect(diffCount(r1.state.vol.data, applyOp(base, op, ctx).vol.data)).toBe(0);
  }, 30_000);

  it('頂邊往內削 2（follow）：閘極底下 HfO₂、TiN 緊貼新的頂面，沒有空氣或回填夾層', () => {
    const { rings, g } = sliceOf(base, fin0.key, 26, full);
    const h = topEdge(rings, fin0.key);
    const op = gestureToOp(rings, h, [0, 2], false, g)!;
    expect(op.kind).toBe('push');
    const out = applyOpLocal(base, op, ctx).state.vol;
    const x = (fin0.bbox.x0 + fin0.bbox.x1) >> 1;
    const z = 26;
    const at = (y: number) => out.data[(z * vol.Y + y) * vol.X + x];
    const top = fin0.bbox.y0 + 2;
    expect(at(top)).toBe(3);
    expect(at(top - 1)).toBe(4);
    expect([4, 5]).toContain(at(top - 2));
  }, 30_000);

  it('沒有這個結構的片略過；不連通的格子不填', () => {
    const poly = base.L.comps.find((c) => c.mat === 6)!;
    // 在 poly 外面很遠的地方加一塊（和結構不相連），再在 poly 頂上加一排（相連）
    const [u0, v0] = toUV('z', [poly.bbox.x0, poly.bbox.y0, 0]);
    const add = encodeRle([
      ...Array.from({ length: 5 }, (_, k) => ({ u: u0 + 10 + k, v: v0 - 1, dir: 3 })),
      { u: 2, v: 2, dir: 3 },
    ]);
    const op: Op = { kind: 'profile', keys: [poly.key], scope: full, at: 26, perKey: { [poly.key]: { add, remove: { x0: 0, y0: 0, w: 0, h: 0, runs: [] } } }, follow: true, backfill: 'orig' };
    const r = applyOpLocal(base, op, ctx);
    const span = poly.bbox.z1 - poly.bbox.z0 + 1;
    expect(r.report.skipped.length).toBe(vol.Z - span);
    // 每一片只填相連的 5 格（遠處那一格沒填）
    expect(r.state.vol.data[(26 * vol.Y + 2) * vol.X + 2]).toBe(vol.data[(26 * vol.Y + 2) * vol.X + 2]);
    expect(r.report.filled + r.report.pushed + r.report.blocked).toBe(5 * span);
  }, 30_000);
});

export type { Labeled };
