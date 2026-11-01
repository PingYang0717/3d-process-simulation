// plan v12 §7：split 生命週期。extractPatch → applyPatch ≡ live；Worker restore ≡ replay；slabOf 三軸 ≡ 從完整陣列切；
// replayPatch 的補丁 ≡ live 重播後 extractPatch、scratch 連續重播互不汙染；applyParked ≡ restore → apply → extractPatch；K 政策。
import { describe, expect, it } from 'vitest';
import { type Axis, type Comp, MATERIALS } from '../volume/volume';
import { type Book, handle, inspect } from '../volume/workerCore';
import type { Op } from '../volume/ops';
import { base, comp, vol } from '../volume/ops11.fixture';
import { type SplitPatch, type SplitStats, applyPatch, cutSlab, defaultLiveK, extractPatch, restoreBuffers, slabOfArrays, slabOfPatch, toPark } from './lifecycle';

const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const keyBoxes = (cs: Comp[]) => cs.map((c) => `${c.key}|${c.mat}|${c.count}|${c.bbox.x0},${c.bbox.x1},${c.bbox.y0},${c.bbox.y1},${c.bbox.z0},${c.bbox.z1}`).sort();

const p2 = () => comp('Poly-Si 2');
const p3 = () => comp('Poly-Si 3');
const fin = () => base.L.comps.find((c) => c.label.startsWith('Si fin'))!;
const SETS: Op[][] = [
  [{ kind: 'push', keys: [p2().key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' }],
  [
    { kind: 'cd', keys: [p2().key], scope: full, axis: 2, delta: 2, anchor: 'center', follow: true, backfill: 'orig', policy: 'block' },
    { kind: 'translate', keys: [p2().key], scope: full, d: [0, 0, 1], backfill: 'orig' },
  ],
  [{ kind: 'translate', keys: [p3().key], scope: full, d: [4, 0, 0], backfill: 'orig' }],
  [{ kind: 'push', keys: [fin().key], scope: full, dir: [1, 0, 0], n: 2, follow: true, backfill: 'orig', policy: 'overwrite' }],
];

function load() {
  handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
  return inspect().books.get('base')!;
}
const live = (owner: string, to: number, ops: Op[]) => {
  const r = handle('replay', { owner, src: 'base', from: 1, to, comps: base.L.comps, ops, matNames, keyCounter: 1000 })[0] as { comps: Comp[] };
  return { book: inspect().books.get(owner)!, comps: r.comps };
};

describe('split 生命週期（plan v12 §5.3）', () => {
  it('extractPatch → applyPatch 到原始複本 ≡ live 帳簿（data、labels）；restoreBuffers 的 diff／體積帳 ≡ live', () => {
    const o = load();
    SETS.forEach((ops, k) => {
      const { book, comps } = live(`s${k}`, 10 + k, ops);
      const p = extractPatch(vol, book.data, book.labels, o.data, o.labels, book.touch, comps);
      expect(p.box).not.toBeNull();
      const data = o.data.slice();
      const labels = o.labels.slice();
      applyPatch(vol, data, labels, p);
      expect(same(data, book.data)).toBe(true);
      expect(same(labels, book.labels)).toBe(true);
      const r = restoreBuffers(vol, o.data, o.labels, o.counts, p);
      expect(same(r.diff, book.diff!)).toBe(true);
      expect(r.diffCount).toBe(book.diffCount);
      expect(same(r.counts, book.counts)).toBe(true);
    });
  });

  it('Worker restore ≡ replay（data、labels、diff、counts）；之後的 apply 一樣能接著算', () => {
    const o = load();
    const { book, comps } = live('s1', 10, SETS[1]);
    const p = extractPatch(vol, book.data, book.labels, o.data, o.labels, book.touch, comps);
    handle('restore', { owner: 'r1', sid: 20, patch: p });
    const r = inspect().books.get('r1')!;
    for (const k of ['data', 'labels', 'diff', 'counts'] as const) expect(same(r[k]!, book[k]!)).toBe(true);
    expect(r.diffCount).toBe(book.diffCount);
    expect(handle('diffBox', { sid: 20 })[0]).toEqual(handle('diffBox', { sid: 10 })[0]);
    const op: Op = { kind: 'push', keys: [p3().key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' };
    handle('apply', { owner: 'r1', from: 20, to: 21, comps, op, matNames, keyCounter: 2000 });
    handle('apply', { owner: 's1', from: 10, to: 11, comps, op, matNames, keyCounter: 2000 });
    expect(same(inspect().books.get('r1')!.data, inspect().books.get('s1')!.data)).toBe(true);
  });

  it('slabOf 三軸任一片 ≡ 從完整陣列切的那一片（data、labels、diff）', () => {
    const o = load();
    const { book, comps } = live('s1', 10, SETS[1]);
    const p = extractPatch(vol, book.data, book.labels, o.data, o.labels, book.touch, comps);
    const b = p.box!;
    for (const axis of ['x', 'y', 'z'] as Axis[]) {
      const lo = axis === 'x' ? b.x0 : axis === 'y' ? b.y0 : b.z0;
      const hi = axis === 'x' ? b.x1 : axis === 'y' ? b.y1 : b.z1;
      for (const at of [0, lo, (lo + hi) >> 1, hi]) {
        const s = slabOfPatch(vol, o.data, o.labels, p, axis, at);
        const want = slabOfArrays(vol, book.data, book.labels, comps, o.data, axis, at);
        expect(same(s.vol.data, want.vol.data)).toBe(true);
        expect(same(s.L.labels, want.L.labels)).toBe(true);
        expect(same(s.diff, cutSlab(book.diff!, vol, axis, at))).toBe(true);
        expect(s.diffCount).toBe(want.diffCount);
      }
    }
  });

  it('replayPatch ≡ live 重播後 extractPatch；scratch 連續重播 4 個 split 互不汙染；park 後 ops 不變', () => {
    const o = load();
    const pats = SETS.map((ops) => handle('replayPatch', { src: 'base', from: 1, comps: base.L.comps, ops, matNames, keyCounter: 1000 })[0] as { patch: SplitPatch; stats: SplitStats });
    // Worker 沒有多留帳簿
    expect([...inspect().books.keys()]).toEqual(['base']);
    SETS.forEach((ops, k) => {
      const { book, comps } = live(`s${k}`, 10 + k, ops);
      const want = extractPatch(vol, book.data, book.labels, o.data, o.labels, book.touch, comps);
      expect(pats[k].patch.box).toEqual(want.box);
      expect(same(pats[k].patch.data, want.data)).toBe(true);
      expect(same(pats[k].patch.labels, want.labels)).toBe(true);
      expect(keyBoxes(pats[k].patch.comps)).toEqual(keyBoxes(comps));
      expect(pats[k].stats.changed).toBe(book.diffCount);
      expect(same(pats[k].stats.counts, book.counts)).toBe(true);
    });
  });

  it('replayPatch 從別的 split 開始（接在目前 split 之後）≡ live 重播 prefix＋ops', () => {
    load();
    live('a', 10, SETS[0]);
    const comps0 = (handle('replay', { owner: 'a', src: 'base', from: 1, to: 11, comps: base.L.comps, ops: SETS[0], matNames, keyCounter: 1000 })[0] as { comps: Comp[] }).comps;
    const r = handle('replayPatch', { src: 'a', from: 11, comps: comps0, ops: SETS[2], matNames, keyCounter: 1000 })[0] as { patch: SplitPatch };
    const { book } = live('b', 12, [...SETS[0], ...SETS[2]]);
    const o = inspect().books.get('base')!;
    const data = o.data.slice();
    const labels = o.labels.slice();
    applyPatch(vol, data, labels, r.patch);
    expect(same(data, book.data)).toBe(true);
  });

  it('applyParked ≡ restore → apply → extractPatch', () => {
    const o = load();
    const p = (handle('replayPatch', { src: 'base', from: 1, comps: base.L.comps, ops: SETS[0], matNames, keyCounter: 1000 })[0] as { patch: SplitPatch }).patch;
    const extra: Op[] = [{ kind: 'translate', keys: [p3().key], scope: full, d: [0, 0, 2], backfill: 'orig' }];
    const r = handle('applyParked', { patch: p, ops: extra, matNames, keyCounter: 3000 })[0] as { patch: SplitPatch; changed: number[] };
    handle('restore', { owner: 'x', sid: 30, patch: p });
    handle('apply', { owner: 'x', from: 30, to: 31, comps: p.comps, op: extra[0], matNames, keyCounter: 3000 });
    const b: Book = inspect().books.get('x')!;
    const want = extractPatch(vol, b.data, b.labels, o.data, o.labels, b.touch, p.comps);
    expect(r.patch.box).toEqual(want.box);
    expect(same(r.patch.data, want.data)).toBe(true);
    expect(r.changed[0]).toBeGreaterThan(0);
  });

  it('K 政策：active 與 pinned 一定留；其他照最近用過的順序留到 K 個', () => {
    expect(defaultLiveK(2e6)).toBe(8);
    expect(defaultLiveK(15.7e6)).toBe(3);
    expect(defaultLiveK(4e7)).toBe(1);
    const live = ['a', 'b', 'c', 'd'];
    expect(toPark(live, ['c', 'a', 'b', 'd'], 2, 'a')).toEqual(['b', 'd']);
    expect(toPark(live, ['c', 'a', 'b', 'd'], 1, 'd')).toEqual(['a', 'b', 'c']);
    expect(toPark(live, ['b'], 1, 'a', ['c'])).toEqual(['b', 'd']);
    expect(toPark(live, [], 8, 'a')).toEqual([]);
  });
});

describe('axes（plan v15 A2）', () => {
  it('restoreBuffers 的 axes → diffBoxOfAxes === tightBox；和 Worker restore 的帳簿相同', async () => {
    const { diffBoxOfAxes, tightBox } = await import('../volume/patch');
    const o = load();
    SETS.forEach((ops, k) => {
      const { book, comps } = live(`ax${k}`, 40 + k, ops);
      const p = extractPatch(vol, book.data, book.labels, o.data, o.labels, book.touch, comps);
      const r = restoreBuffers(vol, o.data, o.labels, o.counts, p);
      expect(diffBoxOfAxes(r.axes)).toEqual(tightBox(vol, r.diff, r.touch));
      expect(diffBoxOfAxes(book.axes)).toEqual(tightBox(vol, book.diff!, book.touch));
      handle('restore', { owner: `rx${k}`, sid: 60 + k, patch: p });
      const b = inspect().books.get(`rx${k}`)!;
      expect(same(b.axes.x, r.axes.x) && same(b.axes.y, r.axes.y) && same(b.axes.z, r.axes.z)).toBe(true);
    });
  });
});
