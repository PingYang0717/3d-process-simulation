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
