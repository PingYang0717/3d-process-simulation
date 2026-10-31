import { describe, expect, it } from 'vitest';
import { type MeshData, demoVolume, greedyMesh } from './volume';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from './chunks';

/** 每種（法線、顏色）的面積：chunk 切法不同、合併方式不同，但面積必須一樣。 */
function areas(ms: MeshData[]) {
  const out = new Map<string, number>();
  for (const m of ms)
    for (let t = 0; t < m.positions.length; t += 9) {
      const p = m.positions;
      const ax = p[t + 3] - p[t];
      const ay = p[t + 4] - p[t + 1];
      const az = p[t + 5] - p[t + 2];
      const bx = p[t + 6] - p[t];
      const by = p[t + 7] - p[t + 1];
      const bz = p[t + 8] - p[t + 2];
      const area = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
      const key = `${m.normals[t]},${m.normals[t + 1]},${m.normals[t + 2]}|${m.colors[t].toFixed(3)}`;
      out.set(key, (out.get(key) ?? 0) + area);
    }
  return out;
}
const color = (c: number): [number, number, number] => [c / 10, 0, 0];

describe('chunk 網格（§8.4）', () => {
  const vol = demoVolume();
  const codes = new Uint16Array(vol.data.length);
  for (let i = 0; i < codes.length; i++) codes[i] = vol.data[i];
  const whole = greedyMesh(vol.X, vol.Y, vol.Z, codes, color);
  const g = gridOf(vol, 32);

  it('所有 chunk 的面積和＝整個陣列 greedy mesh 的面積（每種法線、顏色分開比）', () => {
    const parts: MeshData[] = [];
    for (let k = 0; k < chunkCount(g); k++) parts.push(greedyMeshChunk(vol, (i) => codes[i], chunkBox(vol, g, k), color));
    const a = areas([whole]);
    const b = areas(parts);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) expect(b.get(k)).toBeCloseTo(v, 3);
  }, 60_000);

  it('改一小塊之後只重算 chunksTouching 的 chunk，結果和全部重算相同', () => {
    const before: MeshData[] = [];
    for (let k = 0; k < chunkCount(g); k++) before.push(greedyMeshChunk(vol, (i) => codes[i], chunkBox(vol, g, k), color));
    // 在 chunk 交界附近塞一塊材質 9（x 30～33 跨過 32 的交界）
    const box = { x0: 30, x1: 33, y0: 10, y1: 12, z0: 63, z1: 64 };
    const next = codes.slice();
    for (let z = box.z0; z <= box.z1; z++) for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) next[(z * vol.Y + y) * vol.X + x] = 9;
    const dirty = new Set(chunksTouching(vol, g, box));
    expect(dirty.size).toBeLessThan(chunkCount(g));
    const partial = before.map((m, k) => (dirty.has(k) ? greedyMeshChunk(vol, (i) => next[i], chunkBox(vol, g, k), color) : m));
    const fresh: MeshData[] = [];
    for (let k = 0; k < chunkCount(g); k++) fresh.push(greedyMeshChunk(vol, (i) => next[i], chunkBox(vol, g, k), color));
    const a = areas(fresh);
    const b = areas(partial);
    expect([...b.keys()].sort()).toEqual([...a.keys()].sort());
    for (const [k, v] of a) expect(b.get(k)).toBeCloseTo(v, 3);
  }, 60_000);

  it('chunksTouching 外擴 1 格（貼在交界上的改動也要重算鄰居）', () => {
    const t = chunksTouching(vol, g, { x0: 32, x1: 32, y0: 5, y1: 5, z0: 5, z1: 5 });
    expect(t).toEqual([0, 1]);
  });
});

// ---- plan v9 §4.6：圖層 chunk 化 ----
import { MATERIALS, initialLabeled } from './volume';
import { matNameOf } from './ops';
import * as core from './workerCore';

/** 每個 quad（連續 6 個頂點）拆成單位面：`法線|平面座標|u|v`；inflate 先扣回去。 */
function unitFaces(ms: MeshData[], inflate = 0) {
  const out = new Set<string>();
  for (const m of ms)
    for (let q = 0; q < m.positions.length; q += 18) {
      const n = [m.normals[q], m.normals[q + 1], m.normals[q + 2]];
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 18; k += 3)
        for (let a = 0; a < 3; a++) {
          const v = Math.round(m.positions[q + k + a] - n[a] * inflate);
          lo[a] = Math.min(lo[a], v);
          hi[a] = Math.max(hi[a], v);
        }
      const d = n[0] ? 0 : n[1] ? 1 : 2;
      const [u, w] = [0, 1, 2].filter((a) => a !== d);
      for (let i = lo[u]; i < hi[u]; i++) for (let j = lo[w]; j < hi[w]; j++) out.add(`${n.join(',')}|${lo[d]}|${i}|${j}`);
    }
  return out;
}
const setEq = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

