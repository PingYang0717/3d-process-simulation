// 即時預覽的網格（plan v9 §4.5，從 views.tsx 搬出的純函式；Worker 與主執行緒共用）：
// 裁切範圍外擴一圈鄰居做 greedy mesh，只留重心落在裁切範圍（含邊界面）裡的三角形，再搬回整個陣列的座標。
// 外圈鄰居之間的面與外圈最外面的面主網格本來就有，主網格同一範圍用 shader 挖掉、疊上這一塊。
import { type BBox, type MeshData, type Volume, DIFF_BIT, greedyMesh } from './volume';

/** 主網格挖洞與預覽三角形篩選共用的容差。 */
export const HOLE_EPS = 1e-3;

/**
 * vol：目前的整個陣列（外圈鄰居從這裡讀）；data：裁切範圍 box 裡的預覽結果；
 * hidden(m)：不畫這個材質；orig 有給就把和原始不同的格子標紅（代碼帶 DIFF_BIT）。
 */
export function previewMesh(
  vol: Volume,
  box: BBox,
  data: Uint8Array,
  hidden: (m: number) => boolean,
  colorOf: (code: number) => [number, number, number],
  orig: Uint8Array | null,
): MeshData {
  const b = box;
  const bx = b.x1 - b.x0 + 1;
  const by = b.y1 - b.y0 + 1;
  const bz = b.z1 - b.z0 + 1;
  const hx = bx + 2;
  const hy = by + 2;
  const hz = bz + 2;
  const codes = new Uint16Array(hx * hy * hz);
  for (let z = 0; z < hz; z++) {
    const vz = b.z0 - 1 + z;
    if (vz < 0 || vz >= vol.Z) continue;
    for (let y = 0; y < hy; y++) {
      const vy = b.y0 - 1 + y;
      if (vy < 0 || vy >= vol.Y) continue;
      for (let x = 0; x < hx; x++) {
        const vx = b.x0 - 1 + x;
        if (vx < 0 || vx >= vol.X) continue;
        const i = (vz * vol.Y + vy) * vol.X + vx;
        const inside = x >= 1 && x <= bx && y >= 1 && y <= by && z >= 1 && z <= bz;
        const m = inside ? data[((z - 1) * by + (y - 1)) * bx + (x - 1)] : vol.data[i];
        if (!m || hidden(m)) continue;
        codes[(z * hy + y) * hx + x] = orig && orig[i] !== m ? m | DIFF_BIT : m;
      }
    }
  }
  const m = greedyMesh(hx, hy, hz, codes, colorOf);
  // 只留重心落在裁切範圍（含邊界面）裡的三角形
  const P = m.positions;
  const lo = 1 - HOLE_EPS;
  const hiX = bx + 1 + HOLE_EPS;
  const hiY = by + 1 + HOLE_EPS;
  const hiZ = bz + 1 + HOLE_EPS;
  let n = 0;
  const keep = new Uint32Array(P.length / 9);
  for (let t = 0; t < P.length; t += 9) {
    const cx = (P[t] + P[t + 3] + P[t + 6]) / 3;
    const cy = (P[t + 1] + P[t + 4] + P[t + 7]) / 3;
    const cz = (P[t + 2] + P[t + 5] + P[t + 8]) / 3;
    if (cx >= lo && cx <= hiX && cy >= lo && cy <= hiY && cz >= lo && cz <= hiZ) keep[n++] = t;
  }
  const positions = new Float32Array(n * 9);
  const normals = new Float32Array(n * 9);
  const colors = new Float32Array(n * 9);
  const ox = b.x0 - 1;
  const oy = b.y0 - 1;
  const oz = b.z0 - 1;
  for (let k = 0; k < n; k++) {
    const t = keep[k];
    const o = k * 9;
    for (let j = 0; j < 9; j += 3) {
      positions[o + j] = P[t + j] + ox;
      positions[o + j + 1] = P[t + j + 1] + oy;
      positions[o + j + 2] = P[t + j + 2] + oz;
    }
    normals.set(m.normals.subarray(t, t + 9), o);
    colors.set(m.colors.subarray(t, t + 9), o);
  }
  return { positions, normals, colors, quads: n / 2 };
}
