import { describe, expect, it } from 'vitest';
import { type BBox, type Labeled, MATERIALS, demoVolume, initialLabeled, maskOf, relabelFull, relabelStats } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { applyStep, cropArr } from './patch';

const matName = matNameOf(MATERIALS);
/** 兩份 labels 是不是同一套結構（逐體素比 key 與名稱；結構清單比 count 與 bbox）；編號可以不同。 */
function sameStructures(a: Labeled, b: Labeled) {
  let bad = 0;
  for (let i = 0; i < a.labels.length; i++) {
    const la = a.labels[i];
    const lb = b.labels[i];
    if ((la < 0) !== (lb < 0)) bad++;
    else if (la >= 0 && (a.comps[la].key !== b.comps[lb].key || a.comps[la].label !== b.comps[lb].label)) bad++;
  }
  expect(bad).toBe(0);
  expect(a.comps.length).toBe(b.comps.length);
  const byKey = new Map(b.comps.map((c) => [c.key, c]));
  for (const c of a.comps) {
    const o = byKey.get(c.key)!;
    expect(o).toBeTruthy();
    expect([c.label, c.mat, c.count, c.bbox]).toEqual([o.label, o.mat, o.count, o.bbox]);
  }
  // labels 和清單一致：每個結構的體素數＝count
  const n = new Array(a.comps.length).fill(0);
  for (const l of a.labels) if (l >= 0) n[l]++;
  a.comps.forEach((c, k) => expect(n[k]).toBe(c.count));
}
const diffCount = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

