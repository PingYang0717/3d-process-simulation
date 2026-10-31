// plan v9 §7：LUT 版 drawSlice 和舊版逐位元組相同（三個軸、有無選取、有無 diff、有無預覽盒、有隱藏材質）。
import { describe, expect, it } from 'vitest';
import { type Axis, type Vec3, type Volume, MATERIALS, demoVolume, hexToRgb, idx, initialLabeled, maskOf } from '../../volume/volume';
import { matNameOf } from '../../volume/ops';
import type { Preview } from '../../volume/preview';
import { SEL_RGB, sliceRGBA } from './drawSlice';

/** 舊版（plan v9 之前 views.tsx 的 drawSlice），把 putImageData＋fillRect 換成寫進陣列。 */
function reference(vol: Volume, axis: Axis, at: number, rgb: Map<number, Vec3>, hidden: Set<number>, selMask: Uint8Array | null, diff: Uint8Array | null, patch?: Preview | null) {
  const patched = (x: number, y: number, z: number) => {
    if (patch) {
      const b = patch.box;
      if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1)
        return patch.data[((z - b.z0) * (b.y1 - b.y0 + 1) + (y - b.y0)) * (b.x1 - b.x0 + 1) + (x - b.x0)];
    }
    return vol.data[idx(vol, x, y, z)];
  };
  const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
  const toVoxel = (u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const [x, y, z] = toVoxel(u, v);
      const i = idx(vol, x, y, z);
      const m = patched(x, y, z);
      const c = hidden.has(m) ? [245, 245, 245] : (rgb.get(m) ?? [255, 0, 255]);
      const o = (v * W + u) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
      if (selMask?.[i]) {
        data[o] = (data[o] + SEL_RGB[0]) >> 1;
        data[o + 1] = (data[o + 1] + SEL_RGB[1]) >> 1;
        data[o + 2] = (data[o + 2] + SEL_RGB[2]) >> 1;
      }
    }
  if (diff) {
    const on = (u: number, v: number) => {
      const [x, y, z] = toVoxel(u, v);
      return diff[idx(vol, x, y, z)];
    };
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        if (!on(u, v)) continue;
        const edge = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([du, dv]) => {
          const nu = u + du;
          const nv = v + dv;
          return nu < 0 || nv < 0 || nu >= W || nv >= H || !on(nu, nv);
        });
        if (edge) {
          const o = (v * W + u) * 4;
          data.set([255, 77, 79, 255], o);
        }
      }
  }
  return data;
}

describe('drawSlice LUT 版（plan v9 P11）', () => {
  const vol = demoVolume();
  const L = initialLabeled(vol, matNameOf(MATERIALS));
  // 少一個材質的顏色（畫洋紅）
  const rgb = new Map(MATERIALS.filter((m) => m.id !== 5).map((m) => [m.id, hexToRgb(m.color)] as const));
  const sel = maskOf(L, new Set(L.comps.filter((c) => c.mat === 6).map((c) => c.key)))!;
  // diff：一塊不規則的區域（含碰到陣列邊界）
  const diff = new Uint8Array(vol.data.length);
  for (let i = 0; i < diff.length; i += 1) if ((i * 2654435761) % 97 < 3 || (i % vol.X < 4 && (i / vol.X) % 7 < 3)) diff[i] = 1;
  const box = { x0: 30, x1: 70, y0: 10, y1: 60, z0: 40, z1: 90 };
  const pd = new Uint8Array((box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1));
  for (let i = 0; i < pd.length; i++) pd[i] = (i * 7) % 9;
  const patch: Preview = { box, data: pd };
  const cases: [string, Set<number>, Uint8Array | null, Uint8Array | null, Preview | null][] = [
    ['只有材質', new Set(), null, null, null],
    ['隱藏材質＋選取', new Set([3, 0]), sel, null, null],
    ['差異', new Set(), null, diff, null],
    ['全部＋預覽盒', new Set([4]), sel, diff, patch],
  ];
  for (const axis of ['x', 'y', 'z'] as Axis[])
    for (const at of axis === 'x' ? [0, 50, vol.X - 1] : axis === 'y' ? [0, 30, vol.Y - 1] : [0, 64, vol.Z - 1])
      it(`${axis} = ${at}：四種組合逐位元組相同`, () => {
        for (const [, hidden, s, d, p] of cases) {
          const a = sliceRGBA(vol, axis, at, rgb, hidden, s, d, p).data;
          const b = reference(vol, axis, at, rgb, hidden, s, d, p);
          expect(a.length).toBe(b.length);
          let bad = 0;
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad++;
          expect(bad).toBe(0);
        }
      });
});
