// plan v12 §5.2：差異層 chunk 化。layer diff 的單位面 ≡ 舊 diffMesh.changed；只碰 diffBox 相交的 chunk；一步之後增量 ≡ 全量。
import { describe, expect, it } from 'vitest';
import { type BBox, type MeshData, MATERIALS } from './volume';
import { type ChunkItem, handle, inspect } from './workerCore';
import { chunksTouching, gridOf } from './chunks';
import { diffMeshOld } from './ref/diffMeshOld';
import { unitFaces } from './meshFaces.fixture';
import { base, comp, vol as fvol } from './ops11.fixture';
import type { Op } from './ops';

const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
const pal = new Float32Array(768);
MATERIALS.forEach((m, i) => pal.set([((i * 37) % 255) / 255, ((i * 91) % 255) / 255, ((i * 53) % 255) / 255], m.id * 3));

type LayerRes = { full: boolean; items: ChunkItem[] };
const layer = (sid: number, hidden = new Uint8Array(256), b?: number) =>
  handle('layer', { sid, key: 'd', filter: { diff: true }, tint: [1, 0, 0], palette: pal, hidden, base: b })[0] as LayerRes;
const meshes = (r: LayerRes) => r.items.map((it) => it.m);

describe('差異層（plan v12 §5.2）', () => {
  const vol = fvol;
  const poly = comp('Poly-Si 2');
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const ops: Op[] = [
    { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' },
    { kind: 'translate', keys: [poly.key], scope: full, d: [0, 0, 2], backfill: 'orig' },
  ];

  it('單位面 ≡ 舊 diffMesh.changed；只碰 diffBox 相交的 chunk；隱藏材質一樣', () => {
    handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
    handle('replay', { owner: 's1', src: 'base', from: 1, to: 2, comps: base.L.comps, ops, matNames, keyCounter: 1000 });
    const b = inspect().books.get('s1')!;
    const orig = inspect().books.get('base')!.data;
    for (const hidden of [new Uint8Array(256), (() => { const h = new Uint8Array(256); h[poly.mat] = 1; return h; })()]) {
      const r = layer(2, hidden);
      expect(r.full).toBe(true);
      const old = diffMeshOld({ ...vol, data: b.data }, orig, b.diff, hidden, pal);
      expect(old.quads).toBeGreaterThan(0);
      expect([...unitFaces(meshes(r))].sort()).toEqual([...unitFaces([old])].sort());
      const box = handle('diffBox', { sid: 2 })[0] as BBox | null;
      const g = gridOf(vol);
      const allowed = new Set(chunksTouching(vol, g, box!));
      for (const it of r.items) expect(allowed.has(it.k)).toBe(true);
    }
  });

  it('一步之後增量 ≡ 全量；原始那一本沒有差異層', () => {
    handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
    expect(layer(1).items.length).toBe(0);
    handle('fork', { owner: 's1', src: 'base', sid: 10 });
    let chunks = new Map<number, MeshData>();
    const take = (r: LayerRes) => {
      if (r.full) chunks = new Map();
      for (const it of r.items) {
        if (it.m.quads) chunks.set(it.k, it.m);
        else chunks.delete(it.k);
      }
    };
    take(layer(10));
    let cs = base.L.comps;
    let sid = 10;
    for (const op of ops) {
      const r = handle('apply', { owner: 's1', from: sid, to: sid + 1, comps: cs, op, matNames, keyCounter: 1000 })[0] as { step: { labels: { compsAfter: typeof cs } | null } };
      cs = r.step.labels?.compsAfter ?? cs;
      take(layer(sid + 1, undefined, sid));
      sid++;
      const whole = layer(sid);
      expect([...unitFaces([...chunks.values()])].sort()).toEqual([...unitFaces(meshes(whole))].sort());
    }
  });
});

