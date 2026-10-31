import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from '../volume/volume';
import { type EditState, type Op, matNameOf } from '../volume/ops';
import { applyOpLocal } from '../volume/apply';
import { sliceRings } from '../pages/Section3D/SliceEditor';
import { sliceContext } from '../pages/Section3D/handleOps';
import { type Handle, dragDisp, gestureToOp } from './gestures';
import { dragDispFloat } from './snap';
import type { Ring, XY } from './trace';
import {
  ModelStore,
  applyDisp,
  exactOp,
  buildSliceModel,
  insertNode,
  locate,
  rasterizeModel,
  removeHandle,
  retraceKeepingHandles,
  ringsOf,
  snapshot,
  verifyAndFix,
  verifyKey,
  vidOf,
} from './model';

const matName = matNameOf(MATERIALS);
const opts = (follow = true) => ({ scope: { axis: 'z' as const, lo: 0, hi: 127 }, follow, backfill: 'orig' as const, nm: 0.5 });

/** 環上依 pick 挑一個節點。 */
const nodeOf = (rings: Map<string, Ring[]>, key: string, pick: (p: XY, q: XY) => boolean): Handle => {
  const r = rings.get(key)![0];
  let best = [...r.nodes][0];
  r.nodes.forEach((i) => {
    if (pick(r.pts[i], r.pts[best])) best = i;
  });
  return { kind: 'node', key, ring: 0, index: best };
};
const topRight = (p: XY, q: XY) => p[0] - p[1] > q[0] - q[1];
/** 每個段當一次邊、每個節點當一次節點：所有把手。 */
const allHandles = (rings: Map<string, Ring[]>): Handle[] =>
  [...rings].flatMap(([key, rs]) =>
    rs.flatMap((r, ring) => [
      ...[...r.nodes].map((index) => ({ kind: 'node' as const, key, ring, index })),
      ...r.pts.map((_, index) => ({ kind: 'edge' as const, key, ring, index })),
    ]),
  );

