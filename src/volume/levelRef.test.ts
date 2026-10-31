// plan v11 §4.9：level 的相對參照（相對 recess）。apply 只看 to；ref 只給描述、factor、範本。
import { describe, expect, it } from 'vitest';
import { type Op, applyOp, levelRefTo } from './ops';
import { base, checkAll, comp, ctx, expectSame, full } from './ops11.fixture';

describe('level ref', () => {
  const sti = comp('STI SiO₂ 1');
  const fin = comp('Si fin 1');
  it('「STI 1 頂面相對 Si fin 1 頂 +6」算出 to = fin 頂 + 6；把 ref 刪掉重播相同', () => {
    const ref = { key: fin.key, side: 'lo' as const, offset: 6 };
    const to = levelRefTo(base.L, [0, -1, 0], ref)!;
    expect(to).toBe(fin.bbox.y0 + 6);
    const b = sti.bbox;
    const op: Op = { kind: 'level', keys: [sti.key], scope: full, dir: [0, -1, 0], to, local: { center: [(b.x0 + b.x1) >> 1, b.y0, (b.z0 + b.z1) >> 1], radius: null }, backfill: 'orig', follow: true, ref };
    const { real } = checkAll(op);
    const { ref: _r, ...noRef } = op as Extract<Op, { kind: 'level' }>;
    expectSame(applyOp(base, noRef as Op, ctx).vol.data, real.vol.data);
    const after = real.L.comps.find((c) => c.key === sti.key)!;
    expect(after.bbox.y0).toBe(to);
  });
});
