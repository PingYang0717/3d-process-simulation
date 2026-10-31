// 3D 網格切 chunk（plan v7 §8.4、§10.6）：一步之後只重算和補丁外框（外擴 1 格）相交的 chunk。
// 每個 chunk 自己負責「起點那一面」的所有面（最後一個 chunk 另外負責陣列的外邊界），
// 判斷面時看的是整個陣列的代碼（不把 chunk 外當空氣），所以 chunk 交界不會多出內部牆。
import type { BBox, MeshData } from './volume';
import { BOTH, MeshBuilder, emitFaces } from './meshBuilder';

type Dims = { X: number; Y: number; Z: number };

/** chunk 邊長：3,000 萬以下 32³，否則 64³（draw call 不要太多）。 */
export const chunkSizeFor = (d: Dims) => (d.X * d.Y * d.Z <= 30_000_000 ? 32 : 64);

export interface ChunkGrid {
  size: number;
  nx: number;
  ny: number;
  nz: number;
}
export const gridOf = (d: Dims, size = chunkSizeFor(d)): ChunkGrid => ({
  size,
  nx: Math.ceil(d.X / size),
  ny: Math.ceil(d.Y / size),
  nz: Math.ceil(d.Z / size),
});
export const chunkCount = (g: ChunkGrid) => g.nx * g.ny * g.nz;

/** 第 k 個 chunk 的範圍（含端點）。 */
export function chunkBox(d: Dims, g: ChunkGrid, k: number): BBox {
  const cx = k % g.nx;
  const cy = Math.floor(k / g.nx) % g.ny;
  const cz = Math.floor(k / (g.nx * g.ny));
  const s = g.size;
  return { x0: cx * s, x1: Math.min(d.X, (cx + 1) * s) - 1, y0: cy * s, y1: Math.min(d.Y, (cy + 1) * s) - 1, z0: cz * s, z1: Math.min(d.Z, (cz + 1) * s) - 1 };
}

/** 和 box（外擴 1 格）相交的 chunk。 */
export function chunksTouching(_d: Dims, g: ChunkGrid, box: BBox): number[] {
  const s = g.size;
  const lo = (v: number) => Math.max(0, Math.floor((v - 1) / s));
  const hi = (v: number, n: number) => Math.min(n - 1, Math.floor((v + 1) / s));
  const out: number[] = [];
  for (let cz = lo(box.z0); cz <= hi(box.z1, g.nz); cz++)
    for (let cy = lo(box.y0); cy <= hi(box.y1, g.ny); cy++)
      for (let cx = lo(box.x0); cx <= hi(box.x1, g.nx); cx++) out.push((cz * g.ny + cy) * g.nx + cx);
  return out;
}

/**
 * 一個 chunk 的 greedy mesh：code(i) 是整個陣列第 i 格的網格代碼（0 = 不畫）。
 * 規則和 greedyMesh 相同（同代碼、同朝向、相鄰的面合併；兩種非 0 代碼相鄰兩面都畫）。
 */
/** 外擴 1 格的區域代碼：模組層共用（plan v9 P14），不夠大才換大的，用前清掉要用的那一段。 */
let scratch = new Uint16Array(0);

export function greedyMeshChunk(d: Dims, code: (i: number) => number, box: BBox, colorOf: (code: number) => [number, number, number]): MeshData {
  const dims = [d.X, d.Y, d.Z];
  const lo = [box.x0, box.y0, box.z0];
  const hi = [box.x1, box.y1, box.z1];
  const size = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  // 外擴 1 格的區域代碼（出界 = 0）
  const pw = size[0] + 2;
  const ph = size[1] + 2;
  const pd = size[2] + 2;
  const len = pw * ph * pd;
  if (scratch.length < len) scratch = new Uint16Array(len);
  const codes = scratch;
  codes.fill(0, 0, len);
  for (let z = 0; z < pd; z++) {
    const gz = lo[2] - 1 + z;
    if (gz < 0 || gz >= d.Z) continue;
    for (let y = 0; y < ph; y++) {
      const gy = lo[1] - 1 + y;
      if (gy < 0 || gy >= d.Y) continue;
      const row = (gz * d.Y + gy) * d.X;
      const x0 = Math.max(0, 1 - lo[0]);
      const x1 = Math.min(pw, d.X - lo[0] + 1);
      for (let x = x0, k = (z * ph + y) * pw + x0, i = row + lo[0] - 1 + x0; x < x1; x++, k++, i++) codes[k] = code(i);
    }
  }
  const stride = [1, pw, pw * ph];
  const mb = new MeshBuilder();
  const mask = new Int32Array(Math.max(size[0] * size[1], size[1] * size[2], size[0] * size[2]));
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    // 這個 chunk 負責的面：起點那一面到終點前一面；碰到陣列外邊界時也負責外邊界那一面
    const pEnd = hi[a] + 1 === dims[a] ? hi[a] + 1 : hi[a];
    const W = size[u];
    const sa = stride[a];
    const su = stride[u];
    const sv = stride[v];
    const x = [0, 0, 0];
    for (let p = lo[a]; p <= pEnd; p++) {
      // 平面 p 在 p−1 和 p 兩格之間（區域座標 +1）
      const t = p - lo[a]; // p−1 的區域座標
      let n = 0;
      for (let j = 0; j < size[v]; j++) {
        let ia = t * sa + su + (j + 1) * sv;
        for (let i = 0; i < W; i++, ia += su) {
          const A = codes[ia];
          const B = codes[ia + sa];
          mask[n++] = A === B ? 0 : A && !B ? A : !A && B ? -B : BOTH | (A << 15) | B;
        }
      }
      n = 0;
      x[a] = p;
      for (let j = 0; j < size[v]; j++)
        for (let i = 0; i < W; ) {
          const c = mask[n];
          if (!c) {
            i++;
            n++;
            continue;
          }
          let w = 1;
          while (i + w < W && mask[n + w] === c) w++;
          let h = 1;
          grow: for (; j + h < size[v]; h++) for (let k = 0; k < w; k++) if (mask[n + k + h * W] !== c) break grow;
          x[u] = lo[u] + i;
          x[v] = lo[v] + j;
          emitFaces(mb, c, a, u, v, x[0], x[1], x[2], w, h, colorOf);
          for (let l = 0; l < h; l++) mask.fill(0, n + l * W, n + l * W + w);
          i += w;
          n += w;
        }
    }
  }
  return mb.finish();
}
