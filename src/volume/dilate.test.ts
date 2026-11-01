// plan v11 §4.6：dilate（保形層加厚／減薄，歐氏距離）。
import { describe, expect, it } from 'vitest';
import type { Op } from './ops';
import { offsetsWithin, thicknessOf } from './volume';
import { base, checkAll, count, maskKeys, ofMat, vol, expectSame } from './ops11.fixture';

const hf = ofMat(4);
const hf1 = hf[0];
const dil = (n: number, keys = [hf1.key], scope = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 }, follow = true): Op => ({ kind: 'dilate', keys, scope, n, metric: 'euclid', follow, backfill: 'orig' });

describe('dilate', () => {
  it('位移表：r=4 有 257 個、r=8 有 2,109 個（不含原點：256／2,108）', () => {
    expect(offsetsWithin(4).length + 1).toBe(257);
    expect(offsetsWithin(8).length + 1).toBe(2109);
  });
  it('HfO₂ 1 厚度量得到 2 格', () => {
    expect(thicknessOf(vol, maskKeys([hf1.key]), hf1.bbox)).toBe(2);
  });
  it('HfO₂ 1 +1：新格到原殼距離 ≤ 1、TiN 被推開、fin 與 poly 以外不變、角落（對角）有填', () => {
    const { real, report } = checkAll(dil(1));
    const m0 = maskKeys([hf1.key]);
    const { X, Y } = vol;
    let added = 0;
    let far = 0;
    for (let i = 0; i < vol.data.length; i++) {
      if (real.vol.data[i] !== 4 || vol.data[i] === 4) continue;
      added++;
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      let near = false;
      for (let dz = -1; dz <= 1 && !near; dz++)
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1 && !near; dx++)
            if (dx * dx + dy * dy + dz * dz <= 1 && m0[((z + dz) * Y + y + dy) * X + x + dx]) near = true;
      if (!near) far++;
    }
    expect(far).toBe(0);
    expect(added).toBeGreaterThan(0);
    expect(report.pushed).toBeGreaterThan(0);
    // fin（3）一格都不變
    expect(count(real.vol, 3)).toBe(count(vol, 3));
    let finMoved = 0;
    for (let i = 0; i < vol.data.length; i++) if (vol.data[i] === 3 && real.vol.data[i] !== 3) finMoved++;
    expect(finMoved).toBe(0);
    // 襯層 TiN 被推開：體積大致不變（每推一格，殼整列往外一格）
    expect(Math.abs(count(real.vol, 5) - count(vol, 5))).toBeLessThan(count(vol, 5) * 0.05);
  });
  it('歐氏 r=2：對角（距離 √2）的格子會填、距離 √8 的不會', () => {
    // 在空氣裡放一個 1 格的 TiN（tiny 結構，周圍全空氣）
    const X = 9, Y = 9, Z = 9;
    const data = new Uint8Array(X * Y * Z);
    data[(4 * Y + 4) * X + 4] = 5;
    const v = { X, Y, Z, data };
    const m = new Uint8Array(data.length);
    m[(4 * Y + 4) * X + 4] = 1;
    return import('./volume').then(({ dilateMask }) => {
      const out = dilateMask(v, v, m, { axis: 'z', lo: 0, hi: 8 }, 2, 'orig', false);
      const at = (x: number, y: number, z: number) => out.data[(z * Y + y) * X + x];
      expect(at(5, 5, 4)).toBe(5);
      expect(at(6, 4, 4)).toBe(5);
      expect(at(5, 5, 5)).toBe(5);
      expect(at(6, 6, 4)).toBe(0);
      let n = 0;
      for (const x of out.data) if (x === 5) n++;
      expect(n).toBe(offsetsWithin(2).length + 1);
    });
  });
  it('scope 只有 z 60～64 時其他片不變', () => {
    const sc = { axis: 'z' as const, lo: 60, hi: 64 };
    const k = hf.find((c) => c.bbox.z0 <= 60 && c.bbox.z1 >= 64)!;
    const { real } = checkAll(dil(1, [k.key], sc));
    let out = 0;
    for (let i = 0; i < vol.data.length; i++)
      if (real.vol.data[i] !== vol.data[i]) {
        const z = Math.floor(i / (vol.X * vol.Y));
        if (z < 60 || z > 64) out++;
      }
    expect(out).toBe(0);
  });
  it('−1：厚度 2 → 1，TiN 跟著退回；多個結構一起', () => {
    const { real } = checkAll(dil(-1));
    expect(count(real.vol, 4)).toBeLessThan(count(vol, 4));
    const after = real.L.comps.filter((c) => c.mat === 4 && c.key === hf1.key);
    expect(after.length).toBe(1);
    const t = thicknessOf(real.vol, (() => {
      const m = new Uint8Array(vol.data.length);
      for (let i = 0; i < m.length; i++) if (real.L.labels[i] >= 0 && real.L.comps[real.L.labels[i]].key === hf1.key) m[i] = 1;
      return m;
    })());
    expect(t).toBe(1);
    checkAll(dil(1, hf.slice(0, 3).map((c) => c.key)));
  });
  it('poly（厚）+1 碰到別的厚材質：被擋 > 0、fin 不變', () => {
    const poly = ofMat(6)[1];
    const { real, report } = checkAll(dil(1, [poly.key], undefined, false));
    expect(report.blocked).toBeGreaterThan(0);
    expect(count(real.vol, 3)).toBe(count(vol, 3));
    expect(count(real.vol, 2)).toBe(count(vol, 2));
  });
  it('base 狀態不變（純函式）', () => {
    expectSame(base.vol.data, vol.data);
  });
});

describe('dilate 候選排序（plan v15 D5）', () => {
  it('sortByDist（計數排序）=== comparator 排序 (best[p] − best[q]) || (p − q)，隨機 20 組', async () => {
    const { sortByDist } = await import('./volume');
    let rnd = 3;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let t = 0; t < 20; t++) {
      const n = 1 + Math.floor(rand() * 5000);
      const r2 = 1 + Math.floor(rand() * 64);
      const best = new Int32Array(n).fill(0x7fffffff);
      const src = new Int32Array(n).fill(-1);
      for (let k = 0; k < n; k++)
        if (rand() < 0.6) {
          best[k] = Math.floor(rand() * (r2 + 1));
          src[k] = Math.floor(rand() * 100);
        }
      const cand: number[] = [];
      for (let k = 0; k < n; k++) if (src[k] >= 0) cand.push(k);
      cand.sort((p, q) => best[p] - best[q] || p - q);
      expect(Array.from(sortByDist(best, src))).toEqual(cand);
    }
    expect(Array.from(sortByDist(new Int32Array(0), new Int32Array(0)))).toEqual([]);
  });
});
