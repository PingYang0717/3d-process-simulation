import { describe, expect, it } from 'vitest';
import { type Volume, initialLabeled } from '../volume/volume';
import { type EditState, type Op, matNameOf } from '../volume/ops';
import { applyOpLocal } from '../volume/apply';
import { traceRings } from './trace';
import { type GestureCtx, type Handle, gestureToOp } from './gestures';
import { type RelGesture, recordGesture, relativeCells } from './relative';

const matName = matNameOf([
  { id: 0, name: 'Air', color: '#fff' },
  { id: 1, name: 'Sub', color: '#ccc' },
  { id: 3, name: 'Fin', color: '#f00' },
]);

/** 一根斜角的 fin：z < 10 在 x 10～17，z ≥ 10 往右偏 1 格；右上角斜切。 */
function offsetFin(): Volume {
  const X = 40;
  const Y = 30;
  const Z = 20;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++) {
    const x0 = z < 10 ? 10 : 11;
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (y >= 25) data[i] = 1;
        else if (y >= 10 && x >= x0 && x <= x0 + 7 && !(x - x0 - 3 > y - 10)) data[i] = 3;
      }
  }
  return { X, Y, Z, data };
}

describe('相對式套用（§7.8，M4）', () => {
  const vol = offsetFin();
  const s: EditState = { vol, L: initialLabeled(vol, matName) };
  const fin = s.L.comps.find((c) => c.mat === 3)!;
  const k = s.L.comps.indexOf(fin);
  const z = 5;
  const inside = (u: number, v: number) => u >= 0 && v >= 0 && u < vol.X && v < vol.Y && s.L.labels[(z * vol.Y + v) * vol.X + u] === k;
  const rings = new Map([[fin.key, traceRings(inside, 0, 0, vol.X - 1, vol.Y - 1)]]);
  const r = rings.get(fin.key)![0];
  // 斜邊：兩端 u、v 都不同的那一段
  const seg = r.pts.findIndex((p, i) => {
    const q = r.pts[(i + 1) % r.pts.length];
    return p[0] !== q[0] && p[1] !== q[1];
  });
  const g: GestureCtx = {
    axis: 'z',
    at: z,
    scope: { axis: 'z', lo: 0, hi: vol.Z - 1 },
    follow: true,
    backfill: 'orig',
    selKeys: [fin.key],
    inside: (_k, u, v) => inside(u, v),
    sliceBox: () => ({ u0: 10, v0: 10, u1: 17, v1: 24 }),
    nm: 0.5,
  };
  const h: Handle = { kind: 'edge', key: fin.key, ring: 0, index: seg };
  // 斜邊的外法線大約 (+0.7, −0.7)：往外推 3 格
  const op = gestureToOp(rings, h, [2.2, -2.2], false, g)!;
  const perSlice = (out: Volume) => {
    const n = new Array(vol.Z).fill(0);
    for (let i = 0; i < vol.data.length; i++) if (out.data[i] === 3 && vol.data[i] !== 3) n[Math.floor(i / (vol.X * vol.Y))]++;
    return n;
  };

  it('推斜邊往外 3 掃過整根：每一片都多一樣的格數、沒有被擋、沒有退回絕對座標', () => {
    expect(seg).toBeGreaterThanOrEqual(0);
    expect(op.kind).toBe('profile');
    if (op.kind !== 'profile') return;
    expect(op.gestures?.[fin.key]?.amount).toBe(3);
    let seq = 1000;
    const res = applyOpLocal(s, op, { orig: vol, matName, newKey: () => `c${seq++}` });
    const n = perSlice(res.state.vol);
    expect(n[0]).toBeGreaterThan(0);
    expect(new Set(n).size).toBe(1);
    expect(res.report.blocked).toBe(0);
    expect(res.report.fallback.length).toBe(0);
  });

  it('對照：只用絕對座標（沒有手勢記錄）時，偏移的那一段多出來的格數不一樣', () => {
    if (op.kind !== 'profile') return;
    const abs: Op = { ...op, gestures: undefined };
    let seq = 1000;
    const res = applyOpLocal(s, abs, { orig: vol, matName, newKey: () => `c${seq++}` });
    const n = perSlice(res.state.vol);
    expect(n[0]).not.toBe(n[15]);
  });

  it('對不到把手的片退回絕對座標，報告記下來', () => {
    if (op.kind !== 'profile') return;
    // 參考位置故意放到很遠：每一片都對不到
    const bad: Op = { ...op, gestures: { [fin.key]: { ...op.gestures![fin.key], ref: [[5, 5], [6, 6]] } } };
    let seq = 1000;
    const res = applyOpLocal(s, bad, { orig: vol, matName, newKey: () => `c${seq++}` });
    expect(res.report.fallback.length).toBe(vol.Z);
  });

  // v10（§4.2）：節點的拖法記在 RelGesture.drag，每一片重做同一種；舊 Op 沒有這個欄位＝shift ? single : falloff
  const corner = [...r.nodes].find((i) => r.pts[i][0] === 10 && r.pts[i][1] === 25);
  const nh: Handle = { kind: 'node', key: fin.key, ring: 0, index: corner ?? -1 };

  it('節點拖法：預設在矩形角上記 corner，整根每一片都重做矩形角（左邊整條往左 1 格）', () => {
    expect(corner).toBeDefined();
    const nop = gestureToOp(rings, nh, [-1.2, 0.3], false, g)!;
    expect(nop.kind).toBe('profile');
    if (nop.kind !== 'profile') return;
    expect(nop.gestures?.[fin.key]?.drag).toBe('corner');
    let seq = 1000;
    const res = applyOpLocal(s, nop, { orig: vol, matName, newKey: () => `c${seq++}` });
    const n = perSlice(res.state.vol);
    expect(n.every((x) => x === 15)).toBe(true);
    expect(res.report.fallback.length).toBe(0);
  });

  it('舊 Op（沒有 drag 欄位）重做：shift=false ≡ falloff、shift=true ≡ single，逐格相同', () => {
    const rec = recordGesture(rings.get(fin.key)!, nh, [-2, -1], 0, 'falloff')!;
    expect(rec.drag).toBe('falloff');
    expect(rec.shift).toBe(false);
    const old: RelGesture = { ...rec };
    delete old.drag;
    const cells = (gg: RelGesture) => relativeCells(inside, 0, 0, vol.X - 1, vol.Y - 1, gg);
    expect(cells(old)).toEqual(cells(rec));
    expect(cells({ ...old, shift: true })).toEqual(cells({ ...rec, shift: true, drag: 'single' }));
    expect(cells(old)).not.toEqual(cells({ ...rec, drag: 'corner' }));
  });
});