describe('圖層 chunk 化（plan v9 §4.6）', () => {
  const vol = demoVolume();
  const L = initialLabeled(vol, matNameOf(MATERIALS));
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  type Res = { full: boolean; items: { k: number; m: MeshData }[] };
  const layer = (req: Parameters<typeof core.handlers.layer>[0]) => core.handle('layer', req)[0] as Res;

  it('選取層的 chunk 合起來＝外框裡一次 greedy mesh（含外推、scope 只有一段）', () => {
    core.handle('load', { sid: 1, vol });
    const polys = L.comps.flatMap((c, i) => (c.mat === 6 ? [i] : []));
    const box = L.comps[polys[0]].bbox;
    for (const scope of [
      { axis: 'z' as const, lo: 0, hi: vol.Z - 1 },
      { axis: 'x' as const, lo: box.x0 + 3, hi: box.x0 + 20 },
    ]) {
      const filter = { comps: polys.slice(0, 2), scope, box: { ...box, x1: Math.max(box.x1, L.comps[polys[1]].bbox.x1), z0: Math.min(box.z0, L.comps[polys[1]].bbox.z0), z1: Math.max(box.z1, L.comps[polys[1]].bbox.z1) } };
      const r = layer({ sid: 1, key: 'sel', filter, tint: [0, 0, 1], inflate: 0.02 });
      expect(r.full).toBe(true);
      const ref = core.handle('mesh', { sid: 1, hidden: new Uint8Array(256), only: filter, palette: new Float32Array(768), tint: [0, 0, 1], inflate: 0.02 })[0] as MeshData;
      expect(ref.quads).toBeGreaterThan(0);
      expect(setEq(unitFaces(r.items.map((i) => i.m), 0.02), unitFaces([ref], 0.02))).toBe(true);
    }
    // VOID 層＝材質 254（範例裡有 bamboo defect）
    const v = layer({ sid: 1, key: 'void', filter: { mat: 254 }, tint: [0, 0, 0] });
    const vref = core.handle('mesh', { sid: 1, hidden: new Uint8Array(256), only: { mat: 254 }, palette: new Float32Array(768), tint: [0, 0, 0] })[0] as MeshData;
    expect(setEq(unitFaces(v.items.map((i) => i.m)), unitFaces([vref]))).toBe(true);
  });

  it('增量：髒的範圍用 relabel 的 S——切斷 fin（體素只改中間幾片），另一段換了結構也會重畫', () => {
    core.handle('load', { sid: 10, vol });
    core.handle('fork', { owner: 'a', src: 'base', sid: 10 });
    const fi = L.comps.findIndex((c) => c.mat === 3);
    const fin = L.comps[fi];
    const scope = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
    const filter0 = { comps: [fi], scope, box: fin.bbox };
    const before = layer({ sid: 10, key: 'k', filter: filter0, tint: [0, 0, 1] });
    const [r] = core.handle('apply', { owner: 'a', from: 10, to: 11, comps: L.comps, op: { kind: 'material', keys: [fin.key], scope: { axis: 'z', lo: 60, hi: 63 }, m: 0 }, matNames, keyCounter: 1000 }) as [
      { step: import('./patch').Step },
      unknown,
    ];
    const comps = r.step.labels!.compsAfter;
    // 選取仍是同一個 key：被切下來的另一段換了新 key，不再是選取
    const idx = comps.flatMap((c, i) => (c.key === fin.key ? [i] : []));
    expect(idx.length).toBe(1);
    const filter = { comps: idx, scope, box: comps[idx[0]].bbox };
    const inc = layer({ sid: 11, key: 'k', filter, tint: [0, 0, 1], base: 10 });
    expect(inc.full).toBe(false);
    const full = layer({ sid: 11, key: 'k', filter, tint: [0, 0, 1] });
    // 合成：舊的 chunk 換掉髒的 ＝ 全量
    const map = new Map(before.items.map((i) => [i.k, i.m]));
    for (const it of inc.items) if (it.m.quads) map.set(it.k, it.m);
    else map.delete(it.k);
    expect(setEq(unitFaces([...map.values()]), unitFaces(full.items.map((i) => i.m)))).toBe(true);
    // 只用體素補丁外框（舊做法）會漏掉被切下來那一段
    const g = gridOf(vol);
    const dataOnly = new Set(chunksTouching(vol, g, r.step.data!.box));
    expect(inc.items.some((i) => !dataOnly.has(i.k))).toBe(true);
  });
});
