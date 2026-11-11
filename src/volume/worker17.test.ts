// plan v17 §5.4.2、§5.5、M17.2：Worker 載入時判定薄層；'adjacent' 的 apply 帶回做了幾格、被誰擋、鄰居怎麼了；probe。
// 直接呼叫 workerCore.handle（同一套 handler，不經過假 Worker）。
import { describe, expect, it } from 'vitest';
import * as core from './workerCore';
import { MATERIALS, initialLabeled } from './volume';
import { type Op, matNameOf } from './ops';
import { fullScope } from './scope';
import { demo17Volume, D17 } from './demo17';
import type { OpReport } from './report';
import type { Probe } from './probe';
import type { Step } from './patch';

const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));

describe('Worker（plan v17）', () => {
  const vol = demo17Volume();
  const [ld] = core.handle('load', { sid: 9001, vol: { ...vol, data: vol.data.slice() } }) as [{ liners: number[]; labels: Int32Array }, unknown];
  const L = initialLabeled(vol, matNameOf(MATERIALS));
  core.handle('fork', { owner: 's17', src: 'base', sid: 9001 });
  const fin1 = L.comps.find((c) => c.mat === 3 && c.bbox.x0 === 11)!;

  it('load 回薄層材質：HfO₂、TiN、SiN', () => {
    expect(ld.liners).toEqual([4, 5, 7]);
  });

  it('probe：fin 上面最多可外推 5 格（到 Poly 剩 1 格），HfO₂、TiN 跟著，Poly 變薄', () => {
    const [p] = core.handle('probe', { sid: 9001, comps: L.comps, keys: [fin1.key], kind: 'push', dir: [0, -1, 0], follow: true, liners: ld.liners }) as [Probe, unknown];
    expect(p.out).toMatchObject({ n: 5, stop: { why: 'last', mat: 6 } });
    expect(p.follow).toEqual([4, 5]);
    expect(p.thin).toEqual([6]);
  });

  it('apply：外推 8 只做 5、被 Poly 擋；HfO₂、TiN 跟著，Poly 變薄；改了幾個體素', () => {
    const op: Op = { kind: 'push', keys: [fin1.key], scope: fullScope(D17), dir: [0, -1, 0], n: 8, follow: true, backfill: 'outer', policy: 'adjacent', liners: ld.liners };
    const [r] = core.handle('apply', { owner: 's17', from: 9001, to: 9002, comps: L.comps, op, matNames, keyCounter: 100 }) as [{ report: OpReport; step: Step }, unknown];
    expect(r.report.done).toBe(5);
    expect(r.report.stop).toMatchObject({ why: 'last', mat: 6 });
    expect(r.report.effects).toEqual({ follow: [4, 5], lost: [6], gained: [], both: [] });
    let n = 0;
    const d = r.step.data!;
    for (let i = 0; i < d.before.length; i++) if (d.before[i] !== d.after[i]) n++;
    expect(r.report.changed).toBe(n);
    expect(n).toBeGreaterThan(0);
  });
});
