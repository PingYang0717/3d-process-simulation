// plan v17 §7：相鄰材質規則（kernel17）。用 prototype 的同一個 48×38×40 模型（demo17，y 上下顛倒）。
// plan v21：不分薄層／厚層，沒固定的外層全部跟著平移；固定的結構可被壓薄（最少留 N 格）或完全鎖定。
// 每一步都走兩條路逐體素比對：applyOp（整個陣列）、applyOpLocal（裁切範圍，Worker 的路徑）。
import { describe, expect, it } from 'vitest';
import { type Labeled, type LockSpec, type Vec3, type Volume, LOCK_FULL, MATERIALS, initialLabeled } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { fullScope } from './scope';
import { demo17Volume, D17 } from './demo17';
import type { Report } from './kernel';

const vol0 = demo17Volume();
const matName = matNameOf(MATERIALS);
let keyN = 0;
const ctx = { orig: vol0, matName, newKey: () => `n${keyN++}` };
const L0 = initialLabeled(vol0, matName);
const base: EditState = { vol: vol0, L: L0 };
const { X, Y } = D17;

const UP: Vec3 = [0, -1, 0];
const LEFT: Vec3 = [-1, 0, 0];
const RIGHT: Vec3 = [1, 0, 0];
const AIR = 0, STI = 2, FIN = 3, HFO = 4, TIN = 5, POLY = 6, SIN = 7;

/** 某個材質、外框 x0 = x0（、z0 = z0）的結構 key。 */
const keyOf = (L: Labeled, mat: number, x0?: number, z0?: number) => {
  const c = L.comps.find((c) => c.mat === mat && (x0 === undefined || c.bbox.x0 === x0) && (z0 === undefined || c.bbox.z0 === z0));
  if (!c) throw new Error(`找不到結構 ${mat} ${x0} ${z0}`);
  return c.key;
};
const push = (keys: string[], dir: Vec3, n: number, locks: LockSpec[] = []): Op => ({ kind: 'push', keys, scope: fullScope(D17), dir, n, follow: true, backfill: 'outer', policy: 'adjacent', locks });
const move = (keys: string[], d: Vec3, locks: LockSpec[] = []): Op => ({ kind: 'translate', keys, scope: fullScope(D17), d, backfill: 'outer', follow: true, policy: 'adjacent', locks });

const diff = (a: Uint8Array, b: Uint8Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};

/** 套一步：兩條路逐體素相同；回傳裁切路徑的狀態與報告。 */
function run(s: EditState, op: Op): { s: EditState; r: Report } {
  const loc = applyOpLocal(s, op, ctx);
  const full = applyOp(s, op, ctx);
  expect(diff(loc.state.vol.data, full.vol.data)).toBe(0);
  return { s: loc.state, r: loc.report };
}

/** (x, z) 那一直排由上（y = 0）往下的材質段：[[材質, 格數], …]。 */
function stack(v: Volume, x: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < Y; y++) {
    const m = v.data[(z * Y + y) * X + x];
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}
/** (y, z) 那一橫排由左（x = 0）往右的材質段。 */
function rowX(v: Volume, y: number, z: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = 0; x < X; x++) {
    const m = v.data[(z * Y + y) * X + x];
    const last = out[out.length - 1];
    if (last && last[0] === m) last[1]++;
    else out.push([m, 1]);
  }
  return out;
}

const fin1 = keyOf(L0, FIN, 11);
const fin2 = keyOf(L0, FIN, 31);


const Z1 = 10; // 第一個閘極裡的一片
const Z0 = 2; // 閘極外的一片
const YF = 22; // fin 高度範圍裡、STI 以上的一排
/** 把外圍鎖起來（可被壓薄、最少留 keep 格）：等於以前「薄層跟著、厚層變薄」的效果。 */
const outerLocks = (keep: number): LockSpec[] => L0.comps.filter((c) => c.mat === POLY || c.mat === STI || c.key === fin2).map((c) => [c.key, keep]);