describe('只在外框裡算＋補丁（§8.2、§8.3）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const cases: [string, Op][] = [
    ['poly 往上長 2（跟推）', { kind: 'push', keys: [poly[0].key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' }],
    ['poly 往上縮 3（跟退）', { kind: 'push', keys: [poly[1].key], scope: full, dir: [0, -1, 0], n: -3, follow: true, backfill: 'orig' }],
    ['fin 方頭', { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: true }],
    ['兩根 poly 平移', { kind: 'translate', keys: [poly[1].key, poly[2].key], scope: full, d: [3, 0, -2], backfill: 'orig' }],
    ['fin 帶殼平移、只搬一段', { kind: 'translate', keys: [fin.key], scope: { axis: 'z', lo: 40, hi: 90 }, d: [2, 0, 0], backfill: 'orig', follow: true }],
    ['fin 一段換材質（切斷 fin，會多出新結構）', { kind: 'material', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, m: 0 }],
    ['poly 換成 VOID', { kind: 'material', keys: [poly[2].key], scope: full, m: 254 }],
  ];
  for (const [name, op] of cases)
    it(`${name}：體素、labels、結構清單和 applyOp 相同；補丁往前往回都還原`, () => {
      let a = 1000;
      let b = 1000;
      const ref = applyOp(base, op, { orig: vol, matName, newKey: () => `c${a++}` });
      const got = applyOpLocal(base, op, { orig: vol, matName, newKey: () => `c${b++}` });
      expect(diffCount(got.state.vol.data, ref.vol.data)).toBe(0);
      sameStructures(got.state.L, ref.L);
      const fwd = applyStep(base, got.step, 'fwd');
      expect(diffCount(fwd.vol.data, ref.vol.data)).toBe(0);
      expect(diffCount(fwd.L.labels, got.state.L.labels)).toBe(0);
      expect(fwd.L.comps).toEqual(got.state.L.comps);
      const back = applyStep(got.state, got.step, 'back');
      expect(diffCount(back.vol.data, vol.data)).toBe(0);
      expect(diffCount(back.L.labels, base.L.labels)).toBe(0);
      expect(back.L.comps).toEqual(base.L.comps);
    }, 30_000);

  it('連續幾步（長、搬、切斷、併起來）：和整個重算的結構相同，補丁一路復原回原始', () => {
    const ops: Op[] = [
      { kind: 'push', keys: [poly[0].key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' },
      { kind: 'translate', keys: [poly[1].key, poly[2].key], scope: full, d: [3, 0, 0], backfill: 'orig' },
      { kind: 'material', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, m: 0 },
      // 再把切開的地方補回 Si fin：兩塊併回一塊
      { kind: 'push', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, dir: [0, 0, 1], n: 5, follow: false, backfill: 'orig' },
      { kind: 'push', keys: [poly[2].key], scope: full, dir: [1, 0, 0], n: -3, follow: false, backfill: 'orig', local: { center: [120, 30, 100], radius: 5 } },
    ];
    let a: EditState = base;
    let b: EditState = base;
    let sa = 1000;
    let sb = 1000;
    const steps = [];
    for (const op of ops) {
      const r = applyOpLocal(a, op, { orig: vol, matName, newKey: () => `c${sa++}` });
      steps.push({ step: r.step, before: a });
      const mask = maskOf(b.L, new Set(op.keys))!;
      b = { vol: r.state.vol, L: relabelFull(b.vol, b.L, mask, op.kind === 'translate' ? op.d : [0, 0, 0], r.state.vol, matName, () => `c${sb++}`) };
      a = r.state;
      sameStructures(a.L, b.L);
    }
    let cur: { vol: typeof vol; L: Labeled } = a;
    for (const { step, before } of steps.reverse()) {
      cur = applyStep(cur, step, 'back');
      expect(diffCount(cur.vol.data, before.vol.data)).toBe(0);
      expect(diffCount(cur.L.labels, before.L.labels)).toBe(0);
      expect(cur.L.comps).toEqual(before.L.comps);
    }
  }, 60_000);

  it('沒改到：補丁是空的、狀態原封不動', () => {
    const op: Op = { kind: 'material', keys: [poly[0].key], scope: full, m: 6 };
    const got = applyOpLocal(base, op, { orig: vol, matName, newKey: () => 'k' });
    expect(got.step.data).toBeNull();
    expect(got.state.vol).toBe(vol);
  });

  it('報告：方頭不跟推時被 TiN／HfO₂ 擋住的格數', () => {
    const op: Op = { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: false };
    const got = applyOpLocal(base, op, { orig: vol, matName, newKey: () => 'k' });
    expect(got.report.filled).toBeGreaterThan(0);
    expect(got.report.blocked).toBeGreaterThan(0);
    expect(Object.keys(got.report.blockedBy).map(Number).every((m) => m === 4 || m === 5)).toBe(true);
  }, 30_000);
});

describe('relabel 只快照 F（plan v15 A3）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const boxSize = (b: BBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
  /** 舊算法的快照大小：Smax = R ∪ 所有在 R±1 裡出現的結構的外框。 */
  const smaxOf = (L: Labeled, R: BBox) => {
    const { X, Y, Z } = vol;
    const touched = new Set<number>();
    for (let z = Math.max(0, R.z0 - 1); z <= Math.min(Z - 1, R.z1 + 1); z++)
      for (let y = Math.max(0, R.y0 - 1); y <= Math.min(Y - 1, R.y1 + 1); y++)
        for (let x = Math.max(0, R.x0 - 1); x <= Math.min(X - 1, R.x1 + 1); x++) {
          const l = L.labels[(z * Y + y) * X + x];
          if (l >= 0) touched.add(l);
        }
    let b = { ...R };
    for (const k of touched) {
      const c = L.comps[k].bbox;
      b = { x0: Math.min(b.x0, c.x0), x1: Math.max(b.x1, c.x1), y0: Math.min(b.y0, c.y0), y1: Math.max(b.y1, c.y1), z0: Math.min(b.z0, c.z0), z1: Math.max(b.z1, c.z1) };
    }
    return boxSize(b);
  };
  type OpOf = (s: EditState) => Op;
  // 切斷 fin 之後哪一段留著 fin.key 由投票決定：從留著的那一段往缺口推，兩段才會併回一塊
  const pushBack: OpOf = (s) => {
    const c = s.L.comps.find((x) => x.key === fin.key)!;
    return { kind: 'push', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, dir: c.bbox.z0 > 64 ? [0, 0, -1] : [0, 0, 1], n: 5, follow: false, backfill: 'orig' };
  };
  const cases: { name: string; ops: (Op | OpOf)[]; sNotF?: boolean; moves?: boolean; shrink?: boolean }[] = [
    { name: 'fin 長高 1、只改 z 40～50（只是相鄰的大結構不再進快照）', ops: [{ kind: 'push', keys: [fin.key], scope: { axis: 'z', lo: 40, hi: 50 }, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' }], shrink: true },
    { name: 'poly 底部削掉 2 格露出 STI（回填空氣）', ops: [{ kind: 'push', keys: [poly[1].key], scope: full, dir: [0, 1, 0], n: -2, follow: false, backfill: 0 }] },
    { name: '兩個結構併成一個（merged-away 的外框不在 F 裡，S ≠ F）', ops: [{ kind: 'material', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, m: 0 }, pushBack], sNotF: true },
    { name: '整個結構換成空氣（步驟 8 有搬動）', ops: [{ kind: 'material', keys: [fin.key], scope: full, m: 0 }], moves: true, shrink: true },
  ];
  for (const c of cases)
    it(`${c.name}：和 applyOp 相同、before === 改前 labels 在 S 的裁片、快照 === F ≤ S`, () => {
      let a: EditState = base;
      let sa = 1000;
      let grew = false;
      let moved = false;
      let shrunk = false;
      for (const op0 of c.ops) {
        const op = typeof op0 === 'function' ? op0(a) : op0;
        let sb = sa;
        const labelsBefore = a.L.labels;
        const ref = applyOp(a, op, { orig: vol, matName, newKey: () => `c${sb++}` });
        const got = applyOpLocal(a, op, { orig: vol, matName, newKey: () => `c${sa++}` });
        const { snapshot, F, S } = relabelStats;
        expect(diffCount(got.state.vol.data, ref.vol.data)).toBe(0);
        sameStructures(got.state.L, ref.L);
        expect(got.step.data).not.toBeNull();
        const lp = got.step.labels!;
        expect(lp.box).toEqual(S);
        expect(diffCount(lp.before, cropArr(labelsBefore, vol, lp.box))).toBe(0);
        expect(snapshot).toBe(boxSize(F!));
        expect(boxSize(F!)).toBeLessThanOrEqual(boxSize(S!));
        if (boxSize(S!) > boxSize(F!)) grew = true;
        if (lp.moves.length) moved = true;
        // 快照不會比舊算法（Smax）大；刻意挑的案例要小一個數量級以上
        const smax = smaxOf(a.L, got.step.data!.box);
        expect(snapshot).toBeLessThanOrEqual(smax);
        if (snapshot * 10 < smax) shrunk = true;
        // 補丁往回貼回到改前
        const back = applyStep(got.state, got.step, 'back');
        expect(diffCount(back.L.labels, a.L.labels)).toBe(0);
        expect(back.L.comps).toEqual(a.L.comps);
        a = got.state;
      }
      if (c.sNotF) expect(grew).toBe(true);
      if (c.moves) expect(moved).toBe(true);
      if (c.shrink) expect(shrunk).toBe(true);
    }, 30_000);
});