describe('幾何層 SliceModel（plan v8 §6、§7、§10）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName), version: 1 };
  let seq = 5000;
  const ctx = { orig: vol, matName, newKey: () => `m${seq++}` };
  const fins = base.L.comps.filter((c) => c.mat === 3);
  const keys = [...fins.map((c) => c.key), base.L.comps.find((c) => c.mat === 6)!.key];

  it('黃金測試：剛建立的幾何給手勢的環 ≡ v7 traceRings，所有把手產生的 Op 逐欄相同', () => {
    for (const z of [10, 26, 64]) {
      const v7 = sliceRings(base.L, vol, 'z', z, keys);
      const m = buildSliceModel(base.L, vol, 'z', z, keys, 1);
      const v8 = ringsOf(m, keys);
      expect([...v8.keys()]).toEqual([...v7.keys()]);
      for (const [k, rs] of v7) {
        const got = v8.get(k)!;
        expect(got.length).toBe(rs.length);
        rs.forEach((r, i) => {
          expect(got[i].pts).toEqual(r.pts);
          expect(got[i].raw).toEqual(r.raw);
          expect([...got[i].nodes].sort((a, b) => a - b)).toEqual([...r.nodes].sort((a, b) => a - b));
          expect(got[i].hole).toBe(r.hole);
        });
      }
      const c7 = sliceContext(base.L, vol, 'z', z, keys, opts(), v7);
      const c8 = sliceContext(base.L, vol, 'z', z, keys, opts(), v8);
      const hs = allHandles(v7).filter((_, i) => i % 3 === 0);
      for (const h of hs)
        for (const d of [
          [2.4, -1.6],
          [-3, 0],
        ] as XY[])
          expect(gestureToOp(v8, h, d, false, c8.g)).toEqual(gestureToOp(v7, h, d, false, c7.g));
    }
  });

  it('沒有位移：rasterizeModel(建立) 和這一片 voxel 逐格相同；加／刪節點不改形狀', () => {
    for (const z of [0, 26, 100]) {
      const m = buildSliceModel(base.L, vol, 'z', z, keys, 1);
      for (const k of keys) expect(verifyKey(m, base.L, vol, k)).toEqual([]);
      const r = ringsOf(m, keys).get(fins[0].key)![0];
      const seg = r.raw.findIndex((s) => s.length > 3);
      const before = rasterizeModel(m, fins[0].key, 0, 0, vol.X, vol.Y);
      const id = insertNode(m, fins[0].key, 0, seg, 1)!;
      expect(m.handles.has(id)).toBe(true);
      removeHandle(m, vidOf(m, fins[0].key, 0, [...r.nodes][0])!);
      expect(rasterizeModel(m, fins[0].key, 0, 0, vol.X, vol.Y)).toEqual(before);
      expect(verifyKey(m, base.L, vol, fins[0].key)).toEqual([]);
    }
  });

  it('連拖三次同一個節點：節點還是那一個、id 不變、座標是三次位移累加；快照還原回原狀', () => {
    const m = buildSliceModel(base.L, vol, 'z', 26, keys, 1);
    const snap0 = snapshot(m);
    const h = nodeOf(ringsOf(m, keys), fins[0].key, topRight);
    const id = vidOf(m, h.key, h.ring, h.index)!;
    const p0: XY = [m.vertices[id].u, m.vertices[id].v];
    const handles0 = new Set(m.handles);
    for (let k = 0; k < 3; k++) {
      const at = locate(m, id)!;
      const r = ringsOf(m, keys).get(at.key)![at.ring];
      applyDisp(m, at.key, at.ring, dragDisp(r, { kind: 'node', ...at }, [1, -1]));
    }
    expect(m.handles).toEqual(handles0);
    expect([m.vertices[id].u, m.vertices[id].v]).toEqual([p0[0] + 3, p0[1] - 3]);
    const back = snapshot(snap0);
    expect([back.vertices[id].u, back.vertices[id].v]).toEqual(p0);
  });

  it('Shift 拖節點（只動這一點）寫回 voxel 之後幾何不重描就對得上（驗證通過），第二次從新形狀出發', () => {
    // 閘極外面的那一段（fin 上面是空氣，加的格子不會被擋）
    const Z = 4;
    let s: EditState = base;
    const m = buildSliceModel(s.L, s.vol, 'z', Z, [fins[0].key], 1);
    const h = nodeOf(ringsOf(m, [fins[0].key]), fins[0].key, topRight);
    const id = vidOf(m, h.key, h.ring, h.index)!;
    for (let k = 0; k < 2; k++) {
      const rings = ringsOf(m, [fins[0].key]);
      const at = locate(m, id)!;
      const hh: Handle = { kind: 'node', ...at };
      const c = sliceContext(s.L, s.vol, 'z', Z, [fins[0].key], opts(), rings);
      const op = exactOp(m, gestureToOp(rings, hh, [0, -2], true, c.g) as Op);
      expect(op.kind).toBe('profile');
      // 第一次是剛描好的幾何（和 v7 一樣），第二次幾何已經改過：參考片用絕對格子
      expect('refExact' in op).toBe(k > 0);
      applyDisp(m, at.key, at.ring, dragDisp(rings.get(at.key)![at.ring], hh, [0, -2], true));
      const r = applyOpLocal(s, op, ctx);
      // 別的片可能被閘極擋住；這一片沒有
      expect(r.report.blockedAt.filter((i) => Math.floor(i / (vol.X * vol.Y)) === Z)).toEqual([]);
      s = { ...r.state, version: s.version! + 1 };
      const v = verifyAndFix(m, s.L, s.vol, [fins[0].key], s.version!);
      expect(v.ok).toBe(true);
      expect(locate(m, id)).toBeTruthy();
    }
  }, 30_000);

  it('重描：方頭後四個角的節點 id 全部保留；voxel 偏 3 格的節點消失、其他保留', () => {
    const m = buildSliceModel(base.L, vol, 'z', 26, [fins[0].key], 1);
    // 把 fin 補成方頭，然後重描
    const sq = applyOpLocal(base, { kind: 'level', keys: [fins[0].key], scope: opts().scope, dir: [0, -1, 0], to: fins[0].bbox.y0, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true }, ctx).state;
    const m2 = buildSliceModel(sq.L, sq.vol, 'z', 26, [fins[0].key], 2);
    const sqRing = ringsOf(m2, [fins[0].key]).get(fins[0].key)![0];
    expect(sqRing.nodes.size).toBe(4);
    // 舊模型的角：把它們挪到方頭的四個角上（模擬幾何已經是方頭），重描後 id 保留
    const corners = [...sqRing.nodes].map((i) => sqRing.pts[i]);
    const r0 = ringsOf(m, [fins[0].key]).get(fins[0].key)![0];
    const ids = corners.map((c) => {
      let best = [...r0.nodes][0];
      r0.nodes.forEach((i) => {
        if (Math.hypot(r0.pts[i][0] - c[0], r0.pts[i][1] - c[1]) < Math.hypot(r0.pts[best][0] - c[0], r0.pts[best][1] - c[1])) best = i;
      });
      const id = vidOf(m, fins[0].key, 0, best)!;
      m.vertices[id].u = c[0];
      m.vertices[id].v = c[1];
      return id;
    });
    const res = retraceKeepingHandles(m, sq.L, sq.vol, fins[0].key);
    for (const id of ids) expect(m.handles.has(id)).toBe(true);
    expect(res.kept).toBeGreaterThanOrEqual(4);
    expect(verifyKey(m, sq.L, sq.vol, fins[0].key)).toEqual([]);
    // 一個節點偏 3 格（對不到）：它消失，其他三個保留
    m.vertices[ids[0]].u += 3;
    retraceKeepingHandles(m, sq.L, sq.vol, fins[0].key);
    expect(m.vertices[ids[0]]).toBeUndefined();
    for (const id of ids.slice(1)) expect(m.handles.has(id)).toBe(true);
  }, 30_000);

  it('被擋住（防穿層，fin 角推進襯層）：驗證失敗、重描後幾何 === voxel、拖的那個節點 id 還在', () => {
    const m = buildSliceModel(base.L, vol, 'z', 26, [fins[0].key], 1);
    const rings = ringsOf(m, [fins[0].key]);
    const h = nodeOf(rings, fins[0].key, topRight);
    const id = vidOf(m, h.key, h.ring, h.index)!;
    const c = sliceContext(base.L, vol, 'z', 26, [fins[0].key], opts(false), rings);
    const op = gestureToOp(rings, h, [1, -1], false, c.g) as Op;
    applyDisp(m, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [1, -1]));
    const r = applyOpLocal(base, op, ctx);
    expect(r.report.blocked).toBeGreaterThan(0);
    const next = { ...r.state, version: 2 };
    const v = verifyAndFix(m, next.L, next.vol, [fins[0].key], 2);
    expect(v.ok).toBe(false);
    expect(verifyKey(m, next.L, next.vol, fins[0].key)).toEqual([]);
    expect(m.handles.has(id)).toBe(true);
  }, 30_000);

  it('倉庫：放開先更新幾何，Worker 回來驗證通過就沿用；復原回到那個版本的快照', () => {
    const store = new ModelStore();
    const k = [fins[0].key];
    const g1 = store.get(base.L, vol, 'z', 26, k, 1, 0).model;
    const rings = ringsOf(g1, k);
    const h = nodeOf(rings, fins[0].key, topRight);
    const id = vidOf(g1, h.key, h.ring, h.index)!;
    const p0: XY = [g1.vertices[id].u, g1.vertices[id].v];
    const c = sliceContext(base.L, vol, 'z', 26, k, opts(), rings);
    const op = gestureToOp(rings, h, [2, -2], false, c.g) as Op;
    store.begin(g1, 1, 0);
    applyDisp(g1, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [2, -2]));
    // Worker 還沒回來：同一份、已經在新位置
    expect(store.get(base.L, vol, 'z', 26, k, 1, 0).model.vertices[id].u).toBe(p0[0] + 2);
    const next = applyOpLocal(base, op, ctx).state;
    const g2 = store.get(next.L, next.vol, 'z', 26, k, 2, 1);
    expect(g2.fixed).toEqual([]);
    expect([g2.model.vertices[id].u, g2.model.vertices[id].v]).toEqual([p0[0] + 2, p0[1] - 2]);
    // 復原：回到版本 1 的幾何
    const g3 = store.get(base.L, vol, 'z', 26, k, 1, 1).model;
    expect([g3.vertices[id].u, g3.vertices[id].v]).toEqual(p0);
    // 重做：回到版本 2 的幾何（快照）
    const g4 = store.get(next.L, next.vol, 'z', 26, k, 2, 1).model;
    expect([g4.vertices[id].u, g4.vertices[id].v]).toEqual([p0[0] + 2, p0[1] - 2]);
  }, 30_000);

  it('倉庫：那一步沒有改到任何格子（版本不變）→ 幾何回到放開前', () => {
    const store = new ModelStore();
    const k = [fins[0].key];
    const g1 = store.get(base.L, vol, 'z', 26, k, 1, 0).model;
    const rings = ringsOf(g1, k);
    const h = nodeOf(rings, fins[0].key, topRight);
    const id = vidOf(g1, h.key, h.ring, h.index)!;
    const u0 = g1.vertices[id].u;
    store.begin(g1, 1, 3);
    applyDisp(g1, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [2, -2]));
    expect(store.get(base.L, vol, 'z', 26, k, 1, 3).model.vertices[id].u).toBe(u0 + 2);
    expect(store.get(base.L, vol, 'z', 26, k, 1, 4).model.vertices[id].u).toBe(u0);
  });

  it('浮點 ghost：dragDispFloat 不取整，取整後（dragDisp）就是放開時的位移', () => {
    const m = buildSliceModel(base.L, vol, 'z', 26, [fins[0].key], 1);
    const rings = ringsOf(m, [fins[0].key]);
    const r = rings.get(fins[0].key)![0];
    const h = nodeOf(rings, fins[0].key, topRight);
    const f = dragDispFloat(r, h, [1.6, -2.3]);
    expect(f[h.index]).toEqual([1.6, -2.3]);
    expect(dragDisp(r, h, [1.6, -2.3])[h.index]).toEqual([2, -2]);
  });
});
