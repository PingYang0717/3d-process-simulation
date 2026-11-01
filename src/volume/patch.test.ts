// plan v9 §7：原地版本和純函式逐位元組相同；主執行緒差量更新的 diff／體積帳和全量重算相同。
import { describe, expect, it } from 'vitest';
import { type Comp, MATERIALS, VOID, countArray, demoVolume, diffMask, initialLabeled } from './volume';
import { type EditState, type Op, matNameOf } from './ops';
import { applyOpInPlace, applyOpLocal } from './apply';
import { type Step, applyStep, applyStepInPlace, carryStepStats, globalIndex } from './patch';

const matName = matNameOf(MATERIALS);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const vol = demoVolume();
const L0 = initialLabeled(vol, matName);
const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
/** 第 k 步的 Op：輪流長高、縮短、平移、換材質，挑目前還在的結構。 */
function opAt(k: number, comps: Comp[]): Op {
  const polys = comps.filter((c) => c.mat === 6);
  const fins = comps.filter((c) => c.mat === 3);
  const p = polys[k % polys.length] ?? comps[0];
  const f = fins[k % fins.length] ?? comps[0];
  switch (k % 5) {
    case 0:
      return { kind: 'push', keys: [p.key], scope: full, dir: [0, -1, 0], n: 1 + (k % 3), follow: true, backfill: 'orig' };
    case 1:
      return { kind: 'push', keys: [p.key], scope: full, dir: [0, -1, 0], n: -1, follow: true, backfill: 'orig' };
    case 2:
      return { kind: 'translate', keys: [p.key], scope: full, d: [k % 2 ? 1 : -1, 0, 0], backfill: 'orig' };
    case 3:
      return { kind: 'material', keys: [f.key], scope: { axis: 'z', lo: 30 + k, hi: 32 + k }, m: k % 2 ? 0 : 254 };
    default:
      return { kind: 'push', keys: [f.key], scope: { axis: 'z', lo: 10, hi: 60 }, dir: [1, 0, 0], n: 1, follow: false, backfill: 'orig' };
  }
}

describe('applyStepInPlace（§4.1）', () => {
  it('20 步：每一步原地貼 === 純 applyStep；全部 undo 回到原始、全部 redo 回到最後，逐位元組相同', () => {
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    let pure: EditState = { vol, L: L0 };
    const states: EditState[] = [pure];
    const steps: Step[] = [];
    for (let k = 0; k < 20; k++) {
      const r = applyOpLocal(pure, opAt(k, pure.L.comps), ctx);
      if (!r.step.data) continue;
      steps.push(r.step);
      pure = r.state;
      states.push(pure);
    }
    expect(steps.length).toBeGreaterThan(10);
    const data = vol.data.slice();
    const labels = L0.labels.slice();
    let comps = L0.comps;
    steps.forEach((st, k) => {
      const ref = applyStep(states[k], st, 'fwd');
      comps = applyStepInPlace(vol, data, labels, st, 'fwd') ?? comps;
      expect(same(data, ref.vol.data)).toBe(true);
      expect(same(labels, ref.L.labels)).toBe(true);
      expect(comps).toEqual(ref.L.comps);
    });
    for (let k = steps.length - 1; k >= 0; k--) {
      comps = applyStepInPlace(vol, data, labels, steps[k], 'back') ?? comps;
      expect(same(data, states[k].vol.data)).toBe(true);
      expect(same(labels, states[k].L.labels)).toBe(true);
      expect(comps).toEqual(states[k].L.comps);
    }
    for (let k = 0; k < steps.length; k++) applyStepInPlace(vol, data, labels, steps[k], 'fwd');
    expect(same(data, pure.vol.data)).toBe(true);
    expect(same(labels, pure.L.labels)).toBe(true);
  });
});