describe('kernel21：全部跟著動＋固定（plan v21 §3）', () => {
  it('原始模型：閘極裡 fin 那一排由左到右', () => {
    expect(rowX(vol0, YF, Z1)).toEqual([[AIR, 4], [POLY, 5], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 10], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 5], [AIR, 4]]);
    expect(rowX(vol0, YF, Z0)).toEqual([[AIR, 11], [FIN, 6], [AIR, 14], [FIN, 6], [AIR, 11]]);
  });

  it('1. 沒有固定：fin 右面外推 1，右邊全部（含另一根 fin、隔著空氣的那一段）整片右移 1；內縮 1 回到原樣', () => {
    const a = run(base, push([fin1], RIGHT, 1));
    expect(a.r.done).toBe(1);
    expect(rowX(a.s.vol, YF, Z1)).toEqual([[AIR, 4], [POLY, 5], [TIN, 1], [HFO, 1], [FIN, 7], [HFO, 1], [TIN, 1], [POLY, 10], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 5], [AIR, 3]]);
    expect(rowX(a.s.vol, YF, Z0)).toEqual([[AIR, 11], [FIN, 7], [AIR, 14], [FIN, 6], [AIR, 10]]);
    const b = run(a.s, push([keyOf(a.s.L, FIN, 11)], RIGHT, -1));
    expect(diff(b.s.vol.data, vol0.data)).toBe(0);
  });

  it('2. 外圍固定（最少留 2 格）：只有 HfO₂／TiN 跟著，Poly 變薄，另一根 fin 不動；內縮回到原樣', () => {
    const locks = outerLocks(2);
    const a = run(base, push([fin1], RIGHT, 3, locks));
    expect(a.r.done).toBe(3);
    expect(rowX(a.s.vol, YF, Z1)).toEqual([[AIR, 4], [POLY, 5], [TIN, 1], [HFO, 1], [FIN, 9], [HFO, 1], [TIN, 1], [POLY, 7], [TIN, 1], [HFO, 1], [FIN, 6], [HFO, 1], [TIN, 1], [POLY, 5], [AIR, 4]]);
    expect(rowX(a.s.vol, YF, Z0)).toEqual([[AIR, 11], [FIN, 9], [AIR, 11], [FIN, 6], [AIR, 11]]);
    const b = run(a.s, push([keyOf(a.s.L, FIN, 11)], RIGHT, -3, locks));
    expect(diff(b.s.vol.data, vol0.data)).toBe(0);
  });

  it('3. 可被壓薄的固定結構壓到最少厚度就整面停（lock）', () => {
    const r = run(base, push([fin1], RIGHT, 20, outerLocks(2))).r;
    expect(r.done).toBe(8); // Poly 10 格 → 2 格
    expect(r.stop?.why).toBe('lock');
    expect(r.stop?.mat).toBe(POLY);
    expect(r.stop?.keep).toBe(2);
  });

  it('4. 完全鎖定：推到它就整面停，一格都不做', () => {
    const tin1 = keyOf(L0, TIN, 9, 8);
    const r = run(base, push([fin1], RIGHT, 2, [[tin1, LOCK_FULL]]));
    expect(r.r.done).toBe(0);
    expect(r.r.stop?.why).toBe('lock');
    expect(diff(r.s.vol.data, vol0.data)).toBe(0);
  });

  it('5. 內縮、外層完全鎖定：它不跟，中間留空；另一個閘極照常跟著退', () => {
    const hfo1 = keyOf(L0, HFO, 10, 8);
    const a = run(base, push([fin1], RIGHT, -1, [[hfo1, LOCK_FULL]]));
    expect(a.r.done).toBe(1);
    expect(a.r.gaps).toEqual([HFO]);
    expect(rowX(a.s.vol, YF, Z1).slice(4, 8)).toEqual([[FIN, 5], [AIR, 1], [HFO, 1], [TIN, 1]]);
    expect(rowX(a.s.vol, YF, 26).slice(4, 7)).toEqual([[FIN, 5], [HFO, 1], [TIN, 1]]);
  });

  it('6. 內縮可以一路縮到消失；消失之後再縮＝min', () => {
    const sin1 = keyOf(L0, SIN, undefined, 8);
    const a = run(base, push([sin1], UP, -5));
    expect(a.r.done).toBe(3);
    expect(a.r.stop?.why).toBe('min');
    expect(stack(a.s.vol, 20, Z1).some(([m]) => m === SIN)).toBe(false);
    expect(a.s.L.comps.some((c) => c.key === sin1)).toBe(false);
  });

  it('7. 整塊平移＝前面外推＋後面內縮：搬過去再搬回來回到原樣', () => {
    const a = run(base, move([fin1], [2, 0, 0]));
    expect(a.r.done).toBe(2);
    expect(rowX(a.s.vol, YF, Z0)).toEqual([[AIR, 13], [FIN, 6], [AIR, 14], [FIN, 6], [AIR, 9]]);
    const b = run(a.s, move([keyOf(a.s.L, FIN, 13)], [-2, 0, 0]));
    expect(diff(b.s.vol.data, vol0.data)).toBe(0);
  });

  it('8. 平移碰到完全鎖定的結構：擋住；往另一邊搬，它不補上來、中間留空', () => {
    const sin1 = keyOf(L0, SIN, undefined, 8);
    const poly1 = keyOf(L0, POLY, undefined, 8);
    const locks: LockSpec[] = [[poly1, LOCK_FULL]];
    const down = run(base, move([sin1], [0, 1, 0], locks));
    expect(down.r.done).toBe(0);
    expect(down.r.stop?.why).toBe('lock');
    const up = run(base, move([sin1], [0, -1, 0], locks));
    expect(up.r.done).toBe(1);
    const col = stack(up.s.vol, 20, Z1);
    const k = col.findIndex(([m]) => m === SIN);
    expect(col[k]).toEqual([SIN, 3]);
    expect(col[k + 1]).toEqual([AIR, 1]);
    expect(col[k + 2][0]).toBe(POLY);
  });

  it('9. 多選兩根 fin 往右推（沒有固定）：兩根各寬 1 格，右邊那根另外被左邊那根帶著右移 1', () => {
    const a = run(base, push([fin1, fin2], RIGHT, 1));
    expect(a.r.done).toBe(1);
    expect(rowX(a.s.vol, YF, Z0)).toEqual([[AIR, 11], [FIN, 7], [AIR, 14], [FIN, 7], [AIR, 9]]);
  });

  it('10. fin 上面外推（外圍固定）：兩側側壁的 HfO₂／TiN 一起長高，轉角仍包著', () => {
    const locks = outerLocks(1);
    const a = run(base, push([fin1], UP, 2, locks));
    expect(a.r.done).toBe(2);
    const before = (x: number) => stack(vol0, x, Z1);
    const after = (x: number) => stack(a.s.vol, x, Z1);
    const count = (st: [number, number][], m: number) => st.filter(([k]) => k === m).reduce((p, [, n]) => p + n, 0);
    expect(count(after(13), FIN)).toBe(count(before(13), FIN) + 2);
    expect(count(after(10), HFO)).toBe(count(before(10), HFO) + 2); // HfO₂ 側壁
    expect(count(after(9), TIN)).toBe(count(before(9), TIN) + 2); // TiN 側壁
    expect(count(after(13), POLY)).toBe(count(before(13), POLY) - 2);
    expect(after(6)).toEqual(before(6)); // 旁邊的 Poly 那一排不動
  });
});

