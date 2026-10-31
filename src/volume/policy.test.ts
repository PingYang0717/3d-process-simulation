// plan v11 §4.10：push 的 policy。省略＝overwrite（和 v10 以前逐體素相同），block＝厚的別的材質擋住。
import { describe, expect, it } from 'vitest';
import { type Op, applyOp } from './ops';
import { growMask } from './volume';
import { legacyGrowMask } from './ref/legacy';
import { base, checkAll, comp, count, ctx, full, maskKeys, vol, expectSame } from './ops11.fixture';

describe('push policy', () => {
  const poly2 = comp('Poly-Si 2');
  const down = (policy?: 'block' | 'overwrite'): Op => ({ kind: 'push', keys: [poly2.key], scope: full, dir: [0, 1, 0], n: 5, follow: true, backfill: 'orig', ...(policy ? { policy } : {}) });
  it('沒有 policy 的 push 和舊版（ref/legacy）逐體素相同；overwrite 和省略相同', () => {
    const m = maskKeys([poly2.key]);
    for (const [dir, n] of [[[0, 1, 0], 5], [[0, -1, 0], 3], [[1, 0, 0], -2]] as const) {
      const a = growMask(vol, vol, m, full, [...dir], n, 'orig', true);
      expectSame(a.data, legacyGrowMask(vol, vol, m, full, [...dir], n, 'orig', true).data);
    }
    expectSame(applyOp(base, down(), ctx).vol.data, applyOp(base, down('overwrite'), ctx).vol.data);
  });
  it('block：Poly-Si 2 往下長 5 被擋、STI 體積不變；overwrite 會吃掉 STI', () => {
    const { real, report } = checkAll(down('block'));
    expect(report.blocked).toBeGreaterThan(0);
    expect(count(real.vol, 2)).toBe(count(vol, 2));
    expect(count(applyOp(base, down(), ctx).vol, 2)).toBeLessThan(count(vol, 2));
  });
  it('block 不會從擋住的格子再往前長（穿過薄的鄰居）', () => {
    // 往上長：上面是 SiN（4 格、薄）→ follow 關掉時擋住，n 大於 SiN 厚度也不會長到 SiN 上面的空氣
    const op: Op = { kind: 'push', keys: [poly2.key], scope: full, dir: [0, -1, 0], n: 8, follow: false, backfill: 'orig', policy: 'block' };
    const { real } = checkAll(op);
    expect(count(real.vol, 6)).toBe(count(vol, 6));
  });
});
