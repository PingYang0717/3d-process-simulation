import { describe, expect, it } from 'vitest';
import { demoComplexVolume } from './demoComplex';
import { AIR, MATERIALS, VOID, type Volume, countArray, labelComponents } from './volume';

const vol = demoComplexVolume();
const at = (v: Volume, x: number, y: number, z: number) => v.data[(z * v.Y + y) * v.X + x];
/** 在 (y, z) 這一列、x 在 [x0, x1) 裡材質 mat 的格數。 */
const rowCount = (v: Volume, mat: number, y: number, z: number, x0: number, x1: number) => {
  let n = 0;
  for (let x = x0; x < x1; x++) if (at(v, x, y, z) === mat) n++;
  return n;
};
const sameData = (a: Volume, b: Volume) => {
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
};
const FIN_BANDS: [number, number][] = [
  [20, 60],
  [60, 100],
  [100, 140],
];

describe('demoComplexVolume（複雜範例）', () => {
  it('尺寸和 demoVolume 相同：160×96×128，scale 逐軸放大', () => {
    expect([vol.X, vol.Y, vol.Z]).toEqual([160, 96, 128]);
    expect(vol.data.length).toBe(160 * 96 * 128);
    const v2 = demoComplexVolume(2);
    expect([v2.X, v2.Y, v2.Z]).toEqual([320, 192, 256]);
  });

  it('材質編號只有 0～10 與 VOID；新材質 SiGe epi／W／SiO₂ ILD 都有出現，而且都在 MATERIALS 裡', () => {
    const counts = countArray(vol.data);
    counts.forEach((c, id) => {
      if (c) expect(id <= 10 || id === VOID).toBe(true);
    });
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, VOID]) expect(counts[id]).toBeGreaterThan(0);
    expect(MATERIALS.find((m) => m.id === 8)?.name).toBe('SiGe epi');
    expect(MATERIALS.find((m) => m.id === 9)?.name).toBe('W');
    expect(MATERIALS.find((m) => m.id === 10)?.name).toBe('SiO₂ ILD');
    // 名稱表裡的每個編號都不一樣
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length);
  });

  it('三根 fin 寬度不同（gate 0 下 y = 48 那一列）、高度不同，gate CD 不同', () => {
    const widths = FIN_BANDS.map(([x0, x1]) => rowCount(vol, 3, 48, 26, x0, x1));
    expect(new Set(widths).size).toBe(3);
    // 中間那根最窄、右邊那根最寬
    expect(widths[1]).toBeLessThan(widths[0]);
    expect(widths[0]).toBeLessThan(widths[2]);
    // fin 頂（gate 0 下，材質 3 最小的 y）
    const tops = FIN_BANDS.map(([x0, x1]) => {
      for (let y = 0; y < vol.Y; y++) if (rowCount(vol, 3, y, 26, x0, x1)) return y;
      return -1;
    });
    expect(new Set(tops).size).toBe(3);
    // gate CD：x = 20、y = 20 這條線上 Poly-Si 連續段的長度（三根都不一樣）
    const runs: number[] = [];
    for (let z = 0, run = 0; z <= vol.Z; z++) {
      if (z < vol.Z && at(vol, 20, 20, z) === 6) run++;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    expect(runs.length).toBe(3);
    expect(new Set(runs).size).toBe(3);
    expect(runs[1]).toBeLessThan(runs[0]);
  });

  it('cap 頂以上全是空氣、以下沒有空氣（ILD 填滿）', () => {
    const plane = vol.X * vol.Y;
    let airAbove = 0;
    let airBelow = 0;
    for (let z = 0; z < vol.Z; z++) {
      for (let i = z * plane; i < z * plane + 12 * vol.X; i++) if (vol.data[i] === AIR) airAbove++;
      for (let i = z * plane + 12 * vol.X; i < (z + 1) * plane; i++) if (vol.data[i] === AIR) airBelow++;
    }
    expect(airAbove).toBe(12 * vol.X * vol.Z);
    expect(airBelow).toBe(0);
  });

  it('缺陷都在：HfO₂ 針孔（TiN 直接碰到 fin）、Si 橋把兩根 fin 連起來、poly 裡有 VOID 片、W 裡有 VOID 縫', () => {
    const { X, Y, Z, data } = vol;
    let tinOnFin = 0;
    let voidInPoly = 0;
    let voidInW = 0;
    for (let z = 1; z < Z - 1; z++)
      for (let y = 1; y < Y - 1; y++)
        for (let x = 1; x < X - 1; x++) {
          const i = (z * Y + y) * X + x;
          const v = data[i];
          if (v === 5 && (data[i - 1] === 3 || data[i + 1] === 3 || data[i - X] === 3 || data[i + X] === 3)) tinOnFin++;
          if (v === VOID && data[i - X * Y] === 6 && data[i + X * Y] === 6) voidInPoly++;
          if (v === VOID && data[i - 1] === 9 && data[i + 1] === 9) voidInW++;
        }
    expect(tinOnFin).toBeGreaterThan(0);
    expect(voidInPoly).toBeGreaterThan(100);
    expect(voidInW).toBeGreaterThan(0);
  });

  it('決定性：兩次產生逐體素相同；scale 1 在 1.5 s 內', () => {
    const t0 = performance.now();
    const a = demoComplexVolume(1);
    const dt = performance.now() - t0;
    expect(dt).toBeLessThan(1500);
    const b = demoComplexVolume(1);
    expect(sameData(a, b)).toBe(true);
    expect(sameData(a, vol)).toBe(true);
  });

  it('連通塊數量合理（20～400），襯層／spacer 沒被粗糙度切碎', () => {
    const { raw } = labelComponents(vol);
    expect(raw.length).toBeGreaterThanOrEqual(20);
    expect(raw.length).toBeLessThanOrEqual(400);
    const per = new Map<number, number>();
    for (const r of raw) per.set(r.mat, (per.get(r.mat) ?? 0) + 1);
    expect(per.get(4)).toBe(9); // HfO₂：3 gate × 3 fin
    expect(per.get(5)).toBe(9); // TiN
    expect(per.get(7)).toBe(3); // SiN：每根 gate 的 cap＋spacer 連成一塊
    expect(per.get(6)).toBe(4); // Poly-Si：3 根 gate ＋ 1 條 stringer
    expect(per.get(3)).toBe(2); // Si fin：3 根，其中兩根被殘留橋接起來
    expect(per.get(9)).toBe(5); // W：1 條長條 ＋ 4 支圓柱
    expect(per.get(10)).toBe(1); // ILD 一整塊
    expect(per.get(8)).toBe(8); // epi：4 段 S/D × （merged 一塊 ＋ 單獨一塊）
    expect(per.get(VOID) ?? 0).toBeGreaterThanOrEqual(4);
    // 沒有太小的碎片（VOID 縫 16 格是最小的）
    expect(raw.filter((r) => r.count < 16).length).toBe(0);
  });
});
