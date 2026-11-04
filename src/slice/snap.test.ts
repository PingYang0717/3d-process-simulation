import { describe, expect, it } from 'vitest';
import { type Ring, type XY, ringPolygon, signedArea, traceRings } from './trace';
import { editRing } from './raster';
import type { Handle } from './gestures';
import { chamferAt, dragDisp, dragDispFloat, falloffWeights, isAxisCorner, nearSlant, resolveNodeDrag, selfIntersects } from './snap';

/** v9 的 dragDisp 節點那條路（衰減／Shift 單點），逐欄對照用。 */
function oldNodeDisp(r: Ring, h: Handle, delta: XY, shift: boolean): XY[] {
  const d: XY = [Math.round(delta[0]), Math.round(delta[1])];
  if (shift) {
    const out: XY[] = r.pts.map(() => [0, 0]);
    out[h.index] = d;
    return out;
  }
  return falloffWeights(r, h.index).map((k) => [Math.round(d[0] * k), Math.round(d[1] * k)]);
}

const ringOf = (inside: (u: number, v: number) => boolean, n = 40) => traceRings(inside, 0, 0, n, n)[0];
/** 矩形 u∈[2,11]、v∈[3,8]（10×6 格）。 */
const rect = () => ringOf((u, v) => u >= 2 && u <= 11 && v >= 3 && v <= 8);
/** 下半是矩形、上面是半圓頭（像 fin）。 */
const fin = () => ringOf((u, v) => u >= 5 && u <= 24 && v <= 30 && (v >= 15 || Math.hypot(u + 0.5 - 15, v + 0.5 - 15) <= 10));
const nodeAt = (r: Ring, p: XY): Handle => {
  const i = [...r.nodes].find((k) => r.pts[k][0] === p[0] && r.pts[k][1] === p[1]);
  expect(i).toBeDefined();
  return { kind: 'node', key: 'k', ring: 0, index: i! };
};
const axisAligned = (poly: XY[]) => poly.every((p, i) => {
  const q = poly[(i + 1) % poly.length];
  return p[0] === q[0] || p[1] === q[1];
});