function sameStep(a: Step, b: Step) {
  expect(!!a.data).toBe(!!b.data);
  expect(!!a.labels).toBe(!!b.labels);
  if (a.data && b.data) {
    expect(a.data.box).toEqual(b.data.box);
    expect(same(a.data.before, b.data.before) && same(a.data.after, b.data.after)).toBe(true);
  }
  if (a.labels && b.labels) {
    expect(a.labels.box).toEqual(b.labels.box);
    expect(same(a.labels.before, b.labels.before) && same(a.labels.after, b.labels.after)).toBe(true);
    expect(a.labels.moves).toEqual(b.labels.moves);
    expect(a.labels.compsBefore).toEqual(b.labels.compsBefore);
    expect(a.labels.compsAfter).toEqual(b.labels.compsAfter);
  }
}

describe('applyOpInPlace（§4.3）', () => {
  it('原地套用 === 純 applyOpLocal；Step 逐欄相同（labels.before＝改前在 S 的裁片）', () => {
    let a = 1000;
    let b = 1000;
    let pure: EditState = { vol, L: L0 };
    const data = vol.data.slice();
    const labels = L0.labels.slice();
    let comps = L0.comps;
    for (let k = 0; k < 10; k++) {
      const op = opAt(k, comps);
      const ref = applyOpLocal(pure, op, { orig: vol, matName, newKey: () => `c${a++}` });
      const got = applyOpInPlace({ vol: { ...vol, data }, L: { labels, comps } }, op, { orig: vol, matName, newKey: () => `c${b++}` });
      sameStep(got.step, ref.step);
      comps = got.comps;
      pure = ref.state;
      expect(same(data, pure.vol.data)).toBe(true);
      expect(same(labels, pure.L.labels)).toBe(true);
      expect(comps).toEqual(pure.L.comps);
    }
  }, 60000);
});

describe('diff 與體積帳差量更新（§4.4，stats）', () => {
  it('隨機 30 步（含 undo／redo／reset）後差量 === 全量 diffMask／countArray', () => {
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    const data = vol.data.slice();
    const labels = L0.labels.slice();
    let comps = L0.comps;
    let diff = new Uint8Array(data.length);
    let dc = 0;
    let counts = Float64Array.from(countArray(vol.data));
    const hist: Step[] = [];
    let future: Step[] = [];
    let rnd = 7;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const check = () => {
      const ref = diffMask({ ...vol, data }, vol);
      expect(dc).toBe(ref.count);
      expect(same(diff, ref.mask)).toBe(true);
      expect(Array.from(counts)).toEqual(countArray(data));
    };
    for (let k = 0; k < 30; k++) {
      const r = rand();
      if (r < 0.15 && hist.length) {
        const st = hist.pop()!;
        comps = applyStepInPlace(vol, data, labels, st, 'back') ?? comps;
        dc = carryStepStats(vol, data, vol.data, diff, dc, counts, st, 'back');
        future.unshift(st);
      } else if (r < 0.25 && future.length) {
        const st = future.shift()!;
        comps = applyStepInPlace(vol, data, labels, st, 'fwd') ?? comps;
        dc = carryStepStats(vol, data, vol.data, diff, dc, counts, st, 'fwd');
        hist.push(st);
      } else if (r < 0.3) {
        // 回到原始：帳簿釋放、重新借用原始
        data.set(vol.data);
        labels.set(L0.labels);
        comps = L0.comps;
        diff = new Uint8Array(data.length);
        dc = 0;
        counts = Float64Array.from(countArray(vol.data));
        hist.length = 0;
        future = [];
      } else {
        const res = applyOpInPlace({ vol: { ...vol, data }, L: { labels, comps } }, opAt(k, comps), ctx);
        if (res.step.data) {
          comps = res.comps;
          dc = carryStepStats(vol, data, vol.data, diff, dc, counts, res.step, 'fwd');
          hist.push(res.step);
          future = [];
        }
      }
      check();
    }
  });
});

