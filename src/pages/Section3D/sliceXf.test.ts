// 放大切面的視圖變換（plan v18 §5）：適合視窗、以滑鼠為中心縮放、對準選取、螢幕 ↔ 體素。
import { describe, expect, it } from 'vitest';
import { ZOOM_MAX, ZOOM_MIN, aimXf, boxInPlane, fitXf, uvAtXf, zoomXf } from './sliceXf';

describe('sliceXf', () => {
  it('fit：整張在視窗裡、置中、等比', () => {
    for (const [w, h, W, H] of [
      [800, 600, 160, 96],
      [300, 700, 128, 96],
      [640, 480, 96, 128],
    ]) {
      const p = fitXf(w, h, W, H);
      expect(p.tx).toBeGreaterThanOrEqual(0);
      expect(p.ty).toBeGreaterThanOrEqual(0);
      expect(p.tx + W * p.zoom).toBeLessThanOrEqual(w + 1e-9);
      expect(p.ty + H * p.zoom).toBeLessThanOrEqual(h + 1e-9);
      // 左右、上下的留白相同
      expect(p.tx).toBeCloseTo(w - (p.tx + W * p.zoom), 9);
      expect(p.ty).toBeCloseTo(h - (p.ty + H * p.zoom), 9);
      // 至少有一邊貼到 94%
      expect(Math.max((W * p.zoom) / w, (H * p.zoom) / h)).toBeCloseTo(0.94, 9);
    }
  });

  it('fit：很大或很小的圖夾在縮放範圍內', () => {
    expect(fitXf(100, 100, 4000, 4000).zoom).toBe(ZOOM_MIN);
    expect(fitXf(2000, 2000, 4, 4).zoom).toBe(ZOOM_MAX);
  });

  it('zoomAt：滑鼠下的體素不變', () => {
    const p0 = fitXf(800, 600, 160, 96);
    for (const [cx, cy] of [
      [0, 0],
      [400, 300],
      [733, 81],
    ]) {
      const before = uvAtXf(p0, cx, cy);
      let p = p0;
      for (const k of [1.3, 2.7, 0.4, 5]) {
        p = zoomXf(p, p.zoom * k, cx, cy);
        const after = uvAtXf(p, cx, cy);
        expect(after[0]).toBeCloseTo(before[0], 6);
        expect(after[1]).toBeCloseTo(before[1], 6);
      }
    }
  });

  it('zoomAt：夾在 0.25～32', () => {
    const p = fitXf(800, 600, 160, 96);
    expect(zoomXf(p, 1000, 10, 10).zoom).toBe(ZOOM_MAX);
    expect(zoomXf(p, 0.001, 10, 10).zoom).toBe(ZOOM_MIN);
    // 夾住之後那一點仍然不動
    const q = zoomXf(p, 1000, 123, 45);
    expect(uvAtXf(q, 123, 45)[0]).toBeCloseTo(uvAtXf(p, 123, 45)[0], 6);
  });

  it('aim：選取外框的中心在視窗中央，整塊看得到', () => {
    const box = { u0: 40, v0: 10, u1: 59, v1: 49 };
    const p = aimXf(800, 600, box);
    const [cu, cv] = uvAtXf(p, 400, 300);
    expect(cu).toBeCloseTo(50, 9);
    expect(cv).toBeCloseTo(30, 9);
    expect(p.tx + box.u0 * p.zoom).toBeGreaterThan(0);
    expect(p.ty + box.v0 * p.zoom).toBeGreaterThan(0);
    expect(p.tx + (box.u1 + 1) * p.zoom).toBeLessThan(800);
    expect(p.ty + (box.v1 + 1) * p.zoom).toBeLessThan(600);
  });

  it('螢幕 ↔ 體素：每個體素的中心點回得到自己', () => {
    const p = zoomXf(fitXf(640, 480, 96, 128), 7.5, 200, 100);
    for (const [u, v] of [
      [0, 0],
      [95, 127],
      [31, 64],
    ]) {
      const x = p.tx + (u + 0.5) * p.zoom;
      const y = p.ty + (v + 0.5) * p.zoom;
      expect(uvAtXf(p, x, y).map(Math.floor)).toEqual([u, v]);
    }
  });

  it('boxInPlane：XY 正面 u=x v=y；XZ 上視 u=x v=z；YZ 側面 u=z v=y', () => {
    const b = { x0: 1, x1: 2, y0: 3, y1: 4, z0: 5, z1: 6 };
    expect(boxInPlane('z', b)).toEqual({ u0: 1, v0: 3, u1: 2, v1: 4 });
    expect(boxInPlane('y', b)).toEqual({ u0: 1, v0: 5, u1: 2, v1: 6 });
    expect(boxInPlane('x', b)).toEqual({ u0: 5, v0: 3, u1: 6, v1: 4 });
  });
});
