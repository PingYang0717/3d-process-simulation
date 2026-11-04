// plan v16：有進度／可取消的 Worker 請求（generator）。
// 取消點在「算完、還沒寫回帳簿」：在那裡 return 掉，帳簿一格都沒動、head 不變；跑完整個 generator 和以前的同步結果相同。
import { beforeAll, describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from './volume';
import { type Op, matNameOf } from './ops';
import type { Progress } from './workerCore';

let core: typeof import('./workerCore');
const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
const matName = matNameOf(MATERIALS);

beforeAll(async () => {
  core = await import('./workerCore');
});

describe('apply／chunks／layer 的進度與取消', () => {
  it('apply：兩個 yield（compute、commit）都在寫回之前；在那裡 return 掉帳簿不變，跑完和同步 handle 相同', () => {
    const vol = demoVolume();
    core.handle('load', { sid: 500, vol: { ...vol, data: vol.data.slice() } });
    const L = initialLabeled(vol, matName);
    const fin = L.comps.find((c) => c.mat === 3)!;
    const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
    const op: Op = { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true };
    core.handle('fork', { owner: 'c1', src: 'base', sid: 500 });
    const before = core.inspect().books.get('c1')!.data.slice();
    const req = { owner: 'c1', from: 500, to: 501, comps: L.comps, op, matNames, keyCounter: 1000 };
    const g = core.gens.apply(req);
    const p1 = g.next();
    expect(p1.done).toBe(false);
    expect((p1 as { value: Progress }).value).toMatchObject({ phase: 'compute', cancellable: true });
    const p2 = g.next();
    expect(p2.done).toBe(false);
    expect((p2 as { value: Progress }).value).toMatchObject({ phase: 'commit', cancellable: true });
    // 在安全點取消：帳簿沒動、head 還是 500
    g.return(undefined as never);
    expect(core.inspect().books.get('c1')!.data).toEqual(before);
    expect(core.inspect().heads.get('c1')).toBe(500);
    // 重新跑完：有補丁、head 前進
    const [r] = core.handle('apply', req) as [{ step: { data: { box: unknown } | null } }, unknown];
    expect(r.step.data).not.toBeNull();
    expect(core.inspect().heads.get('c1')).toBe(501);
    expect(core.inspect().books.get('c1')!.data).not.toEqual(before);
  });

  it('chunks／layer：每批回報 done／total，跑完的 items 和 drain 相同', () => {
    const vol = demoVolume();
    core.handle('load', { sid: 600, vol: { ...vol, data: vol.data.slice() } });
    const hidden = new Uint8Array(256);
    const palette = new Float32Array(256 * 3).fill(0.5);
    const g = core.gens.chunks({ sid: 600, key: 'k', hidden, diff: false, palette });
    const seen: Progress[] = [];
    let out: { items: { k: number }[] } | null = null;
    for (;;) {
      const n = g.next();
      if (n.done) {
        out = n.value[0] as { items: { k: number }[] };
        break;
      }
      seen.push(n.value);
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toMatchObject({ phase: 'chunks', done: 0 });
    expect(seen.every((p) => p.cancellable && p.total === seen[0].total)).toBe(true);
    expect(seen[seen.length - 1].done).toBeLessThan(seen[0].total);
    const [sync] = core.handle('chunks', { sid: 600, key: 'k', hidden, diff: false, palette }) as [{ items: { k: number }[] }, unknown];
    expect(out!.items.map((i) => i.k)).toEqual(sync.items.map((i) => i.k));
    const L = initialLabeled(vol, matName);
    const fin = L.comps.findIndex((c) => c.mat === 3);
    const lg = core.gens.layer({ sid: 600, key: 'l', filter: { comps: [fin], scope: { axis: 'z', lo: 0, hi: vol.Z - 1 }, box: L.comps[fin].bbox }, tint: [0, 0, 1], inflate: 0.03 });
    const first = lg.next();
    expect(first.done).toBe(false);
    expect((first as { value: Progress }).value.phase).toBe('layer');
    expect(core.drain(lg)[0].items.length).toBeGreaterThan(0);
  });
});
