// plan v10 §4.4：卡片第一行的一句話（五種 Op）。
import { describe, expect, it } from 'vitest';
import type { Labeled } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { describeOp, faceName } from './opWords';

const L: Labeled = {
  labels: new Int32Array(0),
  comps: [
    { key: 'p2', label: 'Poly-Si 2', mat: 2, count: 12480, bbox: { x0: 10, x1: 30, y0: 40, y1: 60, z0: 5, z1: 50 } },
    { key: 'f1', label: 'Si fin 1', mat: 1, count: 3000, bbox: { x0: 0, x1: 4, y0: 50, y1: 90, z0: 0, z1: 100 } },
  ] as Labeled['comps'],
};
const names: Record<number, string> = { 1: 'Si', 2: 'Poly-Si', 4: 'TiN' };
const w = { L, nm: 0.5, matName: (id: number) => names[id] ?? `材質 ${id}`, scope: '整根' };
const scope = { axis: 'z' as const, lo: 0, hi: 127 };

describe('describeOp', () => {
  it('長／縮：頂面座標、格數、nm、襯層、範圍', () => {
    const op: Op = { kind: 'push', keys: ['p2'], scope, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' };
    expect(describeOp(w, op)).toBe('Poly-Si 2 頂面 y 40 → 37（長高 3 格 = 1.5 nm）· 襯層跟著 · 整根');
    const shrink: Op = { kind: 'push', keys: ['p2'], scope, dir: [1, 0, 0], n: -2, follow: false, backfill: 'orig' };
    expect(describeOp(w, shrink)).toBe('Poly-Si 2 右面 x 30 → 28（縮 2 格 = 1.0 nm）· 襯層不跟 · 整根');
  });
  it('方頭：每一排補到', () => {
    const op: Op = { kind: 'level', keys: ['p2'], scope, dir: [0, -1, 0], to: 37, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true };
    expect(describeOp(w, op)).toBe('Poly-Si 2 方頭：頂面每一排補到 y = 37（18.5 nm）· 只填空氣、襯層跟著 · 整根');
  });
  it('移動：往右 2、往上 1', () => {
    const op: Op = { kind: 'translate', keys: ['p2'], scope, d: [2, -1, 0], backfill: 'orig' };
    expect(describeOp(w, op)).toBe('Poly-Si 2 整塊往右 2、往上 1 格 · 整根');
  });
  it('材質：Si fin 1 → TiN，格數', () => {
    const op: Op = { kind: 'material', keys: ['f1'], scope, m: 4 };
    expect(describeOp(w, op)).toBe('Si fin 1（Si）→ TiN，3,000 格 · 整根');
  });
  it('剖面（含圓頭）：用 Op 自己的 text', () => {
    const op: Op = { kind: 'profile', keys: ['p2'], scope, at: 10, perKey: {}, follow: true, backfill: 'orig', text: '上面兩個角圓角 r = 6、n = 2' };
    expect(describeOp(w, op)).toBe('Poly-Si 2 上面兩個角圓角 r = 6、n = 2 · 整根');
  });
  it('面的名字', () => {
    expect([faceName([0, -1, 0]), faceName([0, 1, 0]), faceName([-1, 0, 0]), faceName([0, 0, 1])]).toEqual(['頂面', '底面', '左面', '後面']);
  });
});
