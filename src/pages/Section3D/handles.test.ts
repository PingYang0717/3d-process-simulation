// plan v10 §4.5：3D 把手 → Op 的純函式。
import { describe, expect, it } from 'vitest';
import type { BBox } from '../../volume/volume';
import { faceAxisName, faceDragWords, faceHandles, surfaceHandles, faceSteps, facesCamera, pickHandle } from './handles3d';

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

describe('surfaceHandles（plan v19 §3.2）：箭頭貼在結構的表面上、離十字最近', () => {
  // 8×6×4 的 L 形：x 0–7、y 3–5 一整條，加上 x 0–1、y 0–2 的一根柱子（y 越小越上面）
  const X = 8, Y = 6, Z = 4;
  const labels = new Int32Array(X * Y * Z).fill(-1);
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++) if (y >= 3 || x <= 1) labels[(z * Y + y) * X + x] = 0;
  const box = { x0: 0, y0: 0, z0: 0, x1: 7, y1: 5, z1: 3 };
  const up = (hs: ReturnType<typeof surfaceHandles>) => hs.find((h) => h.dir[1] === -1)!;

  it('十字在矮的那一段：上面的箭頭貼在那一段的頂面（y = 3），不是外框頂（y = 0）', () => {
    expect(up(surfaceHandles(labels, X, Y, 0, box, [6, 4, 1])).pos).toEqual([6.5, 3, 1.5]);
  });
  it('十字在柱子上：貼在柱子頂（y = 0）', () => {
    expect(up(surfaceHandles(labels, X, Y, 0, box, [1, 1, 2])).pos).toEqual([1.5, 0, 2.5]);
  });
  it('每一支都在表面上：往內半格是結構、往外半格不是', () => {
    const at = (p: number[]) => (p.some((v, k) => v < 0 || v >= [X, Y, Z][k]) ? -1 : labels[(Math.floor(p[2]) * Y + Math.floor(p[1])) * X + Math.floor(p[0])]);
    for (const anchor of [[6, 4, 1], [0, 0, 0], [7, 5, 3], [3, 1, 2]] as [number, number, number][])
      for (const h of surfaceHandles(labels, X, Y, 0, box, anchor)) {
        expect(at(h.pos.map((v, k) => v - h.dir[k] * 0.5))).toBe(0);
        expect(at(h.pos.map((v, k) => v + h.dir[k] * 0.5))).toBe(-1);
      }
  });
  it('十字在結構外面：夾到外框裡最近的那一格', () => {
    expect(up(surfaceHandles(labels, X, Y, 0, box, [20, 0, 9])).pos).toEqual([7.5, 3, 3.5]);
  });
});
