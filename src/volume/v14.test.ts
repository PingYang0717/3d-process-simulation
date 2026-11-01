// plan v14 的單元測試：圓頭範圍（roundFrame）、profile 的外框剪裁、圓頭回填「上面那層」、預設水平、縮圖描邊、設計區草稿清空。
import { describe, expect, it } from 'vitest';
import { type BBox, type Volume, MATERIALS, initialLabeled, maskOf } from './volume';
import { type EditState, matNameOf } from './ops';
import { applyProfileMask, keyBoxes } from './profile';
import { newReport } from './kernel';
import type { Scope } from './scope';
import { roundOp } from '../slice/round';
import { roundFrame } from '../pages/Section3D/RoundCard';

const matName = matNameOf(MATERIALS);

/** X×Y×Z：一根沿 x 的「閘極」（Poly，mat 6）只占 x 4..13、z 1..3；底下基板 Si。 */
function gate(): EditState {
  const X = 20;
  const Y = 12;
  const Z = 6;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (y >= 9) data[i] = 1;
        else if (x >= 4 && x <= 13 && y >= 3 && z >= 1 && z <= 3) data[i] = 6;
      }
  const vol: Volume = { X, Y, Z, data };
  return { vol, L: initialLabeled(vol, matName) };
}

describe('roundFrame（plan v14 §5.2）：範圍＝結構實際占的那段', () => {
  const s = gate();
  const poly = s.L.comps.find((c) => c.mat === 6)!;
  const selMask = maskOf(s.L, new Set([poly.key]))!;
  const fake = (scopeMode: 'whole' | 'slice' | 'custom', scope: Scope) => ({
    editAxis: 'z' as const,
    cursor: [8, 5, 2] as [number, number, number],
    selMask,
    vol: s.vol,
    selBox: poly.bbox as BBox,
    scope,
    scopeMode,
    selComps: [poly],
  });

  it('整個結構：最長軸 x 的剖面、scope＝外框沿 x 的起止（不是 0～X-1）', () => {
    const f = roundFrame(fake('whole', { axis: 'z', lo: 0, hi: 5 }));
    expect(f.axis).toBe('x');
    expect(f.scope).toEqual({ axis: 'x', lo: 4, hi: 13 });
    expect(f.at).toBe(8);
  });

  it('此片：scope＝參考片那一片', () => {
    const f = roundFrame(fake('slice', { axis: 'z', lo: 2, hi: 2 }));
    expect(f.scope).toEqual({ axis: 'x', lo: f.at, hi: f.at });
  });

  it('自訂且同軸：照自訂；不同軸：退回整個結構', () => {
    expect(roundFrame(fake('custom', { axis: 'x', lo: 6, hi: 9 })).scope).toEqual({ axis: 'x', lo: 6, hi: 9 });
    expect(roundFrame(fake('custom', { axis: 'z', lo: 1, hi: 2 })).scope).toEqual({ axis: 'x', lo: 4, hi: 13 });
  });
});

describe('applyProfileMask 的外框剪裁（plan v14 P2）', () => {
  it('給 boxes 與不給：結果逐位元組相同、skipped 相同', () => {
    const s = gate();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    // 整條 z（結構只占 1..3）：外框外的片要略過
    const op = roundOp(s.L, s.vol, [poly.key], { axis: 'z', lo: 0, hi: 5 }, 2, { kind: 'round', corners: [{ id: 'ul' }, { id: 'ur' }], r: 3, n: 2, mode: 'match' }, false, 'orig')!;
    expect(op).not.toBeNull();
    const masks = new Map([[poly.key, maskOf(s.L, new Set([poly.key]))!]]);
    const r1 = newReport();
    const r2 = newReport();
    const a = applyProfileMask(s.vol, s.vol, masks, op, [0, 0, 0], r1);
    const b = applyProfileMask(s.vol, s.vol, masks, op, [0, 0, 0], r2, undefined, keyBoxes(s.L, op.keys));
    expect(b.data).toEqual(a.data);
    expect(r2.skipped).toEqual(r1.skipped);
    expect(r1.skipped).toEqual([0, 4, 5]);
  });
});
