// plan v11 §4.4：疊圖的描輪廓快取、差異聯集外框、A vs B。
// plan v15 §7 C5：contourOf 只在 keys 的結構外框裡描 === 整片描；快取值含 diff、key 含基準版本；A vs B 的片 mask 快取。
import { describe, expect, it } from 'vitest';
import { type OverlayEntry, contourCache, contourOf, keysBox, overlayEntry, overlayKey, sliceDiff, sliceGeom, unionUV } from './overlay';
import { pairMask, pairMaskOf } from './slabs';
import { slabOfArrays } from '../../splits/lifecycle';
import type { Axis } from '../../volume/volume';
import { applyOp } from '../../volume/ops';
import { base, comp, ctx, full, ofMat, vol } from '../../volume/ops11.fixture';

describe('疊圖', () => {
  const poly2 = comp('Poly-Si 2');
  it('快取 key 含版本、軸、片、keys（順序無關）；同 key 只描一次', () => {
    expect(overlayKey(3, 'z', 10, ['b', 'a'])).toBe(overlayKey(3, 'z', 10, ['a', 'b']));
    expect(overlayKey(3, 'z', 10, ['a'])).not.toBe(overlayKey(4, 'z', 10, ['a']));
    const c = contourCache();
    let n = 0;
    const make = () => (n++, contourOf(base.L, vol, [poly2.key], 'y', 40));
    c.get('k', make);
    c.get('k', make);
    expect(n).toBe(1);
    expect(c.stats().hits).toBe(1);
  });
  it('輪廓：Poly-Si 2 在 XZ（y=20）是一個矩形環', () => {
    const loops = contourOf(base.L, vol, [poly2.key], 'y', 20);
    expect(loops.length).toBe(1);
    const us = loops[0].map((p) => p[0]);
    const vs = loops[0].map((p) => p[1]);
    expect([Math.min(...vs), Math.max(...vs)]).toEqual([poly2.bbox.z0, poly2.bbox.z1 + 1]);
    expect([Math.min(...us), Math.max(...us)]).toEqual([poly2.bbox.x0, poly2.bbox.x1 + 1]);
  });
  it('差異聯集外框＋邊距；A vs B 只差 1 格的地方', () => {
    const a = applyOp(base, { kind: 'cd', keys: [poly2.key], scope: full, axis: 2, delta: 2, anchor: 'center', follow: true, backfill: 'orig' }, ctx);
    const b = applyOp(base, { kind: 'cd', keys: [poly2.key], scope: full, axis: 2, delta: 4, anchor: 'center', follow: true, backfill: 'orig' }, ctx);
    const da = sliceDiff(a.vol.data, vol.data, vol, 'y', 20);
    const db = sliceDiff(b.vol.data, vol.data, vol, 'y', 20);
    expect(da.box).toBeTruthy();
    const u = unionUV([da.box, db.box, null], 4, vol.X, vol.Z)!;
    expect(u.v0).toBe(db.box!.v0 - 4);
    expect(unionUV([null], 4, vol.X, vol.Z)).toBeNull();
    // b 對 a：每一側只差 1 格
    const ab = sliceDiff(b.vol.data, a.vol.data, vol, 'y', 20);
    expect(ab.box!.v0).toBe(poly2.bbox.z0 - 2);
    expect(ab.box!.v1).toBe(poly2.bbox.z1 + 2);
    // A vs B 的片 mask（slabs.ts）：同版本對同片回同一個物件；內容 === 純函式 pairMask
    const sa = slabOfArrays(vol, a.vol.data, a.L.labels, a.L.comps, vol.data, 'y', 20);
    const sb = slabOfArrays(vol, b.vol.data, b.L.labels, b.L.comps, vol.data, 'y', 20);
    const p = pairMaskOf(1, sb.vol.data, 2, sa.vol.data, 'y', 20);
    expect(pairMaskOf(1, sb.vol.data, 2, sa.vol.data, 'y', 20)).toBe(p);
    expect(pairMaskOf(1, sb.vol.data, 2, sa.vol.data, 'y', 21)).not.toBe(p);
    const ref = pairMask(sb.vol.data, sa.vol.data);
    expect(p.count).toBe(ref.count);
    expect(p.count).toBe(ab.count);
    expect(p.mask).toEqual(ref.mask);
  });
});

