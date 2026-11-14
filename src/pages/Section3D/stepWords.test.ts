// plan v17 §5.5：每種句型。
import { describe, expect, it } from 'vitest';
import { blockText, blockedText, faceName, limitText, materialParts, namesOf, stepParts } from './stepWords';

const NAMES: Record<number, string> = { 3: 'Si fin', 4: 'HfO₂', 5: 'TiN', 6: 'Poly-Si', 7: 'SiN', 2: 'STI SiO₂' };
const mn = (id: number) => NAMES[id] ?? `材質 ${id}`;

describe('stepWords', () => {
  it('稱呼：一個＝名字；兩三個＝全部列出；更多＝材質 ×n', () => {
    expect(namesOf([{ label: 'Si fin 2', mat: 3 }], mn)).toBe('Si fin 2');
    expect(namesOf([{ label: 'Si fin 1', mat: 3 }, { label: 'Si fin 2', mat: 3 }], mn)).toBe('Si fin 1、Si fin 2');
    expect(namesOf([1, 2, 3, 4].map((k) => ({ label: `HfO₂ ${k}`, mat: 4 })), mn)).toBe('HfO₂ ×4');
  });

  it('方向：上＝y 變小、前＝z 變大', () => {
    expect(faceName([0, -1, 0])).toBe('上');
    expect(faceName([0, 0, 3])).toBe('前');
    expect(faceName([-2, 0, 0])).toBe('左');
  });

  it('外推：第一句＋每種鄰居一句（都寫出幾格）', () => {
    const p = stepParts({ kind: 'push', who: 'Si fin 2', face: '上', n: 2, done: 2, nmPerVoxel: 0.5, follow: true, effects: { follow: [4, 5], lost: [6], gained: [], both: [] } }, mn);
    expect(p.join(' · ')).toBe('Si fin 2 上面外推 2 格（1.0 nm） · HfO₂、TiN 跟著移動 2 格 · Poly-Si 變薄 2 格');
  });

  it('內縮：外面那層變厚', () => {
    const p = stepParts({ kind: 'push', who: 'Si fin 1', face: '上', n: -1, done: 1, nmPerVoxel: 0.5, follow: false, effects: { follow: [], lost: [], gained: [4], both: [] } }, mn);
    expect(p).toEqual(['Si fin 1 上面內縮 1 格（0.5 nm）', 'HfO₂ 變厚 1 格']);
  });

  it('平移：一側變薄、另一側變厚', () => {
    const p = stepParts({ kind: 'translate', who: 'Si fin 1', face: '左', n: 3, done: 3, nmPerVoxel: 0.5, follow: true, effects: { follow: [4, 5], lost: [], gained: [], both: [2, 6] } }, mn);
    expect(p).toEqual(['Si fin 1 往左搬 3 格（1.5 nm）', 'HfO₂、TiN 跟著移動 3 格', 'STI SiO₂、Poly-Si 一側變薄、另一側變厚 3 格']);
  });

  it('沒做滿：再加一句原因（有結構名字用名字）', () => {
    const p = stepParts({ kind: 'push', who: 'Si fin 1', face: '上', n: 8, done: 5, nmPerVoxel: 0.5, follow: true, effects: { follow: [4, 5], lost: [6], gained: [], both: [] }, stop: { why: 'last', mat: 6 }, stopWho: 'Poly-Si 1' }, mn);
    expect(p[p.length - 1]).toBe('只做了 5 格：Poly-Si 1 在模型邊界只剩 1 格');
    const q = stepParts({ kind: 'push', who: 'Si fin 1', face: '上', n: 8, done: 5, nmPerVoxel: 0.5, stop: { why: 'lock', mat: 6, keep: 2 }, stopWho: 'Poly-Si 1' }, mn);
    expect(q[q.length - 1]).toBe('只做了 5 格：Poly-Si 1 已經壓到它的最少厚度');
  });

  it('一格都沒做：不進清單，寫「擋下來了」', () => {
    expect(stepParts({ kind: 'push', who: 'x', face: '上', n: 1, done: 0, nmPerVoxel: 1, follow: false }, mn)).toEqual([]);
    expect(blockedText({ why: 'lock', mat: 5, keep: 255 }, mn, 'TiN 1')).toBe('擋下來了：被完全鎖定的 TiN 1 擋住');
    expect(blockedText({ why: 'edge' }, mn)).toBe('擋下來了：已經到模型邊界');
  });

  it('事先告知：最多到哪裡、怎麼解', () => {
    expect(limitText({ why: 'lock', mat: 6, keep: 2 }, mn, 'Poly-Si 1')).toBe('到 Poly-Si 1 壓到最少厚度為止');
    expect(limitText({ why: 'lock', mat: 6, keep: 255 }, mn, 'Poly-Si 1')).toBe('到完全鎖定的 Poly-Si 1 為止');
    expect(limitText({ why: 'edge' }, mn)).toBe('到模型邊界為止');
    expect(blockText({ why: 'min' }, mn)).toBe('已經沒有東西可以縮');
  });

  it('留空與消失：各加一句；消失之後不再寫「只做了幾格」', () => {
    const p = stepParts({ kind: 'push', who: 'SiN 1', face: '上', n: -5, done: -3, nmPerVoxel: 0.5, gaps: [4], gone: 'SiN 1', stop: { why: 'min' } }, mn);
    expect(p).toEqual(['SiN 1 上面內縮 3 格（1.5 nm）', 'HfO₂ 完全鎖定、沒有跟著：中間留空', '⚠ SiN 1 整個消失']);
  });

  it('換材質：名字跟著材質重新編號', () => {
    expect(materialParts('SiN 1', 'SiGe', 'SiGe 1')).toEqual(['SiN 1 換成 SiGe（現在叫 SiGe 1）']);
    expect(materialParts('SiN 1', 'SiGe', 'SiN 1')).toEqual(['SiN 1 換成 SiGe']);
  });
});
