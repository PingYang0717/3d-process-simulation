// plan v9 P10：maskOf／maskInScope／slicesWith 只掃選取外框，結果和掃整個陣列相同。
import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled, maskOf, unionBBox } from '../../volume/volume';
import { matNameOf } from '../../volume/ops';
import { maskInScope, slicesWith } from './editor';

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

describe('選取外框掃描（plan v9 P10）', () => {
  const vol = demoVolume();
  const L = initialLabeled(vol, matNameOf(MATERIALS));
  const picks = [
    L.comps.filter((c) => c.mat === 6).slice(0, 2),
    L.comps.filter((c) => c.mat === 3).slice(0, 1),
    [L.comps.reduce((a, c) => (c.count > a.count ? c : a))],
  ];
  it('maskOf(L, keys, dims) === maskOf(L, keys)；maskInScope、slicesWith 帶外框結果相同', () => {
    for (const comps of picks) {
      const keys = new Set(comps.map((c) => c.key));
      const full = maskOf(L, keys)!;
      const fast = maskOf(L, keys, vol)!;
      expect(same(full, fast)).toBe(true);
      const box = unionBBox(comps);
      for (const scope of [
        { axis: 'z' as const, lo: 0, hi: vol.Z - 1 },
        { axis: 'z' as const, lo: 50, hi: 60 },
        { axis: 'x' as const, lo: 30, hi: 31 },
        { axis: 'y' as const, lo: 20, hi: 80 },
      ])
        expect(same(maskInScope(full, vol, scope), maskInScope(full, vol, scope, box))).toBe(true);
      for (const axis of ['x', 'y', 'z'] as const) expect(same(slicesWith(full, vol, axis), slicesWith(full, vol, axis, box))).toBe(true);
    }
    expect(maskOf(L, new Set(['nope']), vol)!.some((v) => v)).toBe(false);
  });
});

describe('selMask 原地維護（plan v15 A1）', () => {
  it('隨機 20 步（含 moves、併結構、復原）：patchMask 維護的 mask === maskOf、aff === maskInScope；canPatchMask 擋掉的才重建', async () => {
    const { applyOpInPlace } = await import('../../volume/apply');
    const { applyStepInPlace } = await import('../../volume/patch');
    const { stepTouch } = await import('../../splits/lifecycle');
    const { patchMask } = await import('../../volume/volume');
    const { canPatchMask } = await import('./editor');
    const vol = demoVolume();
    const matName = matNameOf(MATERIALS);
    const L0 = initialLabeled(vol, matName);
    const data = vol.data.slice();
    const labels = L0.labels.slice();
    let comps = L0.comps;
    const sub = comps.reduce((a, c) => (c.count > a.count ? c : a));
    const fin = comps.find((c) => c.mat === 3)!;
    const polys = comps.filter((c) => c.mat === 6);
    const sel = new Set([sub.key, fin.key, polys[0].key, polys[2].key]);
    const scope = { axis: 'z' as const, lo: 20, hi: 70 };
    const plane = vol.X * vol.Y;
    const inScope = (i: number) => {
      const z = Math.floor(i / plane);
      return z >= scope.lo && z <= scope.hi;
    };
    const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
    const selBoxOf = (cs: typeof comps) => unionBBox(cs.filter((c) => sel.has(c.key)));
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    const Lnow = () => ({ labels, comps });
    let mask = maskOf(Lnow(), sel, vol)!;
    let aff = maskInScope(mask, vol, scope, selBoxOf(comps));
    const ops: import('../../volume/ops').Op[] = [
      { kind: 'push', keys: [fin.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' },
      { kind: 'material', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, m: 0 },
      { kind: 'translate', keys: [polys[2].key], scope: full, d: [3, 0, 0], backfill: 'orig' },
      { kind: 'push', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 64 }, dir: [0, 0, 1], n: 5, follow: false, backfill: 'orig' },
      { kind: 'material', keys: [polys[1].key], scope: full, m: 0 },
      { kind: 'push', keys: [sub.key], scope: { axis: 'z', lo: 10, hi: 30 }, dir: [0, -1, 0], n: 2, follow: false, backfill: 'orig' },
      { kind: 'material', keys: [polys[0].key], scope: { axis: 'z', lo: 20, hi: 22 }, m: 254 },
      { kind: 'translate', keys: [polys[0].key], scope: full, d: [0, 0, 1], backfill: 'orig' },
      { kind: 'push', keys: [sub.key], scope: full, dir: [0, 1, 0], n: -1, follow: false, backfill: 0 },
    ];
    const hist: { step: import('../../volume/patch').Step }[] = [];
    let patched = 0;
    let rebuilt = 0;
    let backs = 0;
    const after = (prev: typeof comps, box: import('../../volume/volume').BBox) => {
      if (canPatchMask(prev, comps, sel, box)) {
        const on = new Uint8Array(comps.length);
        comps.forEach((c, i) => {
          if (sel.has(c.key)) on[i] = 1;
        });
        patchMask(mask, labels, on, vol, box);
        patchMask(aff, labels, on, vol, box, inScope);
        patched++;
      } else {
        mask = maskOf(Lnow(), sel, vol)!;
        aff = maskInScope(mask, vol, scope, selBoxOf(comps));
        rebuilt++;
      }
      const want = maskOf(Lnow(), sel, vol)!;
      expect(same(mask, want)).toBe(true);
      expect(same(aff, maskInScope(want, vol, scope, selBoxOf(comps)))).toBe(true);
    };
    let rnd = 5;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 20; k++) {
      if (rand() < 0.25 && hist.length) {
        const { step } = hist.pop()!;
        const prev = comps;
        comps = applyStepInPlace(vol, data, labels, step, 'back') ?? comps;
        after(prev, stepTouch(step)!);
        backs++;
        continue;
      }
      const op = ops[k % ops.length];
      const prev = comps;
      const res = applyOpInPlace({ vol: { ...vol, data }, L: { labels, comps } }, op, ctx);
      if (!res.step.data) continue;
      comps = res.comps;
      hist.push({ step: res.step });
      after(prev, stepTouch(res.step)!);
    }
    expect(backs).toBeGreaterThan(0);
    expect(patched).toBeGreaterThan(rebuilt);
    expect(patched + rebuilt).toBeGreaterThanOrEqual(12);
  }, 60_000);
});
