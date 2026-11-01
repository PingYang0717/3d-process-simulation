// plan v12 §7：縮圖。同一 split 兩次像素相同；差異描邊像素 > 0；原始輪廓線存在；同一設計選同一個軸；對照組選結構中點。
// plan v15 §7 C6：只畫裁切窗的縮圖（thumbRGBA／structThumbRGBA）和舊版「整片畫完再裁」逐像素相同。
import { describe, expect, it } from 'vitest';
import { type BBox, type Vec3, MATERIALS, hexToRgb } from '../../volume/volume';
import { handle } from '../../volume/workerCore';
import { base, comp, expectSame, vol } from '../../volume/ops11.fixture';
import type { Op } from '../../volume/ops';
import type { XY } from '../../slice/trace';
import { type Slab, type SplitPatch, type SplitStats, busiestSlice, patchSliceCounts, slabOfArrays, slabOfPatch } from '../../splits/lifecycle';
import { type UVBox, contourOf } from './overlay';
import { DIFF_EDGE_RGB, REMOVED_RGB, sliceRGBA } from './drawSlice';
import { LOOP_RGB, SEL_EDGE, THUMB_MAX, autoAxis, longestAxisOf, structThumbRGBA, thumbAt, thumbCrop, thumbRGBA, thumbScale, unionBoxes } from './thumbs';

/** 舊版 thumbRGBA（plan v12～v14）：整片 sliceRGBA → 裁 crop → nearest → 疊輪廓。 */
function thumbRef(slab: Slab, crop: UVBox, rgb: Map<number, Vec3>, hidden: Set<number>, loops: XY[][], max = THUMB_MAX) {
  const full = sliceRGBA(slab.vol, slab.axis, 0, rgb, hidden, null, slab.diff);
  const s = thumbScale(crop, max);
  const CW = crop.u1 - crop.u0 + 1;
  const CH = crop.v1 - crop.v0 + 1;
  const W = Math.max(1, Math.round(CW * s));
  const H = Math.max(1, Math.round(CH * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const src = new Uint32Array(full.data.buffer, full.data.byteOffset, full.W * full.H);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < H; y++) {
    const v = crop.v0 + Math.min(CH - 1, Math.floor(y / s));
    const row = v * full.W;
    for (let x = 0; x < W; x++) dst[y * W + x] = src[row + crop.u0 + Math.min(CW - 1, Math.floor(x / s))];
  }
  const ink = (LOOP_RGB[0] | (LOOP_RGB[1] << 8) | (LOOP_RGB[2] << 16) | (255 << 24)) >>> 0;
  const px = (u: number) => Math.min(W - 1, Math.max(0, Math.round((u - crop.u0) * s)));
  const py = (v: number) => Math.min(H - 1, Math.max(0, Math.round((v - crop.v0) * s)));
  for (const loop of loops)
    for (let k = 0; k < loop.length; k++) {
      const p = loop[k];
      const q = loop[(k + 1) % loop.length];
      if ((p[0] < crop.u0 && q[0] < crop.u0) || (p[0] > crop.u1 + 1 && q[0] > crop.u1 + 1) || (p[1] < crop.v0 && q[1] < crop.v0) || (p[1] > crop.v1 + 1 && q[1] > crop.v1 + 1)) continue;
      const x0 = px(p[0]);
      const y0 = py(p[1]);
      const x1 = px(q[0]);
      const y1 = py(q[1]);
      if (y0 === y1) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) dst[y0 * W + x] = ink;
      else if (x0 === x1) for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) dst[y * W + x0] = ink;
      else {
        const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
        for (let i = 0; i <= n; i++) dst[Math.round(y0 + ((y1 - y0) * i) / n) * W + Math.round(x0 + ((x1 - x0) * i) / n)] = ink;
      }
    }
  return { W, H, data: out };
}

