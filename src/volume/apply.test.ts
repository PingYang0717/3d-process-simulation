import { describe, expect, it } from 'vitest';
import { type Labeled, MATERIALS, demoVolume, initialLabeled, maskOf, relabelFull } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { applyStep } from './patch';

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
