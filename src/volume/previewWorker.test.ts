// plan v9 §4.5／§7：拖拉第 2 級預覽搬到 Worker、每片輪廓快取。
import { describe, expect, it } from 'vitest';
import { DIFF_BIT, MATERIALS, demoVolume, greedyMesh, initialLabeled } from './volume';
import { type EditState, type Op, matNameOf } from './ops';
import { previewOp } from './preview';
import { previewMesh } from './previewMesh';
import { newReport } from './kernel';
import type { TracedHandle } from '../slice/relative';
import { ModelStore, ringsOf } from '../slice/model';
import { opOfGesture, sliceContext } from '../pages/Section3D/handleOps';
import { globalIndex } from './patch';
import * as core from './workerCore';

const matName = matNameOf(MATERIALS);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

/** 拖 fin 右上角節點往右上 k 格的 profile Op（和 bench.ts drag 同一個手勢，整根 scope）。 */
function dragOps() {
  const vol = demoVolume();
  const L = initialLabeled(vol, matName);
  const s: EditState = { vol, L, version: 1 };
  const fin = L.comps.find((c) => c.mat === 3)!;
  const z = (fin.bbox.z0 + fin.bbox.z1) >> 1;
  const keys = [fin.key];
  const opts = { scope: { axis: 'z' as const, lo: 0, hi: vol.Z - 1 }, follow: true, backfill: 'orig' as const, nm: 0.5 };
  const m = new ModelStore().get(L, vol, 'z', z, keys, 1).model;
  const rings = ringsOf(m, keys);
  const ctx = { ...sliceContext(L, vol, 'z', z, keys, opts, rings), model: m };
  const r = rings.get(fin.key)![0];
  let node = [...r.nodes][0];
  r.nodes.forEach((i) => {
    if (r.pts[i][0] - r.pts[i][1] > r.pts[node][0] - r.pts[node][1]) node = i;
  });
  const h = { kind: 'node' as const, key: fin.key, ring: 0, index: node };
  const ops: Op[] = [];
  for (let k = 1; k <= 10; k++) {
    const { op } = opOfGesture(ctx, h, [k * 0.5, -k * 0.5], false, false);
    if (op) ops.push(op);
  }
  return { vol, L, s, ops };
}

describe('每片輪廓快取（§4.5）', () => {
  it('同一次拖拉連續 10 個位移共用一份快取：結果和不快取逐格相同、每片只描一次', () => {
    const { vol, s, ops } = dragOps();
    expect(ops.length).toBeGreaterThan(5);
    expect(ops.every((o) => o.kind === 'profile' && o.gestures)).toBe(true);
    const cache = new Map<string, TracedHandle>();
    let traced = 0;
    const ringsFor = (key: string, t: number, make: () => TracedHandle) => {
      const k = `${key}|${t}`;
      let hit = cache.get(k);
      if (!hit) {
        traced++;
        hit = make();
        cache.set(k, hit);
      }
      return hit;
    };
    let slices = 0;
    for (const op of ops) {
      const r1 = newReport();
      const r2 = newReport();
      const a = previewOp(s, vol, op, Infinity, r1)!;
      const b = previewOp(s, vol, op, Infinity, r2, ringsFor)!;
      expect(b.box).toEqual(a.box);
      expect(same(a.data, b.data)).toBe(true);
      expect(r2.blockedAt).toEqual(r1.blockedAt);
      expect(r2.fallback).toEqual(r1.fallback);
      slices = Math.max(slices, cache.size);
    }
    // 每片只描一次：描的次數＝快取裡的片數（不是 片數 × 幀數）
    expect(traced).toBe(slices);
    expect(traced).toBeGreaterThan(10);
  });

  it('Worker preview：結果＝主執行緒 previewOp，blockedAt 是整個陣列的 index，第二幀起輪廓全部命中快取', () => {
    const { vol, L, s, ops } = dragOps();
    core.handle('load', { sid: 5, vol });
    const hidden = new Uint8Array(256);
    const pal = new Float32Array(768).fill(0.5);
    core.previewStats.traced = core.previewStats.hits = 0;
    ops.forEach((op, k) => {
      const [res] = core.handle('preview', { sid: 5, comps: L.comps, op, cap: Infinity, hidden, palette: pal, showDiff: false, seq: k, mesh: true }) as [
        { box: import('./volume').BBox; data: Uint8Array; blockedAt: number[]; mesh: unknown; seq: number },
        unknown,
      ];
      const rep = newReport();
      const p = previewOp(s, vol, op, Infinity, rep)!;
      expect(res.seq).toBe(k);
      expect(res.box).toEqual(p.box);
      expect(same(res.data, p.data)).toBe(true);
      expect(res.blockedAt).toEqual(globalIndex(p.box, vol, rep.blockedAt));
      expect(res.mesh).toBeTruthy();
      if (k === 0) expect(core.previewStats.hits).toBe(0);
    });
    expect(core.previewStats.hits).toBeGreaterThan(core.previewStats.traced * (ops.length - 2));
    // 超過上限回 none
    const [none] = core.handle('preview', { sid: 5, comps: L.comps, op: ops[0], cap: 10, hidden, palette: pal, showDiff: false, seq: 99, mesh: false });
    expect('none' in (none as object)).toBe(true);
  });
});