/** 舊版 structThumbRGBA 的像素階段（整片 sliceRGBA 再逐像素取）；描邊與面的橘線和新版共用同一段邏輯，這裡只比到混白為止。 */
function structRef(slab: Slab, crop: UVBox, rgb: Map<number, Vec3>, hidden: Set<number>, on: Set<number>, max: number) {
  const full = sliceRGBA(slab.vol, slab.axis, 0, rgb, hidden, null, null);
  const s = thumbScale(crop, max);
  const CW = crop.u1 - crop.u0 + 1;
  const CH = crop.v1 - crop.v0 + 1;
  const W = Math.max(1, Math.round(CW * s));
  const H = Math.max(1, Math.round(CH * s));
  const out = new Uint8ClampedArray(W * H * 4);
  const lab = slab.L.labels;
  const { X: SX, Y: SY } = slab.vol;
  const vi = slab.axis === 'x' ? (u: number, v: number) => u * SY + v : (u: number, v: number) => v * SX + u;
  const selPx = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = crop.v0 + Math.min(CH - 1, Math.floor(y / s));
    for (let x = 0; x < W; x++) {
      const u = crop.u0 + Math.min(CW - 1, Math.floor(x / s));
      const p4 = (v * full.W + u) * 4;
      const o = (y * W + x) * 4;
      const sel = on.has(lab[vi(u, v)]);
      if (sel) selPx[y * W + x] = 1;
      for (let c = 0; c < 3; c++) {
        const p = full.data[p4 + c];
        out[o + c] = sel ? p : Math.round(p * 0.35 + 255 * 0.65);
      }
      out[o + 3] = 255;
    }
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      if (!selPx[k]) continue;
      const edge = (x > 0 && !selPx[k - 1]) || (x < W - 1 && !selPx[k + 1]) || (y > 0 && !selPx[k - W]) || (y < H - 1 && !selPx[k + W]);
      if (!edge) continue;
      const o = k * 4;
      out[o] = SEL_EDGE[0];
      out[o + 1] = SEL_EDGE[1];
      out[o + 2] = SEL_EDGE[2];
    }
  return { W, H, data: out };
}

const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
const rgb = new Map<number, Vec3>(MATERIALS.map((m) => [m.id, hexToRgb(m.color)]));
const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
const count = (d: Uint8ClampedArray, c: Vec3) => {
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] === c[0] && d[i + 1] === c[1] && d[i + 2] === c[2]) n++;
  return n;
};

describe('縮圖（plan v12 §5.5）', () => {
  handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
  const p2 = comp('Poly-Si 2');
  const gen = (ops: Op[]) => handle('replayPatch', { src: 'base', from: 1, comps: base.L.comps, ops, matNames, keyCounter: 1000 })[0] as { patch: SplitPatch; stats: SplitStats };
  const design = [1, 2, 3].map((n) => gen([{ kind: 'translate', keys: [p2.key], scope: full, d: [0, 0, n], backfill: 'orig' }]));
  const origLabels = (handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } })[0] as { labels: Int32Array }).labels;

  it('同一設計共用一個軸；片＝各自 diff 外框中點；對照組＝結構中點', () => {
    const axis = autoAxis(unionBoxes(design.map((d) => d.stats.diffBox)))!;
    expect(axis).toBeTruthy();
    // 每個 split 自己的外框選的軸可能不同，但設計共用的只有一個
    for (const d of design) expect(thumbAt(axis, d.stats.diffBox, null, vol)).toBeGreaterThanOrEqual(0);
    const b = p2.bbox;
    expect(thumbAt('z', null, b, vol)).toBe((b.z0 + b.z1) >> 1);
    expect(['x', 'y', 'z']).toContain(longestAxisOf(b));
  });

  it('兩次像素相同；有深藍邊；有原始輪廓黑線', () => {
    const d = design[1];
    const axis = autoAxis(unionBoxes(design.map((x) => x.stats.diffBox)))!;
    // 片：改最多的那一片（中點可能剛好是沒改到的內部）
    const at = busiestSlice(patchSliceCounts(vol, d.patch, vol.data, axis)) ?? thumbAt(axis, d.stats.diffBox, null, vol);
    const slab = slabOfPatch(vol, vol.data, origLabels, d.patch, axis, at);
    const o = slabOfArrays(vol, vol.data, origLabels, base.L.comps, vol.data, axis, at);
    const loops = contourOf(o.L, o.vol, [p2.key], axis, 0);
    const crop = thumbCrop(axis, [d.stats.diffBox, p2.bbox], vol);
    const a = thumbRGBA(slab, crop, rgb, new Set(), loops);
    const b = thumbRGBA(slab, crop, rgb, new Set(), loops);
    expect(Math.max(a.W, a.H)).toBeLessThanOrEqual(240);
    expect(a.data).toEqual(b.data);
    // 差異描邊：改過的深藍邊或拿掉的紅（這一片是被搬走的那一側＝紅）
    expect(count(a.data, DIFF_EDGE_RGB) + count(a.data, REMOVED_RGB)).toBeGreaterThan(0);
    expect(count(a.data, LOOP_RGB)).toBeGreaterThan(0);
  });

  it('只畫裁切窗 === 舊版整片畫完再裁（三個軸、幾種裁切窗、有隱藏材質、parked 與 live 的片）', () => {
    const d = design[2];
    const b: BBox = p2.bbox;
    for (const axis of ['x', 'y', 'z'] as const) {
      const at = busiestSlice(patchSliceCounts(vol, d.patch, vol.data, axis)) ?? thumbAt(axis, d.stats.diffBox, b, vol);
      const parked = slabOfPatch(vol, vol.data, origLabels, d.patch, axis, at);
      const o = slabOfArrays(vol, vol.data, origLabels, base.L.comps, vol.data, axis, at);
      const loops = contourOf(o.L, o.vol, [p2.key], axis, 0);
      const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
      const crops: UVBox[] = [
        thumbCrop(axis, [d.stats.diffBox, b], vol),
        thumbCrop(axis, [b], vol, 0),
        { u0: 0, v0: 0, u1: W - 1, v1: H - 1 },
        { u0: 0, v0: 0, u1: 5, v1: 3 },
        { u0: W - 7, v0: H - 4, u1: W - 1, v1: H - 1 },
      ];
      for (const slab of [parked, o])
        for (const crop of crops)
          for (const hidden of [new Set<number>(), new Set([p2.mat, 1])]) {
            const now = thumbRGBA(slab, crop, rgb, hidden, loops);
            const ref = thumbRef(slab, crop, rgb, hidden, loops);
            expect([now.W, now.H]).toEqual([ref.W, ref.H]);
            expectSame(now.data, ref.data);
            // 連續兩張不同裁切窗共用暫存也不互相污染
            expectSame(thumbRGBA(slab, crop, rgb, hidden, loops).data, ref.data);
          }
    }
  });
});

