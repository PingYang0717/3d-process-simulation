// 縮窄時空出來的地方：'outer'（新預設）由外面緊鄰的那一層補上，不留空氣；'orig' 照舊（舊 Op 重播不變）。
import { describe, expect, it } from 'vitest';
import { pushSeq } from './volume';
import { cdSteps } from './ops';
import { fullScope } from './scope';
import type { Backfill } from './volume';

// 一維：gate(5)×4｜spacer(4)×6｜HfO₂(3)×2｜fin(1)×8｜HfO₂×2｜spacer×6｜gate×4
const ROW = [5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5];
const run = (delta: number, follow: boolean, backfill: Backfill, policy: 'block' | 'overwrite' = 'overwrite') => {
  const vol = { X: ROW.length, Y: 1, Z: 1, data: Uint8Array.from(ROW) };
  const mask = Uint8Array.from(ROW.map((m) => (m === 1 ? 1 : 0)));
  const steps = cdSteps({ kind: 'cd', keys: [], scope: fullScope(vol), axis: 0, delta, anchor: 'center', follow, backfill, policy });
  return Array.from(pushSeq(vol, vol, mask, steps, backfill, follow, policy).data).join('');
};

describe("縮窄的回填 'outer'", () => {
  it('襯層跟著往內，外面的 spacer 補上（沒有空氣）', () => {
    expect(run(-4, true, 'outer')).toBe('55554444444433111133444444445555');
  });
  it('襯層不跟：HfO₂ 往內補（變厚），沒有空氣', () => {
    expect(run(-4, false, 'outer')).toBe('55554444443333111133334444445555');
  });
  it('擋住／穿過去對縮窄一樣', () => {
    expect(run(-4, true, 'outer', 'block')).toBe(run(-4, true, 'outer', 'overwrite'));
  });
  it("'orig' 照舊（舊 Op 重播不變）：留空氣", () => {
    expect(run(-4, true, 'orig')).toBe('55554444440033111133004444445555');
  });
  it('襯層一路跟到陣列邊界：邊上那一層延伸，不留空氣', () => {
    const row = [4, 4, 3, 3, 1, 1, 1, 1, 3, 3, 4, 4];
    const vol = { X: row.length, Y: 1, Z: 1, data: Uint8Array.from(row) };
    const mask = Uint8Array.from(row.map((m) => (m === 1 ? 1 : 0)));
    const steps = cdSteps({ kind: 'cd', keys: [], scope: fullScope(vol), axis: 0, delta: -2, anchor: 'center', follow: true, backfill: 'outer', policy: 'overwrite' });
    expect(Array.from(pushSeq(vol, vol, mask, steps, 'outer', true, 'overwrite').data).join('')).toBe('444331133444');
  });
  it('長寬再縮回來＝原樣（外面的層夠厚）', () => {
    // spacer 8 格：長寬時被推開的 HfO₂ 吃掉 2 格後仍是厚層（> LINER_MAX），縮回時不會被當成襯層一起拉
    const ROW = [5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 3, 3, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5];
    const vol = { X: ROW.length, Y: 1, Z: 1, data: Uint8Array.from(ROW) };
    const mask = Uint8Array.from(ROW.map((m) => (m === 1 ? 1 : 0)));
    const grow = cdSteps({ kind: 'cd', keys: [], scope: fullScope(vol), axis: 0, delta: 4, anchor: 'center', follow: true, backfill: 'outer', policy: 'overwrite' });
    const g = pushSeq(vol, vol, mask, grow, 'outer', true, 'overwrite');
    const m2 = Uint8Array.from(Array.from(g.data).map((m) => (m === 1 ? 1 : 0)));
    const shrink = cdSteps({ kind: 'cd', keys: [], scope: fullScope(vol), axis: 0, delta: -4, anchor: 'center', follow: true, backfill: 'outer', policy: 'overwrite' });
    expect(Array.from(pushSeq(g, vol, m2, shrink, 'outer', true, 'overwrite').data).join('')).toBe(ROW.join(''));
  });
});
