// plan v17 §7、v21：probe 回的「最多幾格」等於實際一路做到停的格數（推拉、平移六向、多選、有固定的結構）。
import { describe, expect, it } from 'vitest';
import { type Labeled, type LockSpec, type Vec3, LOCK_FULL, MATERIALS, initialLabeled } from './volume';
import { type EditState, type Op, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { fullScope } from './scope';
import { demo17Volume, D17 } from './demo17';
import { PROBE_DIRS, PROBE_MAX, PROBE_MOVE_MAX, probe } from './probe';

const vol = demo17Volume();
const matName = matNameOf(MATERIALS);
let k = 0;
const ctx = { orig: vol, matName, newKey: () => `p${k++}` };
const L = initialLabeled(vol, matName);
const s: EditState = { vol, L };
const keyOf = (L: Labeled, mat: number, x0: number, z0?: number) => L.comps.find((c) => c.mat === mat && c.bbox.x0 === x0 && (z0 === undefined || c.bbox.z0 === z0))!.key;
const fin1 = keyOf(L, 3, 11);
const fin2 = keyOf(L, 3, 31);
const poly1 = keyOf(L, 6, 4, 8);
const hfo1 = keyOf(L, 4, 10, 8);
const tin1 = keyOf(L, 5, 9, 8);
const FACES: Vec3[] = PROBE_DIRS;
/** 外圍（Poly、STI、另一根 fin）固定、可被壓薄、最少留 2 格。 */
const outer: LockSpec[] = L.comps.filter((c) => c.mat === 6 || c.mat === 2 || c.key === fin2).map((c) => [c.key, 2]);
const label = (keys: string[]) => keys.map((key) => L.comps.find((c) => c.key === key)!.label).sort();

const doneOf = (op: Op) => applyOpLocal(s, op, ctx).report.done ?? 0;
const push = (keys: string[], dir: Vec3, n: number, locks: LockSpec[]): Op => ({ kind: 'push', keys, scope: fullScope(D17), dir, n, follow: true, backfill: 'outer', policy: 'adjacent', locks });
const move = (keys: string[], d: Vec3, locks: LockSpec[]): Op => ({ kind: 'translate', keys, scope: fullScope(D17), d, backfill: 'outer', follow: true, policy: 'adjacent', locks });

describe('probe（plan v17 §5.4.4、v21）', () => {
  for (const [name, keys, locks] of [['fin 1（沒有固定）', [fin1], []], ['fin 1（外圍固定）', [fin1], outer], ['Poly 1', [poly1], []], ['兩根 fin', [fin1, fin2], []]] as [string, string[], LockSpec[]][])
    it(`推拉：${name}，六面的外推最多格數＝實際做到的格數；內縮＝縮到消失的前一格`, () => {
      for (const dir of FACES) {
        const p = probe(s, { keys, kind: 'push', dir, locks });
        expect(p.out!.n).toBe(doneOf(push(keys, dir, PROBE_MAX, locks)));
        // 內縮：一路縮到停＝其中一個結構整個消失（多選時其他的還會繼續，所以實際 ≥ vanishAt）
        expect(p.in!.n).toBe(p.vanishAt! - 1);
        expect(doneOf(push(keys, dir, -200, locks))).toBeGreaterThanOrEqual(p.vanishAt!);
      }
    });

  for (const [name, keys, locks] of [['fin 1（沒有固定）', [fin1], []], ['fin 1（外圍固定）', [fin1], outer], ['Poly 1', [poly1], []]] as [string, string[], LockSpec[]][])
    it(`平移：${name}，六個方向最多格數＝實際做到的格數（上限 ${PROBE_MOVE_MAX}）`, () => {
      const p = probe(s, { keys, kind: 'translate', locks });
      PROBE_DIRS.forEach((d, i) => {
        expect(p.dirs![i].n).toBe(doneOf(move(keys, d.map((v) => v * PROBE_MOVE_MAX) as Vec3, locks)));
      });
    });

  it('這一步會帶動誰：沒有固定＝上面的 HfO₂、TiN、Poly、SiN 都跟著；外圍固定＝HfO₂、TiN 跟著，Poly 會被推到', () => {
    const a = probe(s, { keys: [fin1], kind: 'push', dir: [0, -1, 0] });
    // 旁邊相連的同材質（另一根 fin 的 HfO₂／TiN 側壁）也在同一層被帶動：核心只看材質，不分是哪一個結構
    expect(label(a.follow)).toEqual(expect.arrayContaining(['HfO₂ 1', 'Poly-Si 1', 'Poly-Si 2', 'SiN 1', 'SiN 2', 'TiN 1']));
    expect(a.follow).toEqual(expect.arrayContaining([hfo1, tin1]));
    expect(label(a.follow)).not.toContain('Si fin 2');
    expect(a.hit).toEqual([]);
    const b = probe(s, { keys: [fin1], kind: 'push', dir: [0, -1, 0], locks: outer });
    expect(b.follow.map((key) => L.comps.find((c) => c.key === key)!.mat).sort()).toEqual([4, 4, 5, 5]);
    expect(b.follow).toEqual(expect.arrayContaining([hfo1, tin1]));
    expect(label(b.hit)).toEqual(['Poly-Si 1', 'Poly-Si 2']);
    // Poly 6 格、最少留 2：最多外推 4 格，擋住的那一格是 Poly（標出結構名字用）
    expect(b.out).toMatchObject({ n: 4, stop: { why: 'lock', mat: 6, keep: 2 } });
    expect(L.comps[L.labels[b.out!.stop!.at!]].mat).toBe(6);
  });

  it('完全鎖定的薄層：一格都推不動，寫出被誰擋', () => {
    const p = probe(s, { keys: [fin1], kind: 'push', dir: [1, 0, 0], locks: [[tin1, LOCK_FULL]] });
    expect(p.out).toMatchObject({ n: 0, stop: { why: 'lock', mat: 5, keep: LOCK_FULL } });
    expect(L.comps[L.labels[p.out!.stop!.at!]].key).toBe(tin1);
    expect(p.hit).toContain(tin1);
    expect(p.follow).toContain(hfo1);
  });

  it('內縮到消失：SiN 3 格厚，vanishAt = 3', () => {
    const sin1 = L.comps.find((c) => c.mat === 7 && c.bbox.z0 === 8)!.key;
    const p = probe(s, { keys: [sin1], kind: 'push', dir: [0, -1, 0] });
    expect(p.vanishAt).toBe(3);
    expect(p.in!.n).toBe(2);
  });
});
