// plan v11 §4.7：defect（缺陷注入）。
import { describe, expect, it } from 'vitest';
import { type Op, defectBox } from './ops';
import { VOID, inDefect } from './volume';
import { base, checkAll, comp, vol } from './ops11.fixture';

const poly3 = comp('Poly-Si 3');
const op = (shape: 'slab' | 'sphere' | 'box', size: [number, number, number], center: [number, number, number] = [0.5, 0.5, 0.5]): Op => ({
  kind: 'defect',
  keys: [poly3.key],
  scope: { axis: 'z', lo: 0, hi: vol.Z - 1 },
  shape,
  center,
  size,
  mat: VOID,
  abs: defectBox(poly3.bbox, center, size)!,
});

describe('defect', () => {
  it('slab 20×1×30（fin 上方）：只改 host 內、abs 內的格子', () => {
    const o = op('slab', [20, 1, 30], [0.5, 0.15, 0.5]) as Extract<Op, { kind: 'defect' }>;
    expect(o.abs.x1 - o.abs.x0 + 1).toBe(20);
    expect(o.abs.y1 - o.abs.y0 + 1).toBe(1);
    const { real } = checkAll(o);
    let n = 0;
    let bad = 0;
    for (let i = 0; i < vol.data.length; i++) {
      if (real.vol.data[i] === vol.data[i]) continue;
      n++;
      if (vol.data[i] !== 6 || real.vol.data[i] !== VOID || base.L.comps[base.L.labels[i]].key !== poly3.key) bad++;
    }
    expect(bad).toBe(0);
    expect(n).toBeGreaterThan(0);
  });
  it('sphere 是內切橢球（比 box 少）', () => {
    const b = { x0: 0, x1: 9, y0: 0, y1: 9, z0: 0, z1: 9 };
    let s = 0;
    for (let z = 0; z < 10; z++) for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (inDefect('sphere', b, x, y, z)) s++;
    expect(s).toBeLessThan(1000);
    expect(s).toBeGreaterThan(400);
    expect(inDefect('sphere', b, 0, 0, 0)).toBe(false);
    expect(inDefect('sphere', b, 4, 4, 4)).toBe(true);
    checkAll(op('sphere', [10, 10, 10]));
  });
  it('size 0 沒有缺陷（defectBox 回 null）', () => {
    expect(defectBox(poly3.bbox, [0.5, 0.5, 0.5], [0, 1, 1])).toBeNull();
  });
});