describe('contourOf 只描 keys 的外框（plan v15 §5.6 C5）', () => {
  const poly2 = comp('Poly-Si 2');
  const a = applyOp(base, { kind: 'cd', keys: [poly2.key], scope: full, axis: 2, delta: 4, anchor: 'center', follow: true, backfill: 'orig' }, ctx);
  // 幾組 keys：單一結構、一個材質的全部、兩個材質、沒有這個 key
  const sets: string[][] = [[poly2.key], ofMat(poly2.mat).map((c) => c.key), [...ofMat(6), ...ofMat(poly2.mat)].map((c) => c.key), ['nope']];
  for (const axis of ['x', 'y', 'z'] as Axis[])
    it(`${axis}：keysBox 版、明寫 bbox 版 === 整片版（原始、改過的、slab）`, () => {
      const { W, H } = sliceGeom(vol, axis);
      const ats = axis === 'x' ? [0, 50, vol.X - 1] : axis === 'y' ? [0, 20, 40, vol.Y - 1] : [0, 64, vol.Z - 1];
      let nonEmpty = 0;
      for (const L of [base.L, a.L])
        for (const at of ats)
          for (const keys of sets) {
            const ref = contourOf(L, vol, keys, axis, at, 'full');
            const box = keysBox(L, keys, axis, W, H);
            expect(contourOf(L, vol, keys, axis, at)).toEqual(ref);
            expect(contourOf(L, vol, keys, axis, at, box ?? { u0: 0, v0: 0, u1: 0, v1: 0 })).toEqual(box ? ref : []);
            if (keys[0] === 'nope') expect(box).toBeNull();
            if (ref.length) nonEmpty++;
          }
      expect(nonEmpty).toBeGreaterThan(0);
      // slab（法線軸長度 1 的假 Volume、at＝0；comps 是整個陣列的外框）
      const at = ats[1];
      const sl = slabOfArrays(vol, a.vol.data, a.L.labels, a.L.comps, vol.data, axis, at);
      for (const keys of sets) expect(contourOf(sl.L, sl.vol, keys, axis, 0)).toEqual(contourOf(sl.L, sl.vol, keys, axis, 0, 'full'));
      expect(contourOf(sl.L, sl.vol, [poly2.key], axis, 0)).toEqual(contourOf(a.L, vol, [poly2.key], axis, at, 'full'));
    });
  it('快取值含 loops 與 diff；key 含基準版本；上限逐出最早的', () => {
    const sl = slabOfArrays(vol, a.vol.data, a.L.labels, a.L.comps, vol.data, 'y', 20);
    const e = overlayEntry(sl.L, sl.vol, sl.orig, [poly2.key], 'y', 0);
    expect(e.loops).toEqual(contourOf(a.L, vol, [poly2.key], 'y', 20, 'full'));
    expect(e.diff).toEqual(sliceDiff(a.vol.data, vol.data, vol, 'y', 20));
    expect(e.diff.count).toBeGreaterThan(0);
    // 同一個 split、同一片，基準不同就是不同的 key；沒給基準和舊版 key 相同
    expect(overlayKey(3, 'y', 20, ['a'], 1)).not.toBe(overlayKey(3, 'y', 20, ['a'], 2));
    expect(overlayKey(3, 'y', 20, ['a'], 1)).not.toBe(overlayKey(3, 'y', 20, ['a']));
    expect(overlayKey(3, 'y', 20, ['b', 'a'], 1)).toBe(overlayKey(3, 'y', 20, ['a', 'b'], 1));
    const c = contourCache<OverlayEntry>(2);
    const mk = (n: number) => () => ({ loops: [], diff: { box: null, count: n } });
    expect(c.get('a', mk(1)).diff.count).toBe(1);
    c.get('b', mk(2));
    c.get('c', mk(3));
    expect(c.stats().size).toBe(2);
    expect(c.get('a', mk(9)).diff.count).toBe(9);
    expect(c.get('c', mk(0)).diff.count).toBe(3);
  });
});

describe('sliceGeom 和 drawSlice 同方向（plan v12 修正 YZ）', () => {
  it('三軸的 (u, v) → index 和 sliceRGBA 的像素一一對應', async () => {
    const { sliceGeom } = await import('./overlay');
    const { sliceRGBA } = await import('./drawSlice');
    const vol = { X: 5, Y: 3, Z: 4, data: new Uint8Array(60).map((_, i) => i + 1) };
    const rgb = new Map(Array.from({ length: 61 }, (_, m) => [m, [m, 0, 0] as [number, number, number]]));
    for (const axis of ['x', 'y', 'z'] as const) {
      const { W, H, index } = sliceGeom(vol, axis);
      const img = sliceRGBA(vol, axis, 1, rgb, new Set(), null, null);
      for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) expect(img.data[(v * W + u) * 4]).toBe(vol.data[index(u, v, 1)]);
    }
  });
});
