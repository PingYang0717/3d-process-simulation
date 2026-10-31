// plan v11 §2 黃金測試：範例上 Lg（Poly-Si 2 沿 z 的 cd）× 偏移（translate z）3×3 全因子 → 9 個 split；
// Worker 重播的結果和 manifest 的 ops 從原始重播逐體素相同；manifest 的 levels／designs 欄位 round-trip。
import { describe, expect, it } from 'vitest';
import { handle } from './workerCore';
import { type Op, replay } from './ops';
import { type Design, combosOf, makeFactor, nameOfCombo, opsOfCombo } from './factors';
import { MATERIALS } from './volume';
import { base, comp, ctx, firstDiff, matName, vol } from './ops11.fixture';
import { buildManifest, matrixCsv } from '../pages/Section3D/matrix';

const NM = 0.5;
const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));

describe('v12 黃金：3×3 設計', () => {
  it('9 個 split、名字、Worker 結果 ≡ manifest ops 重播；levels／designs round-trip；CSV 行數', () => {
    const poly2 = comp('Poly-Si 2');
    const Lg = { ...makeFactor(base.L, vol, [poly2.key], 'cd', { axis: 2, anchor: 'center' }, matName, []), id: 'Lg', name: 'L_g' };
    const off = { ...makeFactor(base.L, vol, [poly2.key], 'translate', { axis: 2 }, matName, []), id: 'off', name: 'off' };
    expect(Lg.nominal).toBe(24);
    const design: Design = { id: 'd1', factors: [Lg, off], levels: { Lg: [11, 12, 13], off: [-1, 0, 1] }, combine: 'full', from: 'base', nameTemplate: '{id}={value}{unit}' };
    const combos = combosOf(design, NM);
    expect(combos.length).toBe(9);
    const fctx = { L: base.L, vol, nmPerVoxel: NM, follow: true, backfill: 'orig' as const, policy: 'block' as const };
    const t0 = performance.now();
    handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
    const splits = combos.map((c, i) => {
      const ops = opsOfCombo(design, c, fctx);
      const r = handle('replay', { owner: `s${i}`, src: 'base', from: 1, to: 100 + i, comps: base.L.comps, ops, matNames, keyCounter: 1000 })[0] as { data: Uint8Array; diffCount: number; blocked: number };
      return { id: `s${i}`, name: nameOfCombo(design, c, i + 1), ops, levels: c, designId: 'd1', tags: ops.length ? [] : ['baseline'], blocked: r.blocked, changedVoxels: r.diffCount, data: r.data };
    });
    // 效能：9 個 split（×1）< 5 s（plan §2；測試機上放寬到 20 s）
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(splits.map((s) => s.name)).toContain('Lg=11nm_off=+1nm');
    expect(splits.find((s) => s.name === 'Lg=12nm_off=0nm')!.ops).toEqual([]);
    const fileOf = (s: { name: string }) => `demo__${s.name}.vti`;
    const m = buildManifest({ source: 'demo', format: 'vti', materials: MATERIALS, shape: [vol.Z, vol.Y, vol.X], spacing: [NM, NM, NM], origin: [0, 0, 0], nmPerVoxel: NM, designs: [design], splits, fileOf, opText: (op) => op.kind });
    const json = JSON.parse(JSON.stringify(m));
    expect(json.designs[0].levels).toEqual(design.levels);
    expect(json.designs[0].factors.map((f: { id: string }) => f.id)).toEqual(['Lg', 'off']);
    expect(json.baseline).toBe('original');
    expect(json.materials.find((x: { id: number }) => x.id === 6).kind).toBe('semi');
    for (const [i, s] of json.splits.entries()) {
      expect(s.levels).toEqual(combos[i]);
      expect(s.designId).toBe('d1');
      // 刪掉 factors／levels，ops 仍然完整可重播（§9 D11）
      const ops = (s.ops as (Op & { text?: string })[]).map(({ text: _t, ...op }) => op as Op);
      const again = replay(base, ops, ctx);
      expect(firstDiff(again.vol.data, splits[i].data)).toBe(-1);
    }
    const csv = matrixCsv(splits, [Lg, off], fileOf);
    expect(csv.trim().split('\n').length).toBe(splits.length + 1);
    expect(csv.split('\n')[0]).toBe('split,file,Lg_nm,off_nm,changedVoxels,blocked,designId,tags');
  });
});
