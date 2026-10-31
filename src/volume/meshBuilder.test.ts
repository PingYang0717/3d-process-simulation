// plan v9 P13／P14：greedyMesh／greedyMeshChunk 改用 MeshBuilder＋共用 scratch 後，頂點／法線／顏色和以前逐元素相同。
import { describe, expect, it } from 'vitest';
import { DIFF_BIT, demoVolume, greedyMesh } from './volume';
import { chunkBox, chunkCount, gridOf, greedyMeshChunk } from './chunks';
import { greedyMeshChunkOld, greedyMeshOld } from './ref/meshOld';

const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const color = (c: number): [number, number, number] => [(c & 255) / 7, c & DIFF_BIT ? 0.9 : 0.1, 0.3];

describe('MeshBuilder（plan v9 P13）', () => {
  const vol = demoVolume();
  // 代碼：材質，部分標紅（不同代碼相鄰＝兩面都畫）
  const codes = new Uint16Array(vol.data.length);
  for (let i = 0; i < codes.length; i++) {
    const x = i % vol.X;
    const z = Math.floor(i / (vol.X * vol.Y));
    codes[i] = vol.data[i] ? (((x >> 3) + (z >> 3)) % 3 === 0 ? vol.data[i] | DIFF_BIT : vol.data[i]) : 0;
  }
  it('greedyMesh 新舊逐元素相同', () => {
    const a = greedyMesh(vol.X, vol.Y, vol.Z, codes, color);
    const b = greedyMeshOld(vol.X, vol.Y, vol.Z, codes, color);
    expect(a.quads).toBe(b.quads);
    expect(same(a.positions, b.positions) && same(a.normals, b.normals) && same(a.colors, b.colors)).toBe(true);
  }, 60000);
  it('greedyMeshChunk 新舊逐元素相同（每個 chunk，含陣列邊界的）', () => {
    const g = gridOf(vol, 32);
    const code = (i: number) => codes[i];
    for (let k = 0; k < chunkCount(g); k++) {
      const box = chunkBox(vol, g, k);
      const a = greedyMeshChunk(vol, code, box, color);
      const b = greedyMeshChunkOld(vol, code, box, color);
      expect(a.quads).toBe(b.quads);
      expect(same(a.positions, b.positions) && same(a.normals, b.normals) && same(a.colors, b.colors)).toBe(true);
    }
  }, 60000);
});
