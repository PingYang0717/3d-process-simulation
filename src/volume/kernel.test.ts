import { describe, expect, it } from 'vitest';
import { type Vec3, type Volume, MATERIALS, demoVolume, growMask, initialLabeled, levelMask, localMask, maskOf, translateMask } from './volume';
import { addCell, moveCells, newReport, removeCell, shellOf } from './kernel';
import { legacyGrowMask, legacyLevelMask, legacyTranslateMask } from './ref/legacy';
import { matNameOf } from './ops';
import type { Scope } from './scope';

const same = (a: Uint8Array, b: Uint8Array) => {
  let bad = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad++;
  return bad;
};

describe('核心規則改寫後和舊實作逐體素相同（§7.2）', () => {
  const vol = demoVolume();
  const L = initialLabeled(vol, matNameOf(MATERIALS));
  const poly = L.comps.filter((c) => c.mat === 6);
  const fin = L.comps.find((c) => c.mat === 3)!;
  const m = (k: string) => maskOf(L, new Set([k]))!;
  const full: Scope = { axis: 'z', lo: 0, hi: vol.Z - 1 };
  const UP: Vec3 = [0, -1, 0];

  const grows: [string, Uint8Array, Scope, Vec3, number, boolean][] = [
    ['poly 往上長 3（襯層跟推）', m(poly[0].key), full, UP, 3, true],
    ['poly 往上長 2（不跟推，蓋掉 SiN）', m(poly[0].key), full, UP, 2, false],
    ['poly 往上縮 2（襯層跟退）', m(poly[1].key), full, UP, -2, true],
    ['fin 往右長 2、只改 z 20～60', m(fin.key), { axis: 'z', lo: 20, hi: 60 }, [1, 0, 0], 2, true],
    ['fin 往左縮 1、沿 x 的 scope', m(fin.key), { axis: 'x', lo: fin.bbox.x0, hi: fin.bbox.x0 + 5 }, [-1, 0, 0], -1, true],
    ['poly 往前長 2（z）', m(poly[2].key), full, [0, 0, -1], 2, true],
    ['poly 筆刷 r4 往上長 3', localMask(vol, m(poly[0].key), UP, [80, poly[0].bbox.y0, 26], 4, 'round'), full, UP, 3, true],
  ];
  for (const [name, mask, scope, dir, n, follow] of grows)
    it(`growMask：${name}`, () => {
      const a = growMask(vol, vol, mask, scope, dir, n, 'orig', follow);
      const b = legacyGrowMask(vol, vol, mask, scope, dir, n, 'orig', follow);
      expect(same(a.data, b.data)).toBe(0);
    }, 30_000);

  const levels: [string, Uint8Array, Scope, Vec3, number, boolean, number][] = [
    ['fin 補到頂（方頭，跟推）', m(fin.key), full, UP, fin.bbox.y0, true, Infinity],
    ['fin 補到頂（不跟推）', m(fin.key), full, UP, fin.bbox.y0, false, Infinity],
    ['fin 削到頂下 3（跟退）', m(fin.key), full, UP, fin.bbox.y0 + 3, true, Infinity],
    ['fin 筆刷 r6 削到頂下 2、z 30～50', m(fin.key), { axis: 'z', lo: 30, hi: 50 }, UP, fin.bbox.y0 + 2, true, 6],
    ['poly 往右補到 x = 155', m(poly[1].key), full, [1, 0, 0], 155, true, Infinity],
  ];
  for (const [name, mask, scope, dir, to, follow, r] of levels)
    it(`levelMask：${name}`, () => {
      const c: Vec3 = [(fin.bbox.x0 + fin.bbox.x1) >> 1, fin.bbox.y0, 40];
      const a = levelMask(vol, vol, mask, scope, dir, c, r, 'square', to, 'orig', follow);
      const b = legacyLevelMask(vol, vol, mask, scope, dir, c, r, 'square', to, 'orig', follow);
      expect(same(a.data, b.data)).toBe(0);
    }, 30_000);

  for (const [name, mask, scope, d] of [
    ['兩根 poly 往右 3、往前 2', maskOf(L, new Set([poly[1].key, poly[2].key]))!, full, [3, 0, -2]],
    ['fin 往上 1、只搬 z 10～20', m(fin.key), { axis: 'z', lo: 10, hi: 20 }, [0, -1, 0]],
  ] as [string, Uint8Array, Scope, Vec3][])
    it(`translateMask（不帶殼）：${name}`, () => {
      const a = translateMask(vol, vol, mask, scope, d, 'orig');
      const b = legacyTranslateMask(vol, vol, mask, scope, d, 'orig');
      expect(same(a.data, b.data)).toBe(0);
    }, 30_000);
});

