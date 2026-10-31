// plan v11 §4.4：疊圖的描輪廓快取、差異聯集外框、A vs B。
import { describe, expect, it } from 'vitest';
import { contourCache, contourOf, diffPair, overlayKey, sliceDiff, unionUV } from './overlay';
import { applyOp } from '../../volume/ops';
import { base, comp, ctx, full, vol } from '../../volume/ops11.fixture';

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
    const p = diffPair(1, b.vol.data, 2, a.vol.data);
    expect(diffPair(1, b.vol.data, 2, a.vol.data)).toBe(p);
    const n = p.count;
    let ref = 0;
    for (let i = 0; i < vol.data.length; i++) if (a.vol.data[i] !== b.vol.data[i]) ref++;
    expect(n).toBe(ref);
  });
});
