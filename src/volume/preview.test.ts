import { describe, expect, it } from 'vitest';
import { type Vec3, type Volume, AIR, MATERIALS, demoVolume, initialLabeled, levelMask } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { boxVoxels, cropVolume, previewBox, previewOp } from './preview';

const matName = matNameOf(MATERIALS);

describe('即時預覽（裁切後在主執行緒算）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  let seq = 1000;
  const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  const full: [number, number] = [0, vol.Z - 1];
  const cases: [string, Op][] = [
    ['筆刷推拉（圓 r3、襯層跟推）', { kind: 'push', keys: [poly[0].key], zRange: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig', local: { center: [80, poly[0].bbox.y0, 26], radius: 3 } }],
    ['筆刷縮短（方 r4）', { kind: 'push', keys: [poly[2].key], zRange: full, dir: [1, 0, 0], n: -3, follow: true, backfill: 'orig', local: { center: [151, 30, 100], radius: 4, shape: 'square' } }],
    ['整面長高 fin（襯層跟推、只改一段 z）', { kind: 'push', keys: [fin.key], zRange: [20, 60], dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' }],
    ['整面往前縮 poly', { kind: 'push', keys: [poly[1].key], zRange: full, dir: [0, 0, -1], n: -2, follow: true, backfill: 'orig' }],
    ['方頭：整根 fin 補到頂（襯層跟推）', { kind: 'level', keys: [fin.key], zRange: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: true }],
    ['筆刷補平（方 r6）', { kind: 'level', keys: [fin.key], zRange: full, dir: [0, -1, 0], to: fin.bbox.y0 + 3, local: { center: [40, 30, 10], radius: 6, shape: 'square' }, backfill: 'orig' }],
    ['平移兩根 poly', { kind: 'translate', keys: [poly[1].key, poly[2].key], zRange: full, d: [3, 0, -2], backfill: 'orig' }],
    ['換材質（一段 z）', { kind: 'material', keys: [fin.key], zRange: [60, 64], m: 5 }],
  ];
  for (const [name, op] of cases)
    it(`${name}：範圍內和正式結果逐體素相同，範圍外這一步沒改到`, () => {
      const box = previewBox(base, op)!;
      expect(box).toBeTruthy();
      const p = previewOp(base, vol, op)!;
      expect(p.data.length).toBe(boxVoxels(box));
      const real = applyOp(base, op, ctx).vol;
      expect(p.data).toEqual(cropVolume(real, box).data);
      // 範圍外一個都沒變（否則預覽會漏掉改動）
      let changedInside = 0;
      for (let i = 0; i < vol.data.length; i++) {
        if (real.data[i] === vol.data[i]) continue;
        const x = i % vol.X;
        const y = ((i - x) / vol.X) % vol.Y;
        const z = (i - x - y * vol.X) / (vol.X * vol.Y);
        const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
        if (!inside) expect([x, y, z]).toEqual('inside box');
        changedInside++;
      }
      expect(changedInside).toBeGreaterThan(0);
      // 裁切範圍遠小於整個陣列
      expect(boxVoxels(box)).toBeLessThan(vol.data.length / 4);
    });

  it('超過上限就不預覽', () => {
    expect(previewOp(base, vol, cases[0][1], 10)).toBeNull();
  });
});

describe('補平跟推襯層', () => {
  /** 一根 3 寬的柱子（mat 3）：中間列到 y 2、兩側列到 y 4（圓頭）；上面貼 2 層襯層（4）、再上面是厚的 6。 */
  const stack = (): Volume => {
    const X = 5;
    const Y = 12;
    const Z = 1;
    const data = new Uint8Array(X * Y * Z);
    const set = (x: number, y: number, m: number) => (data[y * X + x] = m);
    for (let y = 2; y < Y; y++) set(2, y, 3);
    for (const x of [1, 3]) for (let y = 4; y < Y; y++) set(x, y, 3);
    // 襯層緊貼每一列的頂，厚度 2；再上面全部是 6（厚）
    for (const [x, top] of [
      [1, 4],
      [2, 2],
      [3, 4],
    ] as [number, number][]) {
      set(x, top - 1, 4);
      set(x, top - 2, 4);
      for (let y = 0; y < top - 2; y++) set(x, y, 6);
    }
    return { X, Y, Z, data };
  };
  const col = (v: Volume, x: number) => Array.from({ length: v.Y }, (_, y) => v.data[y * v.X + x]);
  const mask = (v: Volume) => v.data.map((m) => (m === 3 ? 1 : 0));
  const up: Vec3 = [0, -1, 0];

  it('不跟推：碰到襯層就停（和以前一樣）', () => {
    const v = stack();
    const out = levelMask(v, v, mask(v), [0, 0], up, [2, 2, 0], Infinity, 'square', 2, 'orig');
    expect(out.data).toEqual(v.data);
  });

  it('跟推：襯層整列往上推、柱子補成方頭，厚的 6 被吃掉兩格', () => {
    const v = stack();
    const out = levelMask(v, v, mask(v), [0, 0], up, [2, 2, 0], Infinity, 'square', 2, 'orig', true);
    expect(col(out, 2)).toEqual(col(v, 2));
    // 兩側列：柱子補到 y 2，襯層仍然 2 厚、貼在上面（y 0～1），原本 y 0～1 的 6 被推出去
    for (const x of [1, 3]) expect(col(out, x)).toEqual([4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it('跟推削平：襯層跟著退回來、最外面回填 Air', () => {
    const v = stack();
    // 把中間列削到 y 4（和兩側一樣高）
    const out = levelMask(v, v, mask(v), [0, 0], up, [2, 4, 0], 0, 'square', 4, 'orig', true);
    expect(col(out, 2)).toEqual([AIR, AIR, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(col(out, 1)).toEqual(col(v, 1));
  });
});