/** 一條 x 軸上的小陣列：方便寫規則案例。 */
const line = (cells: number[]): Volume => ({ X: cells.length, Y: 1, Z: 1, data: new Uint8Array(cells) });

describe('核心規則的小案例', () => {
  const R: Vec3 = [1, 0, 0];
  it('加：空氣直接填', () => {
    const v = line([3, 0, 0]);
    const out = new Uint8Array(v.data);
    const r = newReport();
    expect(addCell(v, out, 1, 0, 0, R, 3, true, 'block', r)).toBe(true);
    expect([...out]).toEqual([3, 3, 0]);
    expect(r.filled).toBe(1);
  });
  it('加：薄襯層 follow 時被推開，關著時被擋', () => {
    const v = line([3, 4, 4, 0, 0]);
    const out = new Uint8Array(v.data);
    const r = newReport();
    expect(addCell(v, out, 1, 0, 0, R, 3, true, 'block', r)).toBe(true);
    expect([...out]).toEqual([3, 3, 4, 4, 0]);
    expect(r.pushed).toBe(1);
    const out2 = new Uint8Array(v.data);
    const r2 = newReport();
    expect(addCell(v, out2, 1, 0, 0, R, 3, false, 'block', r2)).toBe(false);
    expect([...out2]).toEqual([...v.data]);
    expect(r2.blockedBy).toEqual({ 4: 1 });
  });
  it('加：厚的材質擋住（block），推面的 overwrite 直接蓋', () => {
    const v = line([3, 6, 6, 6, 6, 6, 0]);
    const out = new Uint8Array(v.data);
    expect(addCell(v, out, 1, 0, 0, R, 3, true, 'block')).toBe(false);
    expect([...out]).toEqual([...v.data]);
    expect(addCell(v, out, 1, 0, 0, R, 3, true, 'overwrite')).toBe(true);
    expect(out[1]).toBe(3);
  });
  it('拿：follow 時外側襯層跟著退、最外面回填原始', () => {
    const orig = line([3, 3, 0, 0, 0]);
    const v = line([3, 3, 4, 4, 0]);
    const out = new Uint8Array(v.data);
    removeCell(v, out, orig, 1, 0, 0, R, 3, 3, 'orig', true);
    expect([...out]).toEqual([3, 4, 4, 0, 0]);
    const out2 = new Uint8Array(v.data);
    removeCell(v, out2, orig, 1, 0, 0, R, 3, 3, 'orig', false);
    // 原始那一格就是被拿走的材質 → 空氣
    expect([...out2]).toEqual([3, 0, 4, 4, 0]);
  });
  it('搬：帶殼時襯層跟著走、空出來回填原始', () => {
    const v = line([0, 3, 3, 4, 0, 0]);
    const orig = line([0, 0, 0, 0, 0, 0]);
    const isS = (i: number) => i === 1 || i === 2;
    const shell = shellOf(v, [1, 2], isS, () => true);
    expect(shell).toEqual([3]);
    const out = new Uint8Array(v.data);
    moveCells(v, orig, out, [1, 2], R, 'orig', shell);
    expect([...out]).toEqual([0, 0, 3, 3, 4, 0]);
  });
});

describe('translateMask 帶殼（新功能）', () => {
  it('fin 往右 2：HfO₂／TiN 殼跟著走，結構體積不變', () => {
    const vol = demoVolume();
    const L = initialLabeled(vol, matNameOf(MATERIALS));
    const fin = L.comps.find((c) => c.mat === 3)!;
    const mask = maskOf(L, new Set([fin.key]))!;
    const full: Scope = { axis: 'z', lo: 0, hi: vol.Z - 1 };
    const out = translateMask(vol, vol, mask, full, [2, 0, 0], 'orig', true);
    // 閘極底下 fin 左側的襯層（x0−1 那一欄）原本是 HfO₂，搬完應該在 x0+1
    const z = 26;
    const y = fin.bbox.y0 + 4;
    const at = (x: number) => out.data[(z * vol.Y + y) * vol.X + x];
    const was = (x: number) => vol.data[(z * vol.Y + y) * vol.X + x];
    expect(was(fin.bbox.x0 - 1)).toBe(4);
    expect(at(fin.bbox.x0 + 1)).toBe(4);
    expect(at(fin.bbox.x0 + 2)).toBe(3);
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < vol.data.length; i++) {
      if (vol.data[i] === 3) n0++;
      if (out.data[i] === 3) n1++;
    }
    expect(n1).toBe(n0);
  }, 30_000);
});
