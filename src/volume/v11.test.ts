import { describe, expect, it } from 'vitest';
import { type Vec3, type Volume, AIR, initialLabeled, levelMask, localMask, maskOf, voxelFromHit } from './volume';
import { type EditState, applyOp, matNameOf, opText, replay } from './ops';

const matName = matNameOf([]);

/** 一個 9×8×5 的「圓頭 poly」：下半是 7 寬的方柱（y 3～7），上面疊 5 寬（y 2）、3 寬（y 1）、1 寬（y 0）。 */
const roundHead = (): Volume => {
  const X = 9;
  const Y = 8;
  const Z = 5;
  const data = new Uint8Array(X * Y * Z);
  const rows: [number, number, number][] = [
    [0, 4, 4],
    [1, 3, 5],
    [2, 2, 6],
  ];
  for (let z = 1; z <= 3; z++) {
    for (let y = 3; y <= 7; y++) for (let x = 1; x <= 7; x++) data[(z * Y + y) * X + x] = 6;
    for (const [y, x0, x1] of rows) for (let x = x0; x <= x1; x++) data[(z * Y + y) * X + x] = 6;
  }
  return { X, Y, Z, data };
};
const state = (vol: Volume): EditState => ({ vol, L: initialLabeled(vol, matName) });
const at = (v: Volume, x: number, y: number, z: number) => v.data[(z * v.Y + y) * v.X + x];
const topOf = (v: Volume, x: number, z: number) => {
  for (let y = 0; y < v.Y; y++) if (at(v, x, y, z) !== AIR) return y;
  return -1;
};

