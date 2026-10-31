// plan v11 §4.5：cd（對稱 CD 偏差）＝兩個 push。
import { describe, expect, it } from 'vitest';
import type { Op } from './ops';
import { applyOp, replay } from './ops';
import { base, checkAll, comp, ctx, full, expectSame } from './ops11.fixture';

const poly2 = () => comp('Poly-Si 2');
const push = (dir: [number, number, number], n: number, policy?: 'block' | 'overwrite'): Op => ({ kind: 'push', keys: [poly2().key], scope: full, dir, n, follow: true, backfill: 'orig', ...(policy ? { policy } : {}) });
const cd = (delta: number, anchor: 'center' | 'lo' | 'hi' = 'center', policy?: 'block' | 'overwrite'): Op => ({ kind: 'cd', keys: [poly2().key], scope: full, axis: 2, delta, anchor, follow: true, backfill: 'orig', ...(policy ? { policy } : {}) });

describe('cd', () => {
  it('+2 center ≡ push lo +1 再 push hi +1；W 24 → 26', () => {
    const a = applyOp(base, cd(2), ctx);
    const b = replay(base, [push([0, 0, -1], 1), push([0, 0, 1], 1)], ctx);
    expectSame(a.vol.data, b.vol.data);
    const c = a.L.comps.find((x) => x.key === poly2().key)!;
    expect(c.bbox.z1 - c.bbox.z0 + 1).toBe(26);
    expect([c.bbox.z0, c.bbox.z1]).toEqual([poly2().bbox.z0 - 1, poly2().bbox.z1 + 1]);
  });
  it('+3 center：多的一格在 hi 側；−2 兩側各縮 1', () => {
    const a = applyOp(base, cd(3), ctx);
    const c = a.L.comps.find((x) => x.key === poly2().key)!;
    expect([c.bbox.z0, c.bbox.z1]).toEqual([poly2().bbox.z0 - 1, poly2().bbox.z1 + 2]);
    const b = applyOp(base, cd(-2), ctx);
    const d = b.L.comps.find((x) => x.key === poly2().key)!;
    expect([d.bbox.z0, d.bbox.z1]).toEqual([poly2().bbox.z0 + 1, poly2().bbox.z1 - 1]);
    expectSame(b.vol.data, replay(base, [push([0, 0, -1], -1), push([0, 0, 1], -1)], ctx).vol.data);
  });
  it('anchor lo＝只推 hi 側、anchor hi＝只推 lo 側', () => {
    expectSame(applyOp(base, cd(2, 'lo'), ctx).vol.data, applyOp(base, push([0, 0, 1], 2), ctx).vol.data);
    expectSame(applyOp(base, cd(2, 'hi'), ctx).vol.data, applyOp(base, push([0, 0, -1], 2), ctx).vol.data);
  });
  it('預覽與 Worker 路徑相同；被擋計數＝兩個 push 相加（block）', () => {
    checkAll(cd(2));
    checkAll(cd(-3));
    // x 方向的 cd 會碰到別的東西：block 時被擋數 = 兩次 push 的被擋數相加
    const xop: Op = { kind: 'cd', keys: [poly2().key], scope: full, axis: 0, delta: 4, anchor: 'center', follow: false, backfill: 'orig', policy: 'block' };
    const { report } = checkAll(xop);
    const lo = checkAll({ kind: 'push', keys: [poly2().key], scope: full, dir: [-1, 0, 0], n: 2, follow: false, backfill: 'orig', policy: 'block' });
    const s1 = lo.real;
    const hi = checkAll({ kind: 'push', keys: [poly2().key], scope: full, dir: [1, 0, 0], n: 2, follow: false, backfill: 'orig', policy: 'block' }, s1);
    expect(report.blocked).toBe(lo.report.blocked + hi.report.blocked);
  });
});
