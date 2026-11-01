// 測試用：網格拆成單位面（軸、平面座標、u、v、朝向、顏色）的集合。chunk 切法、合併方式不同，單位面集合必須相同。
import type { MeshData } from './volume';

export function unitFaces(ms: MeshData[]): Set<string> {
  const out = new Set<string>();
  for (const m of ms) {
    const p = m.positions;
    for (let q = 0; q < p.length; q += 18) {
      const n = [m.normals[q], m.normals[q + 1], m.normals[q + 2]];
      const d = n[0] ? 0 : n[1] ? 1 : 2;
      const sign = n[d];
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 18; k += 3)
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], p[q + k + a]);
          hi[a] = Math.max(hi[a], p[q + k + a]);
        }
      const [u, v] = d === 0 ? [1, 2] : d === 1 ? [0, 2] : [0, 1];
      const col = `${m.colors[q].toFixed(3)},${m.colors[q + 1].toFixed(3)},${m.colors[q + 2].toFixed(3)}`;
      for (let a = lo[u]; a < hi[u]; a++) for (let b = lo[v]; b < hi[v]; b++) out.add(`${d}|${lo[d]}|${a}|${b}|${sign}|${col}`);
    }
  }
  return out;
}
