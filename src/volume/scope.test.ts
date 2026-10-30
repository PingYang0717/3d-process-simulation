import { describe, expect, it } from 'vitest';
import { MATERIALS, coordOf, demoVolume, initialLabeled } from './volume';
import { type EditState, type LegacyOp, type Op, applyOp, matNameOf, opText, replay, upgradeOp } from './ops';
import { previewOp } from './preview';
import { clampScope, clipBox, fullScope, inScope, isFullScope, scopeBox } from './scope';

const matName = matNameOf(MATERIALS);

function setup() {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  let seq = 1000;
  const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  return { vol, base, ctx, poly, fin, reset: () => (seq = 1000) };
}

describe('Scope 取代 zRange', () => {
  it('scopeBox／clipBox／clampScope／inScope', () => {
    const v = { X: 10, Y: 8, Z: 6 };
    expect(scopeBox(v, { axis: 'y', lo: 2, hi: 3 })).toEqual({ x0: 0, x1: 9, y0: 2, y1: 3, z0: 0, z1: 5 });
    expect(scopeBox(v, { axis: 'x', lo: 12, hi: 20 })).toBeNull();
    expect(clipBox({ x0: 1, x1: 4, y0: 0, y1: 7, z0: 0, z1: 5 }, { axis: 'x', lo: 3, hi: 9 })).toEqual({ x0: 3, x1: 4, y0: 0, y1: 7, z0: 0, z1: 5 });
    expect(clipBox({ x0: 1, x1: 4, y0: 0, y1: 7, z0: 0, z1: 5 }, { axis: 'z', lo: 6, hi: 9 })).toBeNull();
    expect(clampScope({ axis: 'z', lo: 9, hi: -3 }, v)).toEqual({ axis: 'z', lo: 0, hi: 5 });
    expect(isFullScope(fullScope(v, 'x'), v)).toBe(true);
    expect(inScope({ axis: 'y', lo: 2, hi: 3 }, [0, 3, 0])).toBe(true);
    expect(inScope({ axis: 'y', lo: 2, hi: 3 }, [0, 4, 0])).toBe(false);
  });

  it('舊的 zRange Op 轉成 scope 後重播逐體素相同（v10／v11／preview 的各種 Op）', () => {
    const { vol, base, ctx, poly, fin, reset } = setup();
    const Z = vol.Z - 1;
    const legacy: LegacyOp[] = [
      { kind: 'push', keys: [poly[0].key], zRange: [0, Z], dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig', local: { center: [80, poly[0].bbox.y0, 26], radius: 3 } },
      { kind: 'push', keys: [fin.key], zRange: [20, 60], dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' },
      { kind: 'push', keys: [poly[1].key], zRange: [0, Z], dir: [0, 0, -1], n: -2, follow: true, backfill: 'orig' },
      { kind: 'level', keys: [fin.key], zRange: [0, Z], dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: true },
      { kind: 'level', keys: [fin.key], zRange: [30, 50], dir: [0, -1, 0], to: fin.bbox.y0 + 3, local: { center: [40, 30, 40], radius: 6, shape: 'square' }, backfill: 'orig' },
      { kind: 'translate', keys: [poly[1].key, poly[2].key], zRange: [0, Z], d: [3, 0, -2], backfill: 'orig' },
      { kind: 'material', keys: [fin.key], zRange: [60, 64], m: 5 },
    ];
    const upgraded: Op[] = legacy.map(upgradeOp);
    upgraded.forEach((op, i) => {
      expect(op.scope).toEqual({ axis: 'z', lo: legacy[i].zRange[0], hi: legacy[i].zRange[1] });
      expect('zRange' in op).toBe(false);
    });
    reset();
    const a = replay(base, legacy, ctx);
    reset();
    const b = replay(base, upgraded, ctx);
    expect(b.vol.data).toEqual(a.vol.data);
    expect(b.L.labels).toEqual(a.L.labels);
    expect(b.L.comps).toEqual(a.L.comps);
    legacy.forEach((op, i) => expect(opText(upgraded[i], base.L, vol, 0.5, matName)).toBe(opText(op, base.L, vol, 0.5, matName)));
    expect(opText(upgraded[1], base.L, vol, 0.5, matName)).toContain('（z 20～60）');
    expect(opText(upgraded[0], base.L, vol, 0.5, matName)).not.toContain('（z');
  }, 60_000);

  it('沿 x 的 scope：fin 只在 x 範圍內長高，範圍內和整段長高逐體素相同，範圍外一格都不變', () => {
    const { vol, base, ctx, fin } = setup();
    const mid = (fin.bbox.x0 + fin.bbox.x1) >> 1;
    const scope = { axis: 'x' as const, lo: fin.bbox.x0, hi: mid };
    const part = applyOp(base, { kind: 'push', keys: [fin.key], scope, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' }, ctx);
    const whole = applyOp(base, { kind: 'push', keys: [fin.key], scope: fullScope(vol, 'x'), dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' }, ctx);
    let changed = 0;
    let bad = 0;
    for (let i = 0; i < vol.data.length; i++) {
      const c = coordOf(vol, i);
      if (part.vol.data[i] !== (inScope(scope, c) ? whole.vol.data[i] : vol.data[i])) bad++;
      if (part.vol.data[i] !== vol.data[i]) changed++;
    }
    expect(bad).toBe(0);
    expect(changed).toBeGreaterThan(0);
  }, 30_000);

  it('沿 y 的 scope：換材質只改那幾層', () => {
    const { vol, base, ctx, poly } = setup();
    const p = poly[0];
    const scope = { axis: 'y' as const, lo: p.bbox.y0, hi: p.bbox.y0 + 2 };
    const out = applyOp(base, { kind: 'material', keys: [p.key], scope, m: 5 }, ctx);
    let bad = 0;
    let changed = 0;
    for (let i = 0; i < vol.data.length; i++) {
      if (out.vol.data[i] === vol.data[i]) continue;
      changed++;
      if (!inScope(scope, coordOf(vol, i)) || out.vol.data[i] !== 5) bad++;
    }
    expect(bad).toBe(0);
    expect(changed).toBeGreaterThan(0);
  });

  it('沿 x 的 scope：即時預覽範圍內和正式結果逐體素相同', () => {
    const { vol, base, ctx, poly, fin } = setup();
    const ops: Op[] = [
      { kind: 'push', keys: [fin.key], scope: { axis: 'x', lo: fin.bbox.x0 + 1, hi: fin.bbox.x1 - 1 }, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' },
      { kind: 'translate', keys: [poly[0].key], scope: { axis: 'x', lo: 0, hi: 60 }, d: [0, 0, 2], backfill: 'orig' },
      { kind: 'level', keys: [fin.key], scope: { axis: 'y', lo: 0, hi: fin.bbox.y0 + 4 }, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: true },
    ];
    for (const op of ops) {
      const p = previewOp(base, vol, op)!;
      const full = applyOp(base, op, ctx);
      const { box } = p;
      const W = box.x1 - box.x0 + 1;
      const H = box.y1 - box.y0 + 1;
      let bad = 0;
      let changed = 0;
      for (let z = box.z0; z <= box.z1; z++)
        for (let y = box.y0; y <= box.y1; y++)
          for (let x = box.x0; x <= box.x1; x++) {
            const g = (z * vol.Y + y) * vol.X + x;
            if (p.data[((z - box.z0) * H + (y - box.y0)) * W + (x - box.x0)] !== full.vol.data[g]) bad++;
            if (full.vol.data[g] !== vol.data[g]) changed++;
          }
      expect(bad).toBe(0);
      expect(changed).toBeGreaterThan(0);
    }
  }, 30_000);
});
