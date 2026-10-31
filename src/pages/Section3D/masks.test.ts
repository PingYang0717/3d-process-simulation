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
