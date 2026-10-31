import { describe, expect, it } from 'vitest';
import { type Volume, MATERIALS, initialLabeled } from '../volume/volume';
import { type EditState, applyOp, matNameOf, replay } from '../volume/ops';
import { applyOpInPlace } from '../volume/apply';
import { decodeRle } from '../volume/profile';
import type { Scope } from '../volume/scope';
import { type RoundGesture, roundCells, roundOp, roundOutline, roundStats } from './round';

const matName = matNameOf(MATERIALS);
const key = (u: number, v: number) => `${u},${v}`;
const set = (cells: { u: number; v: number }[]) => new Set(cells.map((c) => key(c.u, c.v)));
const sorted = (s: Set<string>) => [...s].sort();

/** 16×12 的矩形（u 0..15、v 0..11），可以挖掉一些格子。 */
const rect = (hole: (u: number, v: number) => boolean = () => false) => (u: number, v: number) => u >= 0 && v >= 0 && u < 16 && v < 12 && !hole(u, v);
const g = (o: Partial<RoundGesture>): RoundGesture => ({ kind: 'round', corners: [{ id: 'ul' }, { id: 'ur' }], r: 4, n: 2, mode: 'match', ...o });
const run = (inside: (u: number, v: number) => boolean, gg: RoundGesture) => roundCells(inside, -6, -6, 22, 18, gg)!;

describe('圓頭 roundCells（plan v10 §4.6）', () => {
  it('16×12 矩形上兩角 r = 4、n = 2：每角削 3 格，沒有填', () => {
    const c = run(rect(), g({}));
    expect(c.add).toEqual([]);
    expect(sorted(set(c.remove))).toEqual(sorted(new Set(['0,0', '1,0', '0,1', '15,0', '14,0', '15,1'])));
    // 方向碼往外：(0,0) 往上或往左
    for (const x of c.remove) expect(x.dir === 1 || x.dir === 3 || x.dir === 0).toBe(true);
  });

  it('n = 1：斜切三角（i + j ≤ 2）', () => {
    const c = run(rect(), g({ n: 1, corners: [{ id: 'ul' }] }));
    const want = new Set<string>();
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i + j <= 2) want.add(key(i, j));
    expect(sorted(set(c.remove))).toEqual(sorted(want));
  });

  it('n = 8：只削角上 1～2 格（r = 8 → ru 8、rv 夾到半高 6）', () => {
    const c = run(rect(), g({ n: 8, r: 8 }));
    expect(c.add).toEqual([]);
    const ul = c.remove.filter((x) => x.u < 8);
    const ur = c.remove.filter((x) => x.u >= 8);
    expect(ul.length).toBeGreaterThanOrEqual(1);
    expect(ul.length).toBeLessThanOrEqual(2);
    expect(ur.length).toBe(ul.length);
    expect(set(ul).has('0,0')).toBe(true);
  });

  it('下面兩個角、左右鏡射', () => {
    const c = run(rect(), g({ corners: [{ id: 'll' }, { id: 'lr' }] }));
    expect(sorted(set(c.remove))).toEqual(sorted(new Set(['0,11', '1,11', '0,10', '15,11', '14,11', '15,10'])));
  });

  it('凹角（內圓角）：貼著側壁往外填，只填原本是空氣的格子', () => {
    const inside = rect();
    const c = run(inside, g({ r: 4, corners: [{ id: 'll', concave: true }, { id: 'lr', concave: true }] }));
    expect(c.remove).toEqual([]);
    expect(c.add.every((x) => !inside(x.u, x.v))).toBe(true);
    expect(sorted(set(c.add))).toEqual(sorted(new Set(['-1,11', '-1,10', '-2,11', '16,11', '16,10', '17,11'])));
    // 由近到遠：靠牆的先
    const order = c.add.map((x) => key(x.u, x.v));
    expect(order.indexOf('-1,11')).toBeLessThan(order.indexOf('-2,11'));
    // 只削的模式不填凹角
    expect(run(inside, g({ mode: 'cut', corners: [{ id: 'll', concave: true }] })).add).toEqual([]);
  });

  it('cut／fill／match：只含 remove／只含 add／兩者', () => {
    // 左上方角、右上已經斜切得太多（i + j ≤ 3）：對齊要削左上、填右上
    const inside = rect((u, v) => 15 - u + v <= 3);
    const m = run(inside, g({}));
    expect(m.remove.length).toBeGreaterThan(0);
    expect(m.add.length).toBeGreaterThan(0);
    expect(m.add.every((x) => x.u > 8 && !inside(x.u, x.v))).toBe(true);
    const cut = run(inside, g({ mode: 'cut' }));
    expect(cut.add).toEqual([]);
    expect(set(cut.remove)).toEqual(set(m.remove));
    const fill = run(inside, g({ mode: 'fill' }));
    expect(fill.remove).toEqual([]);
    expect(set(fill.add)).toEqual(set(m.add));
  });

  it('L 形：只改角區，缺的那個角不會被補滿', () => {
    const inside = rect((u, v) => u >= 8 && v < 6);
    const c = run(inside, g({ r: 3 }));
    expect(c.add).toEqual([]);
    expect(c.remove.every((x) => x.u < 3 && x.v < 3)).toBe(true);
    expect(c.remove.length).toBeGreaterThan(0);
  });

  it('沒有結構回傳 null；外框輪廓多邊形每格至少 2 點', () => {
    expect(roundCells(() => false, 0, 0, 5, 5, g({}))).toBeNull();
    const box = { u0: 0, v0: 0, u1: 15, v1: 11 };
    const p = roundOutline(box, g({ r: 4 }));
    // 兩個圓角各 ≥ 2·(4+4) 段＋兩個方角
    expect(p.length).toBeGreaterThanOrEqual(2 * 17 + 2);
    expect(p[0]).toEqual([0, 4]);
    expect(p).toContainEqual([16, 12]);
    for (const [u, v] of p) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(16 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
    }
    // 凹角往外凸出 ru
    const q = roundOutline(box, g({ r: 3, corners: [{ id: 'll', concave: true }] }));
    expect(Math.min(...q.map((x) => x[0]))).toBeCloseTo(-3);
  });
});

