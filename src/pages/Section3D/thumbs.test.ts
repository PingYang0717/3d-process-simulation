// plan v12 §7：縮圖。同一 split 兩次像素相同；差異描邊像素 > 0；原始輪廓線存在；同一設計選同一個軸；對照組選結構中點。
import { describe, expect, it } from 'vitest';
import { type Vec3, MATERIALS, hexToRgb } from '../../volume/volume';
import { handle } from '../../volume/workerCore';
import { base, comp, vol } from '../../volume/ops11.fixture';
import type { Op } from '../../volume/ops';
import { type SplitPatch, type SplitStats, busiestSlice, patchSliceCounts, slabOfArrays, slabOfPatch } from '../../splits/lifecycle';
import { contourOf } from './overlay';
import { DIFF_EDGE_RGB, REMOVED_RGB } from './drawSlice';
import { LOOP_RGB, autoAxis, longestAxisOf, thumbAt, thumbCrop, thumbRGBA, unionBoxes } from './thumbs';

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
});
