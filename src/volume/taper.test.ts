// plan v11 §4.8：taper（側壁斜度）展開成每一段的 push。
import { describe, expect, it } from 'vitest';
import type { Scope } from './scope';
import { type Op, type TaperOp, applyOp, replay, taperDelta, taperSteps } from './ops';
import { base, checkAll, comp, ctx, full, expectSame } from './ops11.fixture';

const poly2 = comp('Poly-Si 2');
const taper = (top: number, bottom: number, both = false, scope: Scope = full): TaperOp => ({ kind: 'taper', keys: [poly2.key], scope, face: [0, 0, 1], along: 1, top, bottom, both, follow: true, backfill: 'orig' });

describe('taper', () => {
  it('頂 −1 底 +2：每片 delta 等於 lerp 取整、相鄰同值合成一段', () => {
    const b = poly2.bbox;
    const steps = taperSteps(taper(-1, 2), b);
    for (let y = b.y0; y <= b.y1; y++) {
      const st = steps.find((s) => y >= s.scope.lo && y <= s.scope.hi);
      const d = taperDelta(-1, 2, b.y0, b.y1, y);
      if (d) expect(st?.n).toBe(d);
      else expect(st).toBeUndefined();
    }
    expect(steps.every((s) => s.scope.axis === 'y')).toBe(true);
    // 段數：-1、0、1、2 四種值，0 不出 push
    expect(steps.length).toBe(3);
  });
  it('和手動逐段 push 逐體素相同；both 是對面鏡像', () => {
    const op = taper(-1, 2);
    const manual: Op[] = taperSteps(op, poly2.bbox).map((s) => ({ kind: 'push', keys: [poly2.key], scope: s.scope, dir: s.dir, n: s.n, follow: true, backfill: 'orig' }));
    expectSame(applyOp(base, op, ctx).vol.data, replay(base, manual, ctx).vol.data);
    const both = taperSteps(taper(-1, 2, true), poly2.bbox);
    expect(both.length).toBe(6);
    expect(both.slice(3).every((s) => s.dir[2] === -1)).toBe(true);
    // 側面切面是斜的：頂那一片 z1 少 1、底那一片多 2
    const L = applyOp(base, taper(-1, 2, true), ctx);
    const z1At = (y: number) => {
      let z1 = -1;
      for (let z = 40; z < 85; z++) if (L.vol.data[(z * L.vol.Y + y) * L.vol.X + 80] === 6) z1 = z;
      return z1;
    };
    expect(z1At(poly2.bbox.y0)).toBe(poly2.bbox.z1 - 1);
    expect(z1At(poly2.bbox.y0 + 2)).toBe(poly2.bbox.z1 - 1);
    // 底：y1 那一片多 2（x 20 那一列沒有 fin）
    const z1At20 = (y: number) => {
      let z1 = -1;
      for (let z = 40; z < 85; z++) if (L.vol.data[(z * L.vol.Y + y) * L.vol.X + 20] === 6) z1 = z;
      return z1;
    };
    expect(z1At20(poly2.bbox.y1)).toBe(poly2.bbox.z1 + 2);
  });
  it('scope 只取一段時插值仍按整根算、範圍外不變；預覽相同', () => {
    const sc = { axis: 'x' as const, lo: 20, hi: 60 };
    const { real } = checkAll(taper(-1, 2, true, sc));
    let out = 0;
    for (let i = 0; i < real.vol.data.length; i++)
      if (real.vol.data[i] !== base.vol.data[i]) {
        const x = i % base.vol.X;
        if (x < 20 || x > 60) out++;
      }
    expect(out).toBe(0);
    checkAll(taper(2, -2));
    checkAll({ ...taper(1, 3), policy: 'block' });
  });
});
