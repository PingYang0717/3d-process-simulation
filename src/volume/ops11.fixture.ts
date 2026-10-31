// plan v11 新操作測試共用：範例模型、狀態、比較工具。
import { type Volume, MATERIALS, demoVolume, initialLabeled, maskOf } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { boxVoxels, cropVolume, previewBox, previewOp } from './preview';
import { applyOpLocal } from './apply';
import { newReport } from './kernel';
import { expect } from 'vitest';

export const matName = matNameOf(MATERIALS);
export const vol = demoVolume();
export const base: EditState = { vol, L: initialLabeled(vol, matName) };
let seq = 1000;
export const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
export const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
export const comp = (label: string) => base.L.comps.find((c) => c.label === label)!;
export const ofMat = (m: number) => base.L.comps.filter((c) => c.mat === m);
export const count = (v: Volume, m: number) => {
  let n = 0;
  for (let i = 0; i < v.data.length; i++) if (v.data[i] === m) n++;
  return n;
};
export const at = (v: Volume, x: number, y: number, z: number) => v.data[(z * v.Y + y) * v.X + x];
export const maskKeys = (keys: string[], s: EditState = base) => maskOf(s.L, new Set(keys))!;
export const changed = (a: Volume, b: Volume) => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

/** 兩個陣列第一個不同的位置（相同回 −1）；比 toEqual 快很多（200 萬格）。 */
export const firstDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
};
export const expectSame = (a: ArrayLike<number>, b: ArrayLike<number>) => expect(firstDiff(a, b)).toBe(-1);

/** 預覽（裁切）和正式結果逐體素相同、範圍外沒改到、Worker 路徑（applyOpLocal）也相同；回傳正式結果與 report。 */
export function checkAll(op: Op, s: EditState = base) {
  const real = applyOp(s, op, ctx);
  const box = previewBox(s, op)!;
  expect(box).toBeTruthy();
  const r = newReport();
  const p = previewOp(s, vol, op, Infinity, r)!;
  expect(p.data.length).toBe(boxVoxels(box));
  expectSame(p.data, cropVolume(real.vol, box).data);
  let outside: number[] | null = null;
  for (let i = 0; i < vol.data.length; i++) {
    if (real.vol.data[i] === s.vol.data[i]) continue;
    const x = i % vol.X;
    const y = ((i - x) / vol.X) % vol.Y;
    const z = (i - x - y * vol.X) / (vol.X * vol.Y);
    const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
    if (!inside && !outside) outside = [x, y, z];
  }
  expect(outside).toBeNull();
  const local = applyOpLocal(s, op, ctx);
  expectSame(local.state.vol.data, real.vol.data);
  return { real, report: r };
}