describe('結構縮圖（設計區 ①）', () => {
  const origLabels = (handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } })[0] as { labels: Int32Array }).labels;
  const p2 = comp('Poly-Si 2');
  const on = new Set(base.L.comps.flatMap((c, i) => (c.key === p2.key ? [i] : [])));
  it('三個軸都把結構本身畫成原色＋選取藍描邊（plan v14 §5.5；像素 ↔ 格子用明寫的 (x, y, z) 對照；YZ 那一片的格子 index 是 z*Y + y）', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const at = thumbAt(axis, null, p2.bbox, vol);
      const slab = slabOfArrays(vol, vol.data, origLabels, base.L.comps, vol.data, axis, at);
      const crop = thumbCrop(axis, [p2.bbox], vol, 6);
      const img = structThumbRGBA(slab, crop, rgb, new Set(), on, p2.bbox, null, 120);
      expect(Math.max(img.W, img.H)).toBeLessThanOrEqual(120);
      // 預期：每個縮圖像素回推到切面 (u, v)，再用假 Volume 的 (x, y, z) 算 index
      const s = Math.min(8, 120 / Math.max(crop.u1 - crop.u0 + 1, crop.v1 - crop.v0 + 1));
      const { X, Y } = slab.vol;
      const idx = (x: number, y: number, z: number) => (z * Y + y) * X + x;
      const b2 = rgb.get(p2.mat)!;
      let want = 0;
      let edge = 0;
      let mismatch = 0;
      for (let py = 0; py < img.H; py++)
        for (let px = 0; px < img.W; px++) {
          const u = crop.u0 + Math.min(crop.u1 - crop.u0, Math.floor(px / s));
          const v = crop.v0 + Math.min(crop.v1 - crop.v0, Math.floor(py / s));
          const i = axis === 'z' ? idx(u, v, 0) : axis === 'y' ? idx(u, 0, v) : idx(0, v, u);
          const sel = on.has(slab.L.labels[i]);
          const o = (py * img.W + px) * 4;
          const is = (c: Vec3) => img.data[o] === c[0] && img.data[o + 1] === c[1] && img.data[o + 2] === c[2];
          if (sel) want++;
          if (sel && is(SEL_EDGE)) edge++;
          if (sel !== (is(b2) || is(SEL_EDGE))) mismatch++;
        }
      expect(want).toBeGreaterThan(0);
      expect(edge).toBeGreaterThan(0);
      expect(edge).toBeLessThan(want);
      expect(mismatch).toBe(0);
    }
  });
  it('只畫裁切窗 === 舊版整片畫完再裁（三個軸、幾種裁切窗、有隱藏材質、不同倍率）', () => {
    for (const axis of ['x', 'y', 'z'] as const) {
      const at = thumbAt(axis, null, p2.bbox, vol);
      const slab = slabOfArrays(vol, vol.data, origLabels, base.L.comps, vol.data, axis, at);
      const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
      const crops: UVBox[] = [thumbCrop(axis, [p2.bbox], vol, 6), thumbCrop(axis, [p2.bbox], vol, 0), { u0: 0, v0: 0, u1: W - 1, v1: H - 1 }, { u0: 2, v0: 1, u1: 9, v1: 4 }];
      for (const crop of crops)
        for (const hidden of [new Set<number>(), new Set([1, 3])])
          for (const max of [120, 48]) {
            const now = structThumbRGBA(slab, crop, rgb, hidden, on, null, null, max);
            const ref = structRef(slab, crop, rgb, hidden, on, max);
            expect([now.W, now.H]).toEqual([ref.W, ref.H]);
            expectSame(now.data, ref.data);
          }
    }
  });
});