describe('節點拖法（plan v10 §4.2、U2）', () => {
  it('矩形角：拖 (2, −1) 後四條邊仍和軸平行，面積差＝(10+2)(6+1) − 10·6', () => {
    const r = rect();
    const h = nodeAt(r, [12, 3]);
    expect(isAxisCorner(r, h.index)).toBe(true);
    expect(resolveNodeDrag(r, h.index, false)).toBe('corner');
    expect(resolveNodeDrag(r, h.index, 'auto')).toBe('corner');
    expect(resolveNodeDrag(r, h.index, true)).toBe('single');
    const disp = dragDisp(r, h, [2.2, -0.7]);
    const after = editRing(r, disp);
    expect(axisAligned(after)).toBe(true);
    expect(Math.abs(signedArea(after)) - Math.abs(signedArea(ringPolygon(r)))).toBe(12 * 7 - 10 * 6);
    // 角移 (2, −1)；上邊另一端只沿 v、右邊另一端只沿 u；對角不動
    expect(disp[h.index]).toEqual([2, -1]);
    expect(disp[nodeAt(r, [2, 3]).index]).toEqual([0, -1]);
    expect(disp[nodeAt(r, [12, 9]).index]).toEqual([2, 0]);
    expect(disp[nodeAt(r, [2, 9]).index]).toEqual([0, 0]);
    // ghost（浮點）同一套規則
    const f = dragDispFloat(r, h, [2.2, -0.7]);
    expect(f[h.index]).toEqual([2.2, -0.7]);
    expect(f[nodeAt(r, [2, 3]).index]).toEqual([0, -0.7]);
    expect(f[nodeAt(r, [12, 9]).index]).toEqual([2.2, 0]);
    expect(selfIntersects(after)).toBe(false);
  });

  it('弧上的點（有一側不是直邊）：預設單點，只動這一點與相鄰兩段', () => {
    const r = fin();
    // 半圓頭上沒有角：像使用者雙擊加一個節點一樣，在弧上挑一個頂點當節點
    const onArc = r.pts.findIndex((p) => p[1] < 10 && p[0] < 15);
    expect(onArc).toBeGreaterThanOrEqual(0);
    r.nodes.add(onArc);
    expect(isAxisCorner(r, onArc)).toBe(false);
    const h: Handle = { kind: 'node', key: 'k', ring: 0, index: onArc! };
    expect(resolveNodeDrag(r, h.index, false)).toBe('single');
    const disp = dragDisp(r, h, [1.4, -2.2]);
    disp.forEach((d, i) => expect(d).toEqual(i === h.index ? [1, -2] : [0, 0]));
    // 只有相鄰兩段（raw[i−1]、raw[i]）的點變了
    const n = r.pts.length;
    const before = editRing(r, r.pts.map(() => [0, 0]));
    const after = editRing(r, disp);
    let k = 0;
    r.raw.forEach((seg, s) => {
      const near = s === h.index || s === (h.index - 1 + n) % n;
      for (let j = 0; j < seg.length - 1; j++, k++) if (!near) expect(after[k]).toEqual(before[k]);
    });
    // 和 Shift（true）一樣
    expect(dragDisp(r, h, [1.4, -2.2], true)).toEqual(disp);
  });

  it("'falloff'（Alt）＝舊 dragDisp 逐欄相同；true＝舊 Shift", () => {
    for (const r of [rect(), fin(), ringOf((u, v) => Math.hypot(u - 20, v - 20) <= 12)])
      for (const i of r.nodes)
        for (const d of [
          [2.4, -1.6],
          [-3, 0],
          [0.4, 5.6],
        ] as XY[]) {
          const h: Handle = { kind: 'node', key: 'k', ring: 0, index: i };
          expect(dragDisp(r, h, d, 'falloff')).toEqual(oldNodeDisp(r, h, d, false));
          expect(dragDisp(r, h, d, true)).toEqual(oldNodeDisp(r, h, d, true));
          expect(dragDisp(r, h, d, 'single')).toEqual(oldNodeDisp(r, h, d, true));
        }
  });

  it('自交檢查：8 字形自交、矩形不自交、點太多不檢查', () => {
    expect(selfIntersects([[0, 0], [2, 2], [2, 0], [0, 2]])).toBe(true);
    expect(selfIntersects([[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(false);
    expect(selfIntersects(Array.from({ length: 300 }, (_, i) => [Math.cos(i), Math.sin(i)] as XY))).toBe(null);
  });
});

describe('斜角與鎖軸（2D 拖拉方頭）', () => {
  /** 頂角各切 2 格的 fin 截面（像範例）：u∈[4,15]、v∈[0,20]。 */
  const chamfer = () => ringOf((u, v) => u >= 4 && u <= 15 && v >= 0 && v <= 20 && Math.min(u - 4, 15 - u) + v >= 2);
  const at = (r: Ring, p: XY) => r.pts.findIndex((q) => q[0] === p[0] && q[1] === p[1]);

  it('chamferAt：斜角兩端都指到同一個外框角；矩形角、弧中間的點不是', () => {
    const r = chamfer();
    const a = at(r, [6, 0]);
    const b = at(r, [4, 2]);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(chamferAt(r, a)?.corner).toEqual([4, 0]);
    expect(chamferAt(r, a)?.to).toBe(b);
    expect(chamferAt(r, b)?.corner).toEqual([4, 0]);
    expect(chamferAt(r, b)?.to).toBe(a);
    // 右邊鏡像
    expect(chamferAt(r, at(r, [14, 0]))?.corner).toEqual([16, 0]);
    expect(chamferAt(r, at(r, [16, 2]))?.corner).toEqual([16, 0]);
    // 底下的矩形角不是斜角
    expect(chamferAt(r, at(r, [4, 21]))).toBeNull();
    // 弧中間（兩側都不是直邊）
    const f = fin();
    const onArc = f.pts.findIndex((p) => p[1] < 8 && p[0] > 8 && p[0] < 22);
    f.nodes.add(onArc);
    expect(chamferAt(f, onArc)).toBeNull();
  });

  it('nearSlant：頂邊、斜角兩端有斜角；底邊、底角沒有', () => {
    const r = chamfer();
    const edge = (i: number): Handle => ({ kind: 'edge', key: 'k', ring: 0, index: i });
    const node = (i: number): Handle => ({ kind: 'node', key: 'k', ring: 0, index: i });
    const topSeg = r.pts.findIndex((p, i) => p[1] === 0 && r.pts[(i + 1) % r.pts.length][1] === 0);
    const botSeg = r.pts.findIndex((p, i) => p[1] === 21 && r.pts[(i + 1) % r.pts.length][1] === 21);
    expect(nearSlant(r, edge(topSeg))).toBe(true);
    expect(nearSlant(r, edge(botSeg))).toBe(false);
    expect(nearSlant(r, node(at(r, [6, 0])))).toBe(true);
    expect(nearSlant(r, node(at(r, [4, 21])))).toBe(false);
    expect(nearSlant(rect(), edge(0))).toBe(false);
  });
});