describe('previewMesh（§4.5，從 views.tsx 搬出）', () => {
  /** 搬出前 views.tsx 的寫法（參考實作）。 */
  function reference(vol: import('./volume').Volume, b: import('./volume').BBox, data: Uint8Array, hidden: Set<number>, colorOf: (c: number) => [number, number, number], o: Uint8Array | null) {
    const HOLE_EPS = 1e-3;
    const bx = b.x1 - b.x0 + 1;
    const by = b.y1 - b.y0 + 1;
    const bz = b.z1 - b.z0 + 1;
    const hx = bx + 2;
    const hy = by + 2;
    const hz = bz + 2;
    const codes = new Uint16Array(hx * hy * hz);
    for (let z = 0; z < hz; z++) {
      const vz = b.z0 - 1 + z;
      if (vz < 0 || vz >= vol.Z) continue;
      for (let y = 0; y < hy; y++) {
        const vy = b.y0 - 1 + y;
        if (vy < 0 || vy >= vol.Y) continue;
        for (let x = 0; x < hx; x++) {
          const vx = b.x0 - 1 + x;
          if (vx < 0 || vx >= vol.X) continue;
          const i = (vz * vol.Y + vy) * vol.X + vx;
          const inside = x >= 1 && x <= bx && y >= 1 && y <= by && z >= 1 && z <= bz;
          const m = inside ? data[((z - 1) * by + (y - 1)) * bx + (x - 1)] : vol.data[i];
          if (!m || hidden.has(m)) continue;
          codes[(z * hy + y) * hx + x] = o && o[i] !== m ? m | DIFF_BIT : m;
        }
      }
    }
    const m = greedyMesh(hx, hy, hz, codes, colorOf);
    const keep: number[] = [];
    for (let t = 0; t < m.positions.length; t += 9) {
      const cx = (m.positions[t] + m.positions[t + 3] + m.positions[t + 6]) / 3;
      const cy = (m.positions[t + 1] + m.positions[t + 4] + m.positions[t + 7]) / 3;
      const cz = (m.positions[t + 2] + m.positions[t + 5] + m.positions[t + 8]) / 3;
      if (cx >= 1 - HOLE_EPS && cx <= bx + 1 + HOLE_EPS && cy >= 1 - HOLE_EPS && cy <= by + 1 + HOLE_EPS && cz >= 1 - HOLE_EPS && cz <= bz + 1 + HOLE_EPS) keep.push(t);
    }
    const positions = new Float32Array(keep.length * 9);
    const normals = new Float32Array(keep.length * 9);
    const colors = new Float32Array(keep.length * 9);
    keep.forEach((t, k) => {
      for (let j = 0; j < 9; j++) {
        positions[k * 9 + j] = m.positions[t + j] + [b.x0 - 1, b.y0 - 1, b.z0 - 1][j % 3];
        normals[k * 9 + j] = m.normals[t + j];
        colors[k * 9 + j] = m.colors[t + j];
      }
    });
    return { positions, normals, colors, quads: keep.length / 2 };
  }

  it('頂點／法線／顏色和搬出前逐元素相同（含隱藏材質、標紅、貼著陣列邊界的盒子）', () => {
    const { vol, s, ops } = dragOps();
    const colorOf = (c: number): [number, number, number] => [(c & 255) / 255, c & DIFF_BIT ? 1 : 0, 0.5];
    const p = previewOp(s, vol, ops[4], Infinity)!;
    const orig = vol.data.slice();
    orig[(p.box.z0 * vol.Y + p.box.y0) * vol.X + p.box.x0] ^= 1;
    for (const [hidden, o] of [
      [new Set<number>(), null],
      [new Set([4, 5]), orig],
    ] as const) {
      const a = previewMesh(vol, p.box, p.data, (m) => hidden.has(m), colorOf, o);
      const b = reference(vol, p.box, p.data, hidden as Set<number>, colorOf, o);
      expect(a.quads).toBe(b.quads);
      expect(a.quads).toBeGreaterThan(0);
      expect(same(a.positions, b.positions) && same(a.normals, b.normals) && same(a.colors, b.colors)).toBe(true);
    }
    const edge = { x0: 0, y0: 0, z0: 0, x1: 9, y1: 9, z1: 9 };
    const d = new Uint8Array(1000).fill(3);
    const a = previewMesh(vol, edge, d, () => false, colorOf, null);
    const b = reference(vol, edge, d, new Set(), colorOf, null);
    expect(same(a.positions, b.positions)).toBe(true);
  });
});
