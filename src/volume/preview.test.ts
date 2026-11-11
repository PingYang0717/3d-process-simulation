import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled, linerTable } from './volume';
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
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const liners = linerTable(vol);
  const cases: [string, Op][] = [
    ['相鄰材質規則：poly 上面外推 3（SiN 跟著）', { kind: 'push', keys: [poly[0].key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'outer', policy: 'adjacent', liners }],
    ['相鄰材質規則：fin 上面內縮 2（襯層跟著退）', { kind: 'push', keys: [fin.key], scope: full, dir: [0, -1, 0], n: -2, follow: true, backfill: 'outer', policy: 'adjacent', liners }],
    ['相鄰材質規則：fin 往右平移 2（整圈薄層一起）', { kind: 'translate', keys: [fin.key], scope: full, d: [2, 0, 0], backfill: 'outer', follow: true, policy: 'adjacent', liners }],
    ['整面長高 fin（襯層跟推、只改一段 z）', { kind: 'push', keys: [fin.key], scope: { axis: 'z' as const, lo: 20, hi: 60 }, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' }],
    ['整面往前縮 poly', { kind: 'push', keys: [poly[1].key], scope: full, dir: [0, 0, -1], n: -2, follow: true, backfill: 'orig' }],
    ['平移兩根 poly', { kind: 'translate', keys: [poly[1].key, poly[2].key], scope: full, d: [3, 0, -2], backfill: 'orig' }],
    ['換材質（一段 z）', { kind: 'material', keys: [fin.key], scope: { axis: 'z' as const, lo: 60, hi: 64 }, m: 5 }],
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
