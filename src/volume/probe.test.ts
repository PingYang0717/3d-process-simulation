// plan v17 §7：probe 回的「最多幾格」等於實際一路推到停的格數（推拉、平移六向、多選）。
import { describe, expect, it } from 'vitest';
import { type Labeled, type Vec3, MATERIALS, initialLabeled, linerTable } from './volume';
import { type EditState, type Op, matNameOf } from './ops';
import { applyOpLocal } from './apply';
import { fullScope } from './scope';
import { demo17Volume, D17 } from './demo17';
import { PROBE_DIRS, PROBE_MOVE_MAX, probe } from './probe';

const vol = demo17Volume();
const matName = matNameOf(MATERIALS);
let k = 0;
const ctx = { orig: vol, matName, newKey: () => `p${k++}` };
const L = initialLabeled(vol, matName);
const s: EditState = { vol, L };
const liners = linerTable(vol);
const keyOf = (L: Labeled, mat: number, x0: number, z0?: number) => L.comps.find((c) => c.mat === mat && c.bbox.x0 === x0 && (z0 === undefined || c.bbox.z0 === z0))!.key;
const fin1 = keyOf(L, 3, 11);
const fin2 = keyOf(L, 3, 31);
const poly1 = keyOf(L, 6, 4, 8);
const FACES: Vec3[] = PROBE_DIRS;

const doneOf = (op: Op) => applyOpLocal(s, op, ctx).report.done ?? 0;
const push = (keys: string[], dir: Vec3, n: number, follow: boolean): Op => ({ kind: 'push', keys, scope: fullScope(D17), dir, n, follow, backfill: 'outer', policy: 'adjacent', liners });
const move = (keys: string[], d: Vec3, follow: boolean): Op => ({ kind: 'translate', keys, scope: fullScope(D17), d, backfill: 'outer', follow, policy: 'adjacent', liners });

describe('probe（plan v17 §5.4.4）', () => {
  for (const [name, keys] of [['fin 1', [fin1]], ['Poly 1', [poly1]], ['兩根 fin', [fin1, fin2]]] as [string, string[]][])
    for (const follow of [true, false])
      it(`推拉：${name}、${follow ? '跟著移動' : '留在原地'}，六面的外推／內縮最多格數＝實際做到的格數`, () => {
        for (const dir of FACES) {
          const p = probe(s, { keys, kind: 'push', dir, follow, liners });
          expect(p.out!.n).toBe(doneOf(push(keys, dir, 60, follow)));
          expect(p.in!.n).toBe(doneOf(push(keys, dir, -60, follow)));
        }
      });

  for (const [name, keys] of [['fin 1', [fin1]], ['Poly 1', [poly1]], ['兩根 fin', [fin1, fin2]]] as [string, string[]][])
    it(`平移：${name}，六個方向最多格數＝實際做到的格數（上限 ${PROBE_MOVE_MAX}）`, () => {
      const p = probe(s, { keys, kind: 'translate', follow: true, liners });
      PROBE_DIRS.forEach((d, i) => {
        const real = Math.min(PROBE_MOVE_MAX, doneOf(move(keys, d.map((v) => v * 40) as Vec3, true)));
        expect(p.dirs![i].n).toBe(real);
      });
    });

  it('鄰居：fin 上面跟著移動＝HfO₂、TiN 跟著、Poly 變薄；留在原地＝HfO₂ 變薄', () => {
    const a = probe(s, { keys: [fin1], kind: 'push', dir: [0, -1, 0], follow: true, liners });
    expect(a.follow).toEqual([4, 5]);
    expect(a.thin).toEqual([6]);
    expect(a.out).toMatchObject({ n: 5, stop: { why: 'last', mat: 6 } });
    // 擋住的那一格是 fin 1 上方閘極裡的 Poly（標出結構名字用）
    expect(L.comps[L.labels[a.out!.stop!.at!]].mat).toBe(6);
    const b = probe(s, { keys: [fin1], kind: 'push', dir: [0, -1, 0], follow: false, liners });
    expect(b.follow).toEqual([]);
    expect(b.thin).toEqual([4]);
    expect(b.out).toMatchObject({ n: 0, stop: { why: 'last', mat: 4 } });
  });

  it('平移鄰居：整圈 HfO₂／TiN 跟著；Poly、STI、Si 的厚度會變', () => {
    const p = probe(s, { keys: [fin1], kind: 'translate', follow: true, liners });
    expect(p.follow).toEqual([4, 5]);
    expect(p.thin).toEqual([1, 2, 6]);
  });
});