describe('globalIndex（plan v14 §5.1：從 cellCloud 搬來）', () => {
  it('裁切範圍的 index 換回整個陣列的 index', () => {
    const dims = { X: 10, Y: 8 };
    const box = { x0: 2, x1: 4, y0: 1, y1: 2, z0: 3, z1: 5 };
    // 外框裡 (x, y, z) = (1, 1, 2) → 整個陣列 (3, 2, 5)
    const local = (2 * 2 + 1) * 3 + 1;
    expect(globalIndex(box, dims, [0, local])).toEqual([(3 * 8 + 1) * 10 + 2, (5 * 8 + 2) * 10 + 3]);
  });
});

describe('diff 外框 O(X+Y+Z)（plan v15 A2）', () => {
  it('隨機 50 步（含 back／reset）：carryStepStats 維護的 axes → diffBoxOfAxes === tightBox(dims, diff, touch)；recountAxes 重數相同；voidAxes === recountMatAxes(VOID) 整陣列重數（M15.7）', async () => {
    const { diffBoxOfAxes, newAxes, recountAxes, recountMatAxes, tightBox, unionBox } = await import('./patch');
    const { stepTouch } = await import('../splits/lifecycle');
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    const data = vol.data.slice();
    const labels = L0.labels.slice();
    let comps = L0.comps;
    let diff = new Uint8Array(data.length);
    let dc = 0;
    let counts = Float64Array.from(countArray(vol.data));
    let axes = newAxes(vol);
    let voidAxes = recountMatAxes(vol, vol.data, VOID, null);
    let touch: import('./volume').BBox | null = null;
    const hist: Step[] = [];
    let future: Step[] = [];
    let rnd = 11;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let backs = 0;
    const check = () => {
      const want = dc ? tightBox(vol, diff, touch) : null;
      expect(diffBoxOfAxes(axes)).toEqual(want);
      const all = { x0: 0, x1: vol.X - 1, y0: 0, y1: vol.Y - 1, z0: 0, z1: vol.Z - 1 };
      const re = recountAxes(vol, diff, all);
      expect(same(re.x, axes.x) && same(re.y, axes.y) && same(re.z, axes.z)).toBe(true);
      // VOID 的三軸直方圖（M15.7 A5）：差量維護 === 整個陣列重數
      const rv = recountMatAxes(vol, data, VOID, null);
      expect(same(rv.x, voidAxes.x) && same(rv.y, voidAxes.y) && same(rv.z, voidAxes.z)).toBe(true);
    };
    for (let k = 0; k < 50; k++) {
      const r = rand();
      if (r < 0.2 && hist.length) {
        const st = hist.pop()!;
        comps = applyStepInPlace(vol, data, labels, st, 'back') ?? comps;
        dc = carryStepStats(vol, data, vol.data, diff, dc, counts, st, 'back', axes, voidAxes);
        touch = unionBox(touch, stepTouch(st));
        future.unshift(st);
        backs++;
      } else if (r < 0.3 && future.length) {
        const st = future.shift()!;
        comps = applyStepInPlace(vol, data, labels, st, 'fwd') ?? comps;
        dc = carryStepStats(vol, data, vol.data, diff, dc, counts, st, 'fwd', axes, voidAxes);
        touch = unionBox(touch, stepTouch(st));
        hist.push(st);
      } else if (r < 0.34) {
        data.set(vol.data);
        labels.set(L0.labels);
        comps = L0.comps;
        diff = new Uint8Array(data.length);
        dc = 0;
        counts = Float64Array.from(countArray(vol.data));
        axes = newAxes(vol);
        voidAxes = recountMatAxes(vol, vol.data, VOID, null);
        touch = null;
        hist.length = 0;
        future = [];
      } else {
        const res = applyOpInPlace({ vol: { ...vol, data }, L: { labels, comps } }, opAt(k, comps), ctx);
        if (res.step.data) {
          comps = res.comps;
          dc = carryStepStats(vol, data, vol.data, diff, dc, counts, res.step, 'fwd', axes, voidAxes);
          touch = unionBox(touch, stepTouch(res.step));
          hist.push(res.step);
          future = [];
        }
      }
      check();
    }
    expect(backs).toBeGreaterThan(0);
  }, 60_000);
});