describe('kernel21 性質測試：隨機 120 步', () => {
  it('每一步兩條路相同（隨機的固定、推拉、平移）', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const DIRS: Vec3[] = [UP, [0, 1, 0], LEFT, RIGHT, [0, 0, 1], [0, 0, -1]];
    let s = base;
    for (let k = 0; k < 120; k++) {
      const comps = s.L.comps.filter((c) => c.mat !== AIR);
      const pick = () => comps[rnd(comps.length)];
      const locks: LockSpec[] = [];
      for (let j = rnd(4); j > 0; j--) locks.push([pick().key, rnd(3) === 0 ? LOCK_FULL : 1 + rnd(3)]);
      const lockKeys = new Set(locks.map(([key]) => key));
      const free = comps.filter((c) => !lockKeys.has(c.key));
      if (!free.length) continue;
      const c = free[rnd(free.length)];
      const keys = rnd(5) === 0 ? free.filter((x) => x.mat === c.mat).map((x) => x.key) : [c.key];
      const d = DIRS[rnd(6)];
      const n = 1 + rnd(3);
      const op = rnd(4) === 0 ? move(keys, d.map((v) => v * n) as Vec3, locks) : push(keys, d, rnd(3) === 0 ? -n : n, locks);
      s = run(s, op).s;
    }
  });
});