/** X×Y×Z：底下基板（Si）、上面一塊 Poly（mat 6）＋外面一層 HfO₂ 襯層（mat 4）；shift(z) = 這一片 Poly 沿 u 的偏移。 */
function makeState(shift: (z: number) => number = () => 0, liner = true): EditState {
  const X = 34;
  const Y = 24;
  const Z = 6;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const s = shift(z);
        const i = (z * Y + y) * X + x;
        const inPoly = x >= 6 + s && x < 22 + s && y >= 6 && y < 18;
        const inLiner = x >= 5 + s && x < 23 + s && y >= 5 && y < 18;
        if (y >= 18) data[i] = 1;
        else if (inPoly) data[i] = 6;
        else if (liner && inLiner) data[i] = 4;
      }
  const vol: Volume = { X, Y, Z, data };
  return { vol, L: initialLabeled(vol, matName) };
}
const clone = (s: EditState): EditState => ({
  vol: { ...s.vol, data: s.vol.data.slice() },
  L: { labels: s.L.labels.slice(), comps: s.L.comps.map((c) => ({ ...c, bbox: { ...c.bbox } })) },
});

describe('圓頭 Op：套用與重播', () => {
  const scopeOf = (s: EditState): Scope => ({ axis: 'z', lo: 0, hi: s.vol.Z - 1 });

  it('roundOp：參考片的絕對格子、文字、統計', () => {
    const s = makeState();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const op = roundOp(s.L, s.vol, [poly.key], scopeOf(s), 2, g({ r: 6 }), true, 'orig', 0.5)!;
    expect(op.kind).toBe('profile');
    expect(op.text).toBe('上面兩個角圓角 r = 6（3.0 nm）、n = 2');
    expect(op.rounds?.[poly.key]?.kind).toBe('round');
    expect(op.refExact).toBe(true);
    const st = roundStats(s.L, s.vol, [poly.key], 'z', 2, g({ r: 6 }));
    expect(decodeRle(op.perKey[poly.key].remove).length).toBe(st.cut);
    expect(st.fill).toBe(0);
    expect(st.limit).toBe(6);
    expect(st.clamped).toBe(false);
    expect(roundStats(s.L, s.vol, [poly.key], 'z', 2, g({ r: 7 })).clamped).toBe(true);
    // 沒有東西會變 → null
    expect(roundOp(s.L, s.vol, [poly.key], scopeOf(s), 2, g({ r: 4, mode: 'fill' }), true, 'orig')).toBeNull();
  });

  const cases: [string, RoundGesture, (z: number) => number][] = [
    ['外圓角 match', g({ r: 4 }), () => 0],
    ['外圓角 n = 1、不對稱', g({ r: 4, ru: 5, rv: 3, n: 1 }), () => 0],
    ['內圓角', g({ r: 3, corners: [{ id: 'll', concave: true }, { id: 'lr', concave: true }] }), () => 0],
    ['沿 z 偏移的 fin', g({ r: 4, corners: [{ id: 'ul' }, { id: 'ur' }, { id: 'll', concave: true }] }), (z) => z],
  ];
  for (const [name, gg, shift] of cases)
    it(`重播逐體素相同：${name}`, () => {
      const s = makeState(shift);
      const poly = s.L.comps.find((c) => c.mat === 6)!;
      let seq = 1000;
      const ctx = { orig: s.vol, matName, newKey: () => `c${seq++}` };
      const op = roundOp(s.L, s.vol, [poly.key], scopeOf(s), 2, gg, true, 'orig', 0.5)!;
      expect(op).not.toBeNull();
      const a = applyOp(s, op, ctx);
      const r = replay(s, [op], ctx);
      const c = clone(s);
      const res = applyOpInPlace(c, op, { ...ctx, orig: s.vol });
      expect(res.report.fallback).toEqual([]);
      let diff = 0;
      for (let i = 0; i < a.vol.data.length; i++) if (a.vol.data[i] !== c.vol.data[i] || a.vol.data[i] !== r.vol.data[i]) diff++;
      expect(diff).toBe(0);
      // 真的有改
      let changed = 0;
      for (let i = 0; i < a.vol.data.length; i++) if (a.vol.data[i] !== s.vol.data[i]) changed++;
      expect(changed).toBeGreaterThan(0);
    });

  it('沿 z 偏移的 fin：每一片用自己的外框，削掉的格子跟著偏（沒有 fallback）', () => {
    const s = makeState((z) => z, false);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    let seq = 1000;
    const ctx = { orig: s.vol, matName, newKey: () => `c${seq++}` };
    const op = roundOp(s.L, s.vol, [poly.key], scopeOf(s), 0, g({ r: 4 }), false, 'orig')!;
    const c = clone(s);
    const res = applyOpInPlace(c, op, ctx);
    expect(res.report.fallback).toEqual([]);
    const { X, Y, Z } = s.vol;
    const removedAt = (z: number) => {
      const out: string[] = [];
      for (let y = 0; y < Y; y++)
        for (let x = 0; x < X; x++) {
          const i = (z * Y + y) * X + x;
          if (s.vol.data[i] === 6 && c.vol.data[i] !== 6) out.push(key(x - z, y));
        }
      return out.sort();
    };
    const want = sorted(new Set(['6,6', '7,6', '6,7', '21,6', '20,6', '21,7']));
    for (let z = 0; z < Z; z++) expect(removedAt(z)).toEqual(want);
  });

  it('內圓角只填空氣：襯層以外的材質不被蓋掉（kernel 決定）', () => {
    const s = makeState(() => 0, false);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    let seq = 1000;
    const ctx = { orig: s.vol, matName, newKey: () => `c${seq++}` };
    const op = roundOp(s.L, s.vol, [poly.key], scopeOf(s), 2, g({ r: 4, corners: [{ id: 'll', concave: true }] }), false, 'orig')!;
    const a = applyOp(s, op, ctx);
    let added = 0;
    for (let i = 0; i < a.vol.data.length; i++)
      if (a.vol.data[i] !== s.vol.data[i]) {
        expect(s.vol.data[i]).toBe(0);
        expect(a.vol.data[i]).toBe(6);
        added++;
      }
    expect(added).toBe(3 * s.vol.Z);
  });
});
