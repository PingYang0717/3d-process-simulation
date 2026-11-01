import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from '../volume/volume';
import { type EditState, type Op, matNameOf } from '../volume/ops';
import { applyOpLocal } from '../volume/apply';
import { sliceRings } from '../pages/Section3D/SliceEditor';
import { sliceContext } from '../pages/Section3D/handleOps';
import { type Handle, dragDisp, gestureKey, gestureToOp } from './gestures';
import { dragDispFloat, resolveNodeDrag } from './snap';
import type { Ring, XY } from './trace';
import {
  ModelStore,
  applyDisp,
  modelStats,
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

  // v10（§4.2）：節點預設拖法改成依形狀自動選；v7～v9 的衰減走 'falloff'（Alt），這些測試明確走那條路，輸出不變
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
          for (const mode of ['falloff', 'corner', false] as const) expect(gestureToOp(v8, h, d, mode, c8.g)).toEqual(gestureToOp(v7, h, d, mode, c7.g));
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
      applyDisp(m, at.key, at.ring, dragDisp(r, { kind: 'node', ...at }, [1, -1], 'falloff'));
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
    const op = gestureToOp(rings, h, [1, -1], 'falloff', c.g) as Op;
    applyDisp(m, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [1, -1], 'falloff'));
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
    const op = gestureToOp(rings, h, [2, -2], 'falloff', c.g) as Op;
    store.begin(g1, 1, 0);
    applyDisp(g1, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [2, -2], 'falloff'));
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
    applyDisp(g1, h.key, h.ring, dragDisp(rings.get(h.key)![0], h, [2, -2], 'falloff'));
    expect(store.get(base.L, vol, 'z', 26, k, 1, 3).model.vertices[id].u).toBe(u0 + 2);
    expect(store.get(base.L, vol, 'z', 26, k, 1, 4).model.vertices[id].u).toBe(u0);
  });

  it('浮點 ghost：dragDispFloat 不取整，取整後（dragDisp）就是放開時的位移', () => {
    const m = buildSliceModel(base.L, vol, 'z', 26, [fins[0].key], 1);
    const rings = ringsOf(m, [fins[0].key]);
    const r = rings.get(fins[0].key)![0];
    const h = nodeOf(rings, fins[0].key, topRight);
    for (const mode of ['falloff', 'corner', 'single', false] as const) {
      const f = dragDispFloat(r, h, [1.6, -2.3], mode);
      expect(f[h.index]).toEqual([1.6, -2.3]);
      const d = dragDisp(r, h, [1.6, -2.3], mode);
      expect(d[h.index]).toEqual([2, -2]);
      // 其他頂點：浮點取整（衰減是先取整再乘權重，可能差一格）
      if (mode !== 'falloff') f.forEach((p, i) => expect(d[i]).toEqual([Math.round(p[0]), Math.round(p[1])]));
    }
  });

  it('黃金測試（矩形角）：方頭 fin 右上角拖 (2, −1)，幾何層放開後四邊仍和軸平行，格數差＝(w+2)(h+1) − w·h', () => {
    const sq = applyOpLocal(base, { kind: 'level', keys: [fins[0].key], scope: opts().scope, dir: [0, -1, 0], to: fins[0].bbox.y0, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true }, ctx).state;
    const k = [fins[0].key];
    const m = buildSliceModel(sq.L, sq.vol, 'z', 26, k, 2);
    const r = ringsOf(m, k).get(fins[0].key)![0];
    expect(r.nodes.size).toBe(4);
    const h = nodeOf(ringsOf(m, k), fins[0].key, topRight);
    expect(resolveNodeDrag(r, h.index, false)).toBe('corner');
    const id = vidOf(m, h.key, h.ring, h.index)!;
    const p0: XY = [m.vertices[id].u, m.vertices[id].v];
    const xs = r.pts.map((p) => p[0]);
    const ys = r.pts.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const hh = Math.max(...ys) - Math.min(...ys);
    const count = (a: Uint8Array) => a.reduce((n, x) => n + x, 0);
    const before = count(rasterizeModel(m, fins[0].key, 0, 0, vol.X, vol.Y));
    expect(before).toBe(w * hh);
    applyDisp(m, h.key, h.ring, dragDisp(r, h, [2.3, -0.8]));
    expect([m.vertices[id].u, m.vertices[id].v]).toEqual([p0[0] + 2, p0[1] - 1]);
    const after = ringsOf(m, k).get(fins[0].key)![0];
    expect(after.pts.every((p, i) => {
      const q = after.pts[(i + 1) % after.pts.length];
      return p[0] === q[0] || p[1] === q[1];
    })).toBe(true);
    expect(count(rasterizeModel(m, fins[0].key, 0, 0, vol.X, vol.Y)) - before).toBe((w + 2) * (hh + 1) - w * hh);
    // Op 和幾何層同一套位移：profile 的 add 格數＝面積差
    // 剛描好的另一份（上面那份幾何已經改過）
    const c = sliceContext(sq.L, sq.vol, 'z', 26, k, opts());
    const op = gestureToOp(c.rings, nodeOf(c.rings, fins[0].key, topRight), [2.3, -0.8], false, c.g) as Op;
    expect(op.kind).toBe('profile');
    expect(op.kind === 'profile' && op.text?.startsWith('角')).toBe(true);
    expect(op.kind === 'profile' && op.gestures?.[fins[0].key]?.drag).toBe('corner');
  }, 30_000);

  // ---- plan v15 M15.3 ----
  it('gestureKey 相同 ⇒ gestureToOp 的 Op JSON 相同；profile／translate 的 JSON 相同 ⇒ key 相同（B3）', () => {
    const c = sliceContext(base.L, vol, 'z', 26, keys, opts());
    const hs = allHandles(c.rings).filter((_, i) => i % 2 === 0);
    const region: Handle = { kind: 'region', key: keys[0], ring: -1, index: -1 };
    const vals = [-2.4, -1.6, -0.4, 0, 0.3, 0.6, 1.4, 2.5];
    const deltas: XY[] = vals.flatMap((du) => vals.map((dv) => [du, dv] as XY));
    let total = 0;
    let dedup = 0;
    for (const h of [...hs, region])
      for (const mode of ['falloff', 'corner', false, true] as const) {
        const byKey = new Map<string, string>();
        const byJson = new Map<string, string>();
        for (const d of deltas) {
          const key = gestureKey(c.rings, h, d, mode);
          const json = JSON.stringify(gestureToOp(c.rings, h, d, mode, c.g));
          total++;
          const prev = byKey.get(key);
          if (prev !== undefined) {
            expect(json).toBe(prev);
            dedup++;
          } else byKey.set(key, json);
          // push 沒有記 RelGesture.delta（同 n 的不同 (du,dv) 是同一個 Op）：只對 profile／translate 檢查反方向
          if (json !== 'null' && !json.startsWith('{"kind":"push"')) {
            const pk = byJson.get(json);
            if (pk !== undefined) expect(pk).toBe(key);
            else byJson.set(json, key);
          }
        }
      }
    // 浮點位移落在同一格之間的很多：至少 1/4 的幀不必重算
    expect(dedup).toBeGreaterThan(total / 4);
  });

  const sameGeom = (a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) => {
    expect(a.vertices).toEqual(b.vertices);
    expect(a.rings).toEqual(b.rings);
    expect([...a.exact]).toEqual([...b.exact]);
    expect(a.handles).toEqual(b.handles);
    expect(a.custom).toEqual(b.custom);
    expect(a.removed).toEqual(b.removed);
    expect(a.edited).toEqual(b.edited);
    expect(a.origin).toEqual(b.origin);
  };

  it('倉庫：這一步沒碰這一片（touched=false）→ 不驗證、不重描、同一份模型，快照存指標（扁平）；還原回來 deep-equal（A4、D2）', () => {
    const store = new ModelStore();
    const k = [fins[0].key];
    const g1 = store.get(base.L, vol, 'z', 26, k, 1, 0).model;
    const s1 = snapshot(g1);
    const t0 = modelStats.traced;
    const v0 = modelStats.verified;
    const g2 = store.get(base.L, vol, 'z', 26, k, 2, 1, false).model;
    expect(g2).toBe(g1);
    expect(g2.baseVersion).toBe(2);
    expect(modelStats.traced).toBe(t0);
    expect(modelStats.verified).toBe(v0);
    expect(store.snapOf('z', 26, 2)).toEqual({ alias: true, sameAs: 1 });
    // 再一步沒碰：指標仍指向實體，不鏈
    store.get(base.L, vol, 'z', 26, k, 3, 2, false);
    expect(store.snapOf('z', 26, 3)).toEqual({ alias: true, sameAs: 1 });
    expect(store.counts()).toEqual({ entities: 1, aliases: 2 });
    expect(modelStats.verified).toBe(v0);
    // 復原到版本 2（指標）：還原出來的幾何 deep-equal 版本 1 的實體快照
    const back = store.get(base.L, vol, 'z', 26, k, 2, 2).model;
    expect(back).not.toBe(g1);
    sameGeom(back, s1);
    expect(modelStats.verified).toBe(v0);
    // 經指標還原：版本號接到要的那一版（不是實體的版本 1），再取一次是同一份（不會每次 get 都還原一份新的）
    expect(back.baseVersion).toBe(2);
    expect(store.get(base.L, vol, 'z', 26, k, 2, 2).model).toBe(back);
    // 從指標還原出來的模型再走沒碰到的一步：還是指標（不多存一份）
    store.get(base.L, vol, 'z', 26, k, 4, 3, false);
    expect(store.snapOf('z', 26, 4)).toEqual({ alias: true, sameAs: 1 });
    expect(store.counts()).toEqual({ entities: 1, aliases: 3 });
    // 對照：touched 省略（＝true）就驗證；驗證通過、沒人改幾何 → 也是指標
    store.get(base.L, vol, 'z', 26, k, 5, 4);
    expect(modelStats.verified).toBe(v0 + 1);
    expect(store.snapOf('z', 26, 5)).toEqual({ alias: true, sameAs: 1 });
  });

  it('倉庫：幾何改過（加節點，rev 變了）之後的沒碰到的一步存實體快照；之後再沒碰才又是指標', () => {
    const store = new ModelStore();
    const k = [fins[0].key];
    const g1 = store.get(base.L, vol, 'z', 26, k, 1, 0).model;
    const r = ringsOf(g1, k).get(fins[0].key)![0];
    const seg = r.raw.findIndex((x) => x.length > 3);
    insertNode(g1, fins[0].key, 0, seg, 1);
    store.get(base.L, vol, 'z', 26, k, 2, 1, false);
    expect(store.snapOf('z', 26, 2)).toEqual({ alias: false });
    store.get(base.L, vol, 'z', 26, k, 3, 2, false);
    expect(store.snapOf('z', 26, 3)).toEqual({ alias: true, sameAs: 2 });
    expect(store.counts()).toEqual({ entities: 2, aliases: 1 });
  });

  it('倉庫：SNAP_BYTES 超過時最舊的被逐、被指標參考的實體不逐；prune 只留 live 版本（D2）', () => {
    const saved = ModelStore.SNAP_BYTES;
    try {
      const store = new ModelStore();
      const k = [fins[0].key];
      const g1 = store.get(base.L, vol, 'z', 26, k, 1, 0).model;
      const B = store.bytes();
      // fin 這一片只有幾十個頂點：幾百 B（bytesOf 是估算，只要是正數、三份放不進 2.5 份就夠）
      expect(B).toBeGreaterThan(100);
      ModelStore.SNAP_BYTES = Math.floor(B * 2.5);
      const grow = (version: number) => {
        const r = ringsOf(g1, k).get(fins[0].key)![0];
        const seg = r.raw.findIndex((x) => x.length > 3);
        insertNode(g1, fins[0].key, 0, seg, 1);
        store.get(base.L, vol, 'z', 26, k, version, version - 1, false);
      };
      store.get(base.L, vol, 'z', 26, k, 2, 1, false); // v2 → v1
      grow(3); // 實體
      store.get(base.L, vol, 'z', 26, k, 4, 3, false); // v4 → v3
      expect(store.counts()).toEqual({ entities: 2, aliases: 2 });
      grow(5); // 第三份實體：超過 2.5 B → 逐最舊：v2（指標）、再 v1（沒人參考了）
      expect(store.bytes()).toBeLessThanOrEqual(ModelStore.SNAP_BYTES);
      expect(store.snapOf('z', 26, 1)).toBeNull();
      expect(store.snapOf('z', 26, 2)).toBeNull();
      expect(store.snapOf('z', 26, 3)).toEqual({ alias: false });
      expect(store.snapOf('z', 26, 4)).toEqual({ alias: true, sameAs: 3 });
      expect(store.snapOf('z', 26, 5)).toEqual({ alias: false });
      // 被指標參考的實體不逐：復原到 v3（從實體還原）再走一步沒碰到的 v8 → v8 指向 v3。
      // 把上限壓到只放得下一份：逐的順序是 v4（指標）→ v5（沒人參考的實體）；v3 雖然最舊，但 v8 還指著它，留下
      const back = store.get(base.L, vol, 'z', 26, k, 3, 7).model;
      expect(back).not.toBe(g1);
      store.get(base.L, vol, 'z', 26, k, 8, 7, false);
      expect(store.snapOf('z', 26, 8)).toEqual({ alias: true, sameAs: 3 });
      ModelStore.SNAP_BYTES = Math.floor(B * 1.5);
      store.get(base.L, vol, 'z', 26, k, 9, 8, false); // 再一個指標，觸發 evict
      expect(store.bytes()).toBeLessThanOrEqual(ModelStore.SNAP_BYTES);
      expect(store.snapOf('z', 26, 3)).toEqual({ alias: false });
      expect(store.snapOf('z', 26, 4)).toBeNull();
      expect(store.snapOf('z', 26, 5)).toBeNull();
      expect(store.snapOf('z', 26, 8)).toEqual({ alias: true, sameAs: 3 });
      expect(store.snapOf('z', 26, 9)).toEqual({ alias: true, sameAs: 3 });
      // prune：只留 live（9 與它指的 3）
      ModelStore.SNAP_BYTES = saved;
      store.prune(new Set([9]));
      expect(store.counts()).toEqual({ entities: 1, aliases: 1 });
      expect(store.snapOf('z', 26, 3)).toEqual({ alias: false });
      expect(store.snapOf('z', 26, 8)).toBeNull();
      store.prune(new Set());
      expect(store.counts()).toEqual({ entities: 0, aliases: 0 });
      expect(store.bytes()).toBe(0);
    } finally {
      ModelStore.SNAP_BYTES = saved;
    }
  });
});
