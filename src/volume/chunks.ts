// 3D 網格切 chunk（plan v7 §8.4、§10.6）：一步之後只重算和補丁外框（外擴 1 格）相交的 chunk。
// 每個 chunk 自己負責「起點那一面」的所有面（最後一個 chunk 另外負責陣列的外邊界），
// 判斷面時看的是整個陣列的代碼（不把 chunk 外當空氣），所以 chunk 交界不會多出內部牆。
import type { BBox, MeshData } from './volume';

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
export function greedyMeshChunk(d: Dims, code: (i: number) => number, box: BBox, colorOf: (code: number) => [number, number, number]): MeshData {
  const dims = [d.X, d.Y, d.Z];
  const lo = [box.x0, box.y0, box.z0];
  const hi = [box.x1, box.y1, box.z1];
  const size = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  // 外擴 1 格的區域代碼（出界 = 0）
  const pw = size[0] + 2;
  const ph = size[1] + 2;
  const pd = size[2] + 2;
  const codes = new Uint16Array(pw * ph * pd);
  for (let z = 0; z < pd; z++) {
    const gz = lo[2] - 1 + z;
    if (gz < 0 || gz >= d.Z) continue;
    for (let y = 0; y < ph; y++) {
      const gy = lo[1] - 1 + y;
      if (gy < 0 || gy >= d.Y) continue;
      const row = (gz * d.Y + gy) * d.X;
      for (let x = 0; x < pw; x++) {
        const gx = lo[0] - 1 + x;
        if (gx < 0 || gx >= d.X) continue;
        codes[(z * ph + y) * pw + x] = code(row + gx);
      }
    }
  }
  const stride = [1, pw, pw * ph];
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  let quads = 0;
  const BOTH = 1 << 30;
  const mask = new Int32Array(Math.max(size[0] * size[1], size[1] * size[2], size[0] * size[2]));
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3;
    const v = (a + 2) % 3;
    // 這個 chunk 負責的面：起點那一面到終點前一面；碰到陣列外邊界時也負責外邊界那一面
    const pEnd = hi[a] + 1 === dims[a] ? hi[a] + 1 : hi[a];
    for (let p = lo[a]; p <= pEnd; p++) {
      // 平面 p 在 p−1 和 p 兩格之間（區域座標 +1）
      const t = p - lo[a]; // p−1 的區域座標
      let n = 0;
      const sa = stride[a];
      const su = stride[u];
      const sv = stride[v];
      for (let j = 0; j < size[v]; j++) {
        let ia = t * sa + su + (j + 1) * sv;
        for (let i = 0; i < size[u]; i++, ia += su) {
          const A = codes[ia];
          const B = codes[ia + sa];
          mask[n++] = A === B ? 0 : A && !B ? A : !A && B ? -B : BOTH | (A << 15) | B;
        }
      }
      n = 0;
      for (let j = 0; j < size[v]; j++)
        for (let i = 0; i < size[u]; ) {
          const c = mask[n];
          if (!c) {
            i++;
            n++;
            continue;
          }
          let w = 1;
          while (i + w < size[u] && mask[n + w] === c) w++;
          let h = 1;
          grow: for (; j + h < size[v]; h++) for (let k = 0; k < w; k++) if (mask[n + k + h * size[u]] !== c) break grow;
          const faces: [number, number][] =
            c > 0 && c & BOTH
              ? [
                  [(c >> 15) & 0x7fff, 1],
                  [c & 0x7fff, -1],
                ]
              : c > 0
                ? [[c, 1]]
                : [[-c, -1]];
          const x = [0, 0, 0];
          x[a] = p;
          x[u] = lo[u] + i;
          x[v] = lo[v] + j;
          const du = [0, 0, 0];
          const dv = [0, 0, 0];
          du[u] = w;
          dv[v] = h;
          const p0 = [x[0], x[1], x[2]];
          const p1 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
          const p2 = [x[0] + du[0] + dv[0], x[1] + du[1] + dv[1], x[2] + du[2] + dv[2]];
          const p3 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];
          for (const [cd, sign] of faces) {
            const rgb = colorOf(cd);
            const tris = sign > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
            const nn = [0, 0, 0];
            nn[a] = sign;
            for (const q of tris) {
              pos.push(q[0], q[1], q[2]);
              nor.push(nn[0], nn[1], nn[2]);
              col.push(rgb[0], rgb[1], rgb[2]);
            }
            quads++;
          }
          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * size[u]] = 0;
          i += w;
          n += w;
        }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col), quads };
}
