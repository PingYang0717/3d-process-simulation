// plan v14 的單元測試：圓頭範圍（roundFrame）、profile 的外框剪裁、圓頭回填「上面那層」、預設水平、縮圖描邊、設計區草稿清空。
import { describe, expect, it } from 'vitest';
import { type BBox, type Volume, MATERIALS, initialLabeled, maskOf } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { applyOpInPlace } from './apply';
import { fillAt } from './kernel';
import { applyProfileMask, keyBoxes } from './profile';
import { newReport } from './kernel';
import type { Scope } from './scope';
import { type RoundGesture, roundBuild, roundOp } from '../slice/round';
import { describeOp } from '../pages/Section3D/opWords';
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

/**
 * 閘極剖面（XY，沿 z 擠出）：fin（3）外面一圈 HfO₂（4）、再一圈 TiN（5），外面倒 U 形的 Poly（6），頂上 SiN cap（7），底下基板。
 */
function gateStack(): EditState {
  const X = 28;
  const Y = 24;
  const Z = 4;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        let m = 0;
        if (y >= 20) m = 1;
        else if (x >= 12 && x <= 15 && y >= 8) m = 3;
        else if (x >= 11 && x <= 16 && y >= 7) m = 4;
        else if (x >= 10 && x <= 17 && y >= 6) m = 5;
        else if (x >= 4 && x <= 23 && y >= 4) m = 6;
        else if (x >= 4 && x <= 23) m = 7;
        data[i] = m;
      }
  const vol: Volume = { X, Y, Z, data };
  return { vol, L: initialLabeled(vol, matName) };
}
const count = (d: Uint8Array, m: number) => d.reduce((n, v) => n + (v === m ? 1 : 0), 0);

describe('圓頭回填「上面那層」（plan v14 §5.3）', () => {
  const gr: RoundGesture = { kind: 'round', corners: [{ id: 'ul' }, { id: 'ur' }], r: 4, n: 2, mode: 'match' };

  it('kernel：fillAt 的 above 回呼；找不到退回 orig 規則', () => {
    const orig: Volume = { X: 2, Y: 1, Z: 1, data: new Uint8Array([6, 2]) };
    expect(fillAt(orig, 0, 6, 'above', () => 7)).toBe(7);
    expect(fillAt(orig, 0, 6, 'above', () => -1)).toBe(0);
    expect(fillAt(orig, 1, 6, 'above', () => -1)).toBe(2);
    expect(fillAt(orig, 0, 6, 'above')).toBe(0);
  });

  it('不帶襯層、填上面那層：AIR、HfO₂、TiN 計數不變，削掉的全是 SiN；裁切預覽＝整個陣列', () => {
    const s = gateStack();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    let seq = 1000;
    const ctx = { orig: s.vol, matName, newKey: () => `c${seq++}` };
    const { op, stats } = roundBuild(s.L, s.vol, [poly.key], { axis: 'z', lo: 0, hi: 3 }, 1, gr, false, 'orig', 0.5);
    expect(op).not.toBeNull();
    expect(op!.backfill).toBe('above');
    expect(stats.fillMat).toBe(7);
    const a = applyOp(s, op!, ctx);
    for (const m of [0, 4, 5]) expect(count(a.vol.data, m)).toBe(count(s.vol.data, m));
    let cut = 0;
    for (let i = 0; i < a.vol.data.length; i++)
      if (a.vol.data[i] !== s.vol.data[i]) {
        expect(s.vol.data[i]).toBe(6);
        expect(a.vol.data[i]).toBe(7);
        cut++;
      }
    expect(cut).toBe(stats.cut * s.vol.Z);
    // Worker／預覽走的裁切路徑：逐體素相同
    const c: EditState = { vol: { ...s.vol, data: s.vol.data.slice() }, L: { labels: s.L.labels.slice(), comps: s.L.comps } };
    applyOpInPlace(c, op!, ctx);
    expect(c.vol.data).toEqual(a.vol.data);
    // 一句話寫出填什麼
    expect(describeOp({ L: s.L, nm: 0.5, matName, scope: '整根' }, op as Op)).toContain('填上面那層');
  });

  it('對照：舊規則（填回原始＋襯層跟著）會出現空氣——測試有鑑別力', () => {
    const s = gateStack();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    let seq = 1000;
    const ctx = { orig: s.vol, matName, newKey: () => `c${seq++}` };
    const op = roundOp(s.L, s.vol, [poly.key], { axis: 'z', lo: 0, hi: 3 }, 1, gr, true, 'orig')!;
    const old = { ...op, backfill: 'orig' as const };
    const a = applyOp(s, old, ctx);
    expect(count(a.vol.data, 0)).toBeGreaterThan(count(s.vol.data, 0));
  });

  it('XZ 剖面（沿 y）沒有「上」：照舊 orig', () => {
    const s = gateStack();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const op = roundOp(s.L, s.vol, [poly.key], { axis: 'y', lo: 4, hi: 19 }, 10, gr, false, 'orig');
    if (op) expect(op.backfill).toBe('orig');
  });
});
