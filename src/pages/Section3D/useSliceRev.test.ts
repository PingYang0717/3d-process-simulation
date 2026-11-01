// plan v15 §5.3 A4：「沒碰到這一片就不重描」的判斷（純函式；hook 只是把狀態放進 ref）。
import { describe, expect, it } from 'vitest';
import type { BBox, Labeled } from '../../volume/volume';
import { type SliceRevKey, type SliceRevState, planeHit, sliceTouched, stepSliceRev } from './useSliceRev';

const L1 = { comps: [] } as unknown as Labeled;
const L2 = { comps: [] } as unknown as Labeled;
const box: BBox = { x0: 10, x1: 19, y0: 20, y1: 39, z0: 5, z1: 9 };
const key = (L: Labeled | undefined, seq: number | undefined, axis: 'x' | 'y' | 'z' = 'z', at = 7): SliceRevKey => ({ L, seq, axis, at });

describe('planeHit', () => {
  it('沿各軸看 at 有沒有落在外框裡（含兩端）', () => {
    expect(planeHit(box, 'z', 5)).toBe(true);
    expect(planeHit(box, 'z', 9)).toBe(true);
    expect(planeHit(box, 'z', 4)).toBe(false);
    expect(planeHit(box, 'z', 10)).toBe(false);
    expect(planeHit(box, 'y', 20)).toBe(true);
    expect(planeHit(box, 'y', 40)).toBe(false);
    expect(planeHit(box, 'x', 19)).toBe(true);
    expect(planeHit(box, 'x', 0)).toBe(false);
  });
  it('沒有外框＝沒碰到', () => {
    expect(planeHit(null, 'z', 7)).toBe(false);
    expect(planeHit(undefined, 'z', 7)).toBe(false);
  });
});

describe('sliceTouched', () => {
  it('第一次、換片：一律變了', () => {
    expect(sliceTouched(null, key(L1, 0), null)).toBe(true);
    expect(sliceTouched(key(L1, 3), key(L1, 3, 'z', 8), null)).toBe(true);
    expect(sliceTouched(key(L1, 3), key(L1, 3, 'y', 7), null)).toBe(true);
  });
  it('都沒動：沒變', () => {
    expect(sliceTouched(key(L1, 3), key(L1, 3), box)).toBe(false);
    expect(sliceTouched(key(undefined, undefined), key(undefined, undefined), null)).toBe(false);
  });
  it('L 身分變了但 seq 沒動（換 split、換檔、重播）：變了', () => {
    expect(sliceTouched(key(L1, 3), key(L2, 3), null)).toBe(true);
    expect(sliceTouched(key(L1, undefined), key(L2, undefined), null)).toBe(true);
  });
  it('seq +1 且外框沒碰到這一片：沒變；碰到：變了', () => {
    // z=7 在 box 的 z0..z1 裡
    expect(sliceTouched(key(L1, 3), key(L2, 4), box)).toBe(true);
    // z=12 不在
    expect(sliceTouched(key(L1, 3, 'z', 12), key(L2, 4, 'z', 12), box)).toBe(false);
    // 另一個軸：y=25 在 20..39 裡、y=50 不在
    expect(sliceTouched(key(L1, 3, 'y', 25), key(L2, 4, 'y', 25), box)).toBe(true);
    expect(sliceTouched(key(L1, 3, 'y', 50), key(L2, 4, 'y', 50), box)).toBe(false);
  });
  it('seq +1 但那一步沒有外框（null）：當成碰到', () => {
    expect(sliceTouched(key(L1, 3, 'z', 12), key(L2, 4, 'z', 12), null)).toBe(true);
  });
  it('seq 跳號、從 null 開始、或被清成 null（換檔）：變了', () => {
    expect(sliceTouched(key(L1, 3, 'z', 12), key(L2, 5, 'z', 12), box)).toBe(true);
    expect(sliceTouched(key(L1, undefined, 'z', 12), key(L2, 1, 'z', 12), box)).toBe(true);
    expect(sliceTouched(key(L1, 3, 'z', 12), key(L2, undefined, 'z', 12), box)).toBe(true);
  });
  it('seq +1、外框沒碰到，但 L 沒換（stepSeq 先到、帳簿後到的順序）：沒變', () => {
    expect(sliceTouched(key(L1, 3, 'z', 12), key(L1, 4, 'z', 12), box)).toBe(false);
  });
});

describe('stepSliceRev（hook 的一次 render）', () => {
  it('rev 只在 touched 的那次 +1；同一組輸入再算一次回同一個狀態（StrictMode 第二次呼叫不會翻成 false）', () => {
    let s: SliceRevState | null = null;
    s = stepSliceRev(s, key(L1, 0, 'z', 12), null);
    expect(s).toMatchObject({ rev: 1, touched: true });
    const again = stepSliceRev(s, key(L1, 0, 'z', 12), null);
    expect(again).toBe(s);
    // 一步沒碰到：rev 不動、touched false
    s = stepSliceRev(s, key(L2, 1, 'z', 12), box);
    expect(s).toMatchObject({ rev: 1, touched: false });
    expect(stepSliceRev(s, key(L2, 1, 'z', 12), box)).toBe(s);
    // 下一步碰到：rev +1
    const L3 = { comps: [] } as unknown as Labeled;
    s = stepSliceRev(s, key(L3, 2, 'z', 12), { ...box, z1: 12 });
    expect(s).toMatchObject({ rev: 2, touched: true });
    // 換片：+1
    s = stepSliceRev(s, key(L3, 2, 'z', 13), { ...box, z1: 12 });
    expect(s).toMatchObject({ rev: 3, touched: true });
    // 不相干的 state 變了（輸入相同）：同一個
    expect(stepSliceRev(s, key(L3, 2, 'z', 13), { ...box, z1: 12 })).toBe(s);
  });
  it('連續幾步都沒碰到：rev 一直不動，但 seq 對照的是上一次的 seq（跳號就算變了）', () => {
    let s: SliceRevState | null = stepSliceRev(null, key(L1, 0, 'z', 12), null);
    const Ls = [L2, { comps: [] } as unknown as Labeled, { comps: [] } as unknown as Labeled];
    Ls.forEach((L, i) => {
      s = stepSliceRev(s, key(L, i + 1, 'z', 12), box);
      expect(s!.touched).toBe(false);
    });
    expect(s!.rev).toBe(1);
    s = stepSliceRev(s, key(L1, 5, 'z', 12), box);
    expect(s).toMatchObject({ rev: 2, touched: true });
  });
});