describe('v11 筆刷', () => {
  it('方形筆刷是 (2r+1)² 列、圓形比它少、整面＝全部', () => {
    const vol = roundHead();
    const mask = new Uint8Array(vol.data.length);
    for (let i = 0; i < mask.length; i++) mask[i] = vol.data[i] ? 1 : 0;
    const up: Vec3 = [0, -1, 0];
    const center: Vec3 = [4, 0, 2];
    // 只看 y = 7 那一層（方柱 7×3 = 21 列），r = 1
    const count = (m: Uint8Array) => {
      let n = 0;
      for (let z = 0; z < vol.Z; z++) for (let x = 0; x < vol.X; x++) if (m[(z * vol.Y + 7) * vol.X + x]) n++;
      return n;
    };
    expect(count(localMask(vol, mask, up, center, 1, 'square'))).toBe(9);
    expect(count(localMask(vol, mask, up, center, 1, 'round'))).toBe(5);
    expect(count(localMask(vol, mask, up, center, Infinity, 'round'))).toBe(21);
    // 範圍外一個都沒有
    const sq = localMask(vol, mask, up, center, 1, 'square');
    for (let i = 0; i < sq.length; i++) if (sq[i]) expect(mask[i]).toBe(1);
  });

  it('補平到頂面：圓頭變方頭，範圍外不變，不吃鄰居', () => {
    const vol = roundHead();
    // 右邊放一個別的材質鄰居在 x = 8（y 0～7）：補平不能蓋過去
    for (let z = 1; z <= 3; z++) for (let y = 0; y < 8; y++) vol.data[(z * vol.Y + y) * vol.X + 8] = 2;
    const s0 = state(vol);
    const key = s0.L.comps.find((c) => c.mat === 6)!.key;
    const mask = maskOf(s0.L, new Set([key]))!;
    // 點頂面（x 4, y 0, z 2），方形筆刷 r = 3 蓋住整個頭
    const out = levelMask(vol, vol, mask, { axis: 'z', lo: 0, hi: vol.Z - 1 }, [0, -1, 0], [4, 0, 2], 3, 'square', 0, 'orig');
    for (let z = 1; z <= 3; z++) for (let x = 1; x <= 7; x++) expect(topOf(out, x, z)).toBe(0);
    // 鄰居與 x = 0 那一列沒變
    for (let i = 0; i < vol.data.length; i++) {
      const x = i % vol.X;
      if (x === 0 || x === 8) expect(out.data[i]).toBe(vol.data[i]);
    }
    // 改到的只有 Air → 6
    let changed = 0;
    for (let i = 0; i < vol.data.length; i++)
      if (out.data[i] !== vol.data[i]) {
        expect(vol.data[i]).toBe(AIR);
        expect(out.data[i]).toBe(6);
        changed++;
      }
    // 每層 z 補 (7-1)+(7-3)+(7-5) = 12 格
    expect(changed).toBe(36);
    // 只補範圍內：r = 0 只動 x = 4 那一列（它本來就在頂，所以什麼都不變）
    const none = levelMask(vol, vol, mask, { axis: 'z', lo: 0, hi: vol.Z - 1 }, [0, -1, 0], [4, 0, 2], 0, 'square', 0, 'orig');
    expect(none.data).toEqual(vol.data);
    // r = 1：x 3～5，每層 2 格（x 3、5 的 y 0）
    const small = levelMask(vol, vol, mask, { axis: 'z', lo: 0, hi: vol.Z - 1 }, [0, -1, 0], [4, 0, 2], 1, 'square', 0, 'orig');
    let n = 0;
    for (let i = 0; i < vol.data.length; i++) if (small.data[i] !== vol.data[i]) n++;
    expect(n).toBe(6);
  });

  it('補平到較低的面：削掉頭、回填原始內容', () => {
    const vol = roundHead();
    const s0 = state(vol);
    const key = s0.L.comps[0].key;
    const mask = maskOf(s0.L, new Set([key]))!;
    // 點 y = 3 那一層當目標：頭（y 0～2）全部削掉
    const out = levelMask(vol, vol, mask, { axis: 'z', lo: 0, hi: vol.Z - 1 }, [0, -1, 0], [4, 3, 2], Infinity, 'round', 3, 'orig');
    for (let z = 1; z <= 3; z++) for (let x = 1; x <= 7; x++) expect(topOf(out, x, z)).toBe(3);
    // 只在 z 範圍內
    const part = levelMask(vol, vol, mask, { axis: 'z', lo: 2, hi: 2 }, [0, -1, 0], [4, 3, 2], Infinity, 'round', 3, 'orig');
    expect(topOf(part, 4, 1)).toBe(0);
    expect(topOf(part, 4, 2)).toBe(3);
  });

  it('level Op 走 applyOp／replay，名稱延續，描述可讀', () => {
    const vol = roundHead();
    const s0 = state(vol);
    const key = s0.L.comps[0].key;
    const op = { kind: 'level' as const, keys: [key], scope: { axis: 'z' as const, lo: 0, hi: 4 }, dir: [0, -1, 0] as Vec3, to: 0, local: { center: [4, 0, 2] as Vec3, radius: 3, shape: 'square' as const }, backfill: 'orig' as const };
    const ctx = { orig: vol, matName, newKey: () => 'k' };
    const s1 = applyOp(s0, op, ctx);
    expect(s1.L.comps.length).toBe(1);
    expect(s1.L.comps[0].key).toBe(key);
    expect(s1.L.comps[0].count).toBe(s0.L.comps[0].count + 36);
    expect(replay(s0, [op], ctx).vol.data).toEqual(s1.vol.data);
    expect(opText(op, s0.L, vol, 0.5, matName)).toContain('方頭到 y = 0');
    // 整面（radius null）也可以
    const whole = applyOp(s0, { ...op, local: { center: [4, 0, 2], radius: null } }, ctx);
    expect(whole.vol.data).toEqual(s1.vol.data);
  });

  it('三角形重心反推體素：和點選同一個算法（即時變色用）', () => {
    const vol = roundHead();
    // 頂面 y = 0 的 x 4 體素，朝上法線 (0,-1,0)，面在 y = 0 平面
    expect(voxelFromHit(vol, [4.5, 0, 2.5], [0, -1, 0])).toBe((2 * vol.Y + 0) * vol.X + 4);
    // 側面 x = 8（方柱右側 x 7 的面）
    expect(voxelFromHit(vol, [8, 5.5, 2.5], [1, 0, 0])).toBe((2 * vol.Y + 5) * vol.X + 7);
  });
});
