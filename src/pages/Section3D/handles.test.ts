// plan v10 §4.5：3D 把手 → Op 的純函式。
import { describe, expect, it } from 'vitest';
import type { BBox } from '../../volume/volume';
import { faceAxisName, faceDragWords, faceHandles, faceSteps, facesCamera, pickHandle } from './handles3d';

const b: BBox = { x0: 10, x1: 19, y0: 20, y1: 39, z0: 0, z1: 99 };

describe('面把手', () => {
  it('六個面中央', () => {
    const fs = faceHandles(b);
    expect(fs).toHaveLength(6);
    expect(fs.find((f) => f.dir[1] === -1)!.pos).toEqual([15, 20, 50]);
    expect(fs.find((f) => f.dir[0] === 1)!.pos).toEqual([20, 30, 50]);
    expect(fs.find((f) => f.dir[2] === 1)!.pos).toEqual([15, 30, 100]);
  });
  it('螢幕位移 → 格數：沿法線投影、夾在上限', () => {
    // 法線 1 格 = 往右 10 px
    expect(faceSteps(32, 5, 10, 0, 10, 50)).toBe(3);
    expect(faceSteps(-21, 0, 10, 0, 10, 50)).toBe(-2);
    expect(faceSteps(1000, 0, 10, 0, 10, 7)).toBe(7);
  });
  it('正對著看（法線投影太短）：垂直位移 ÷ 每格像素，往上拖＝長', () => {
    expect(faceSteps(0, -40, 0.5, 0.5, 8, 50)).toBe(5);
    expect(faceSteps(0, 24, 0, 0, 8, 50)).toBe(-3);
  });
  it('背對相機的面不畫', () => {
    expect(facesCamera([0, 0, 1], [0, 0, 5])).toBe(true);
    expect(facesCamera([0, 0, -1], [0, 0, 5])).toBe(false);
  });

});

describe('點把手', () => {
  it('最近、在熱區內才算；不畫的略過', () => {
    const items = [
      { h: 'a', screen: [100, 100] as [number, number] },
      { h: 'b', screen: [108, 100] as [number, number] },
      { h: 'c', screen: null },
    ];
    expect(pickHandle(items, 106, 100)).toBe('b');
    expect(pickHandle(items, 200, 200)).toBeNull();
  });
});

describe('面把手的拖法說明（螢幕方向）', () => {
  it('箭頭朝左：往左拖＝長、往右拖＝縮', () => {
    expect(faceDragWords(-10, 0, 10)).toEqual({ grow: '往左', shrink: '往右' });
  });
  it('箭頭朝右上（螢幕 y 往下為正）', () => {
    expect(faceDragWords(7, -7, 10)).toEqual({ grow: '往右上', shrink: '往左下' });
  });
  it('正對著看：和 faceSteps 一樣用上下', () => {
    expect(faceDragWords(0.5, 0.5, 10)).toEqual({ grow: '往上', shrink: '往下' });
  });
  it('縮得很小（1 格不到 4 px）但斜著看：照箭頭方向，不是上下', () => {
    expect(faceDragWords(-2, 0.5, 3)).toEqual({ grow: '往左', shrink: '往右' });
    expect(faceSteps(-20, 0, -2, 0.5, 3, 50)).toBeGreaterThan(0);
  });
  it('面的名字用軸', () => {
    expect(faceAxisName([0, 0, -1])).toBe('z− 面');
    expect(faceAxisName([1, 0, 0])).toBe('x+ 面');
  });
});
