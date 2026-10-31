// plan v9 之前的 greedyMesh／greedyMeshChunk（number[] push、每個 quad 配中間陣列）：meshBuilder.test.ts 的對照。
import type { BBox, MeshData } from '../volume';

type Dims = { X: number; Y: number; Z: number };

export function greedyMeshOld(
  X: number,
  Y: number,
  Z: number,
  codes: Uint16Array,
  colorOf: (code: number) => [number, number, number],
): MeshData {
  const dims = [X, Y, Z];
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  let quads = 0;
  const stride = [1, X, X * Y];
  const BOTH = 1 << 30;
  const mask = new Int32Array(Math.max(X * Y, Y * Z, X * Z));
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const x = [0, 0, 0];
    for (x[d] = -1; x[d] < dims[d]; ) {
      // 這一片的面：正值 = 朝 +d 的面、負值 = 朝 −d、BOTH = 兩面都有（直接算 index，不逐格判斷出界）
      let n = 0;
      const t = x[d];
      const hasA = t >= 0;
      const hasB = t < dims[d] - 1;
      const sd = stride[d];
      const su = stride[u];
      for (let j = 0; j < dims[v]; j++) {
        let i0 = j * stride[v] + t * sd;
        for (let i = 0; i < dims[u]; i++, i0 += su) {
          const a = hasA ? codes[i0] : 0;
          const b = hasB ? codes[i0 + sd] : 0;
          mask[n++] = a === b ? 0 : a && !b ? a : !a && b ? -b : BOTH | (a << 15) | b;
        }
      }
      x[d]++;
      n = 0;
      for (let j = 0; j < dims[v]; j++)
        for (let i = 0; i < dims[u]; ) {
          const c = mask[n];
          if (!c) {
            i++;
            n++;
            continue;
          }
          let w = 1;
          while (i + w < dims[u] && mask[n + w] === c) w++;
          let h = 1;
          grow: for (; j + h < dims[v]; h++)
            for (let k = 0; k < w; k++) if (mask[n + k + h * dims[u]] !== c) break grow;
          // 負值的二補數也帶著 bit 30，所以先看正負再看 BOTH
          const faces: [number, number][] =
            c > 0 && c & BOTH
              ? [
                  [(c >> 15) & 0x7fff, 1],
                  [c & 0x7fff, -1],
                ]
              : c > 0
                ? [[c, 1]]
                : [[-c, -1]];
          x[u] = i;
          x[v] = j;
          const du = [0, 0, 0];
          const dv = [0, 0, 0];
          du[u] = w;
          dv[v] = h;
          const p0 = [x[0], x[1], x[2]];
          const p1 = [x[0] + du[0], x[1] + du[1], x[2] + du[2]];
          const p2 = [x[0] + du[0] + dv[0], x[1] + du[1] + dv[1], x[2] + du[2] + dv[2]];
          const p3 = [x[0] + dv[0], x[1] + dv[1], x[2] + dv[2]];
          for (const [code, sign] of faces) {
            const rgb = colorOf(code);
            const tris = sign > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
            const nn = [0, 0, 0];
            nn[d] = sign;
            for (const p of tris) {
              pos.push(p[0], p[1], p[2]);
              nor.push(nn[0], nn[1], nn[2]);
              col.push(rgb[0], rgb[1], rgb[2]);
            }
            quads++;
          }
          for (let l = 0; l < h; l++) for (let k = 0; k < w; k++) mask[n + k + l * dims[u]] = 0;
          i += w;
          n += w;
        }
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col), quads };
}


export function greedyMeshChunkOld(d: Dims, code: (i: number) => number, box: BBox, colorOf: (code: number) => [number, number, number]): MeshData {
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
