// plan v9 §7：LUT 版 drawSlice 和舊版逐位元組相同（三個軸、有無選取、有無 diff、有無預覽盒、有隱藏材質）。
// plan v15 §7 C6：sliceRGBA(crop) === 整片裁下來的像素；重用 out 的第二次呼叫結果相同。
import { describe, expect, it } from 'vitest';
import { type Axis, type Vec3, type Volume, MATERIALS, demoVolume, hexToRgb, idx, initialLabeled, maskOf } from '../../volume/volume';
import { matNameOf } from '../../volume/ops';
import type { Preview } from '../../volume/preview';
import { DIFF_EDGE_HEX, DIFF_EDGE_RGB, REMOVED_RGB, SEL_RGB, sliceRGBA } from './drawSlice';
import { PALETTE } from '../../volume/volume';

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
        const [x, y, z] = toVoxel(u, v);
        const o = (v * W + u) * 4;
        // plan v10：被拿掉的（現在是空）整格紅、其他改過的描深藍邊
        if (!vol.data[idx(vol, x, y, z)]) data.set([...REMOVED_RGB, 255], o);
        else if (edge) data.set([...DIFF_EDGE_RGB, 255], o);
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
  const same = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    expect(a.length).toBe(b.length);
    let bad = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) bad++;
    expect(bad).toBe(0);
  };
  for (const axis of ['x', 'y', 'z'] as Axis[])
    for (const at of axis === 'x' ? [0, 50, vol.X - 1] : axis === 'y' ? [0, 30, vol.Y - 1] : [0, 64, vol.Z - 1])
      it(`${axis} = ${at}：四種組合逐位元組相同`, () => {
        for (const [, hidden, s, d, p] of cases) {
          const a = sliceRGBA(vol, axis, at, rgb, hidden, s, d, p).data;
          const b = reference(vol, axis, at, rgb, hidden, s, d, p);
          same(a, b);
        }
      });

  /** 整片像素裁下 crop 那一塊。 */
  const cut = (full: Uint8ClampedArray, W: number, c: { u0: number; v0: number; u1: number; v1: number }) => {
    const CW = c.u1 - c.u0 + 1;
    const out = new Uint8ClampedArray(CW * (c.v1 - c.v0 + 1) * 4);
    for (let v = c.v0, o = 0; v <= c.v1; v++, o += CW * 4) out.set(full.subarray((v * W + c.u0) * 4, (v * W + c.u1 + 1) * 4), o);
    return out;
  };
  for (const axis of ['x', 'y', 'z'] as Axis[])
    it(`${axis}：crop 版 === 整片裁下來（含碰到邊、1×1、整片、預覽盒在裁切窗外／跨邊）`, () => {
      const at = axis === 'x' ? 50 : axis === 'y' ? 30 : 64;
      const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
      const crops = [
        { u0: 0, v0: 0, u1: W - 1, v1: H - 1 },
        { u0: 0, v0: 0, u1: 10, v1: 7 },
        { u0: W - 9, v0: H - 5, u1: W - 1, v1: H - 1 },
        { u0: 13, v0: 21, u1: 13, v1: 21 },
        { u0: 25, v0: 5, u1: 75, v1: 65 },
        { u0: 3, v0: 2, u1: 20, v1: 9 },
        { u0: 60, v0: 50, u1: W - 1, v1: 58 },
      ];
      for (const [, hidden, s, d, p] of cases) {
        const full = sliceRGBA(vol, axis, at, rgb, hidden, s, d, p);
        for (const c of crops) {
          const img = sliceRGBA(vol, axis, at, rgb, hidden, s, d, p, null, c);
          expect([img.W, img.H]).toEqual([c.u1 - c.u0 + 1, c.v1 - c.v0 + 1]);
          same(img.data, cut(full.data, W, c));
        }
      }
    });
  it('重用 out：第二次呼叫寫回同一片、結果相同（整片與 crop 都是）；大小不對就另配', () => {
    const [, hidden, s, d, p] = cases[3];
    const a = sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p);
    const first = a.data.slice();
    const again = sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p, a.data);
    expect(again.data).toBe(a.data);
    same(again.data, first);
    // 先畫別的片弄髒緩衝，再畫回來
    sliceRGBA(vol, 'z', 10, rgb, new Set(), null, null, null, a.data);
    same(sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p, a.data).data, first);
    const c = { u0: 25, v0: 5, u1: 75, v1: 65 };
    const k = sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p, null, c);
    const kFirst = k.data.slice();
    sliceRGBA(vol, 'z', 10, rgb, new Set(), null, null, null, k.data, c);
    const k2 = sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p, k.data, c);
    expect(k2.data).toBe(k.data);
    same(k2.data, kFirst);
    // 大小不對：不重用
    const wrong = new Uint8ClampedArray(8);
    expect(sliceRGBA(vol, 'z', 64, rgb, hidden, s, d, p, wrong).data).not.toBe(wrong);
  });
});

describe('改過的地方不染色（plan v10 §4.3）', () => {
  /** WCAG 對比度。 */
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  it('差異邊框和 16 色調色盤每一色對比度 ≥ 3:1', () => {
    for (const c of PALETTE) expect(contrast(DIFF_EDGE_HEX, c)).toBeGreaterThanOrEqual(3);
  });
  it('改後模式（不傳 diff）：16 色各一塊、改一格，像素就是材質色；差異模式：邊框深藍、拿掉的紅', () => {
    const X = 16;
    const Y = 6;
    const data = new Uint8Array(X * Y);
    for (let u = 0; u < X; u++) for (let v = 1; v < Y; v++) data[v * X + u] = u + 1;
    const vol: Volume = { X, Y, Z: 1, data };
    const rgb = new Map(PALETTE.map((c, k) => [k + 1, hexToRgb(c)] as const));
    // 改一格：材質 1 的一格變成材質 2；另一格拿掉
    const diff = new Uint8Array(X * Y);
    data[3 * X] = 2;
    diff[3 * X] = 1;
    data[3 * X + 5] = 0;
    diff[3 * X + 5] = 1;
    const now = sliceRGBA(vol, 'z', 0, rgb, new Set(), null, null).data;
    for (let i = 0; i < X * Y; i++) {
      const c = data[i] ? rgb.get(data[i])! : [255, 0, 255];
      expect([now[i * 4], now[i * 4 + 1], now[i * 4 + 2]]).toEqual(c);
    }
    const d = sliceRGBA(vol, 'z', 0, rgb, new Set(), null, diff).data;
    expect([d[3 * X * 4], d[3 * X * 4 + 1], d[3 * X * 4 + 2]]).toEqual(DIFF_EDGE_RGB);
    expect([d[(3 * X + 5) * 4], d[(3 * X + 5) * 4 + 1], d[(3 * X + 5) * 4 + 2]]).toEqual(REMOVED_RGB);
  });
});
