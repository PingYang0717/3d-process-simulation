import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from '../volume/volume';
import { matNameOf } from '../volume/ops';
import { applyOpLocal } from '../volume/apply';
import { sliceRings } from '../pages/Section3D/SliceEditor';
import { type Shape, counterparts, mirroredOp } from './mirror';
import { type GestureCtx, type Handle, gestureToOp } from './gestures';

const matName = matNameOf(MATERIALS);

describe('對應到長得一樣的結構（§7.7）', () => {
  const vol = demoVolume();
  const L = initialLabeled(vol, matName);
  const fins = L.comps.filter((c) => c.mat === 3).sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const poly = L.comps.find((c) => c.mat === 6)!;
  const z = 64;
  const shapeOf = (key: string): Shape => {
    const k = L.comps.findIndex((c) => c.key === key);
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    let area = 0;
    for (let v = 0; v < vol.Y; v++)
      for (let u = 0; u < vol.X; u++)
        if (L.labels[(z * vol.Y + v) * vol.X + u] === k) {
          area++;
          u0 = Math.min(u0, u);
          v0 = Math.min(v0, v);
          u1 = Math.max(u1, u);
          v1 = Math.max(v1, v);
        }
    return { box: { u0, v0, u1, v1 }, mat: L.comps[k].mat, area };
  };
  const keys = [...fins.map((f) => f.key), poly.key];
  const rings = sliceRings(L, vol, 'z', z, keys);
  const shapes = new Map(keys.filter((k) => rings.has(k)).map((k) => [k, shapeOf(k)]));
  /** fin 1 右上角的節點。 */
  const r0 = rings.get(fins[0].key)![0];
  let corner = 0;
  r0.pts.forEach((p, i) => {
    if (r0.nodes.has(i) && p[1] <= r0.pts[corner][1] && p[0] >= r0.pts[corner][0]) corner = i;
  });
  const h: Handle = { kind: 'node', key: fins[0].key, ring: 0, index: corner };

  it('三根 fin 互相配對；poly（材質不同）不配', () => {
    const cps = counterparts(rings, h, shapes);
    expect(cps.get(fins[1].key)).toBeTruthy();
    expect(cps.get(fins[2].key)).toBeTruthy();
    if (rings.has(poly.key)) expect(cps.get(poly.key)).toBeNull();
    // 對應到的也是右上角
    const c = cps.get(fins[1].key)!;
    const p = rings.get(fins[1].key)![0].pts[c.index];
    const s = shapes.get(fins[1].key)!;
    const s0 = shapes.get(fins[0].key)!;
    expect([p[0] - s.box.u0, p[1] - s.box.v0]).toEqual([r0.pts[corner][0] - s0.box.u0, r0.pts[corner][1] - s0.box.v0]);
  });

  it('拖 fin 1 右上角：三根一起改，合成一個 profile；配不到的結構不動', () => {
    const k = (key: string) => L.comps.findIndex((c) => c.key === key);
    const g: GestureCtx = {
      axis: 'z',
      at: z,
      scope: { axis: 'z', lo: 0, hi: vol.Z - 1 },
      follow: true,
      backfill: 'orig',
      selKeys: keys,
      inside: (key, u, v) => u >= 0 && v >= 0 && u < vol.X && v < vol.Y && L.labels[(z * vol.Y + v) * vol.X + u] === k(key),
      sliceBox: (key) => shapes.get(key)?.box ?? null,
      nm: 0.5,
    };
    const { op, missed } = mirroredOp(rings, h, [2, -2], false, g, shapes);
    expect(op?.kind).toBe('profile');
    if (op?.kind !== 'profile') return;
    expect(Object.keys(op.perKey).sort()).toEqual(fins.map((f) => f.key).sort());
    expect(missed).toEqual(rings.has(poly.key) ? [poly.key] : []);
    let seq = 1000;
    const r = applyOpLocal({ vol, L }, op, { orig: vol, matName, newKey: () => `c${seq++}` });
    const grown = fins.map((f) => r.state.L.comps.find((c) => c.key === f.key)!.count - f.count);
    expect(grown.every((n) => n > 0)).toBe(true);
    // 三根長得一樣：增加的格數相同
    expect(new Set(grown).size).toBe(1);
    // poly 沒有被當成手勢對象（它被推過去的襯層擠到幾格是核心規則的連帶效果）
    expect(op.keys).not.toContain(poly.key);
    // plan v15 B3：主 key 的 perKey／gestures 直接用 main 的（不再第二次 profileDelta）→ 和單獨 gestureToOp 逐欄相同
    const solo = gestureToOp(rings, h, [2, -2], false, g);
    expect(solo?.kind).toBe('profile');
    if (solo?.kind !== 'profile') return;
    expect(op.perKey[fins[0].key]).toEqual(solo.perKey[fins[0].key]);
    expect(JSON.stringify(op.perKey[fins[0].key])).toBe(JSON.stringify(solo.perKey[fins[0].key]));
    expect(op.gestures?.[fins[0].key]).toEqual(solo.gestures?.[fins[0].key]);
  }, 30_000);

  it('邊：拖 fin 1 右邊那條直邊（整段與單段）：合成的 profile 裡主 key 的 perKey／gestures === 單獨 gestureToOp', () => {
    const k = (key: string) => L.comps.findIndex((c) => c.key === key);
    const g: GestureCtx = {
      axis: 'z',
      at: z,
      scope: { axis: 'z', lo: 0, hi: vol.Z - 1 },
      follow: true,
      backfill: 'orig',
      selKeys: keys,
      inside: (key, u, v) => u >= 0 && v >= 0 && u < vol.X && v < vol.Y && L.labels[(z * vol.Y + v) * vol.X + u] === k(key),
      sliceBox: (key) => shapes.get(key)?.box ?? null,
      nm: 0.5,
    };
    const s0 = shapes.get(fins[0].key)!;
    const seg = r0.pts.findIndex((p, i) => {
      const q = r0.pts[(i + 1) % r0.pts.length];
      return p[0] === q[0] && p[0] === s0.box.u1 + 1;
    });
    expect(seg).toBeGreaterThanOrEqual(0);
    const eh: Handle = { kind: 'edge', key: fins[0].key, ring: 0, index: seg };
    // fin 的頭是圓的：右邊這條直邊沒有橫跨整個外框，所以是 profile 不是 push（整段、單段都走混合路徑）
    for (const shift of [false, true]) {
      const mixed = mirroredOp(rings, eh, [2, 0], shift, g, shapes);
      const solo = gestureToOp(rings, eh, [2, 0], shift, g);
      expect(mixed.op?.kind).toBe('profile');
      expect(solo?.kind).toBe('profile');
      if (mixed.op?.kind !== 'profile' || solo?.kind !== 'profile') return;
      expect(mixed.op.keys.length).toBeGreaterThan(1);
      expect(mixed.op.perKey[fins[0].key]).toEqual(solo.perKey[fins[0].key]);
      expect(mixed.op.gestures?.[fins[0].key]).toEqual(solo.gestures?.[fins[0].key]);
    }
  }, 30_000);
});
