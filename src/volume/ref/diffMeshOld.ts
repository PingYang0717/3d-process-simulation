// 舊版差異網格（plan v12 §5.2 刪掉的 workerCore.diffMesh 的 changed 那一層）：留著當 diffLayer.test.ts 的對照。
// 整個陣列掃一遍、配 Uint16Array(N)、整個模型做一次 greedy mesh。
import { type MeshData, type Volume, greedyMesh } from '../volume';

const REMOVED = 255;

export function diffMeshOld(vol: Volume, orig: Uint8Array, diff: Uint8Array | null, hidden: Uint8Array, palette: Float32Array): MeshData {
  const { X, Y, Z, data } = vol;
  const N = X * Y * Z;
  const changed = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    const m = data[i];
    if (diff?.[i]) {
      if (m && !hidden[m]) changed[i] = m;
      else if (!m && orig[i] && !hidden[orig[i]]) changed[i] = REMOVED;
    }
  }
  const color = (code: number): [number, number, number] =>
    code === REMOVED ? [1, 77 / 255, 79 / 255] : [palette[code * 3], palette[code * 3 + 1], palette[code * 3 + 2]];
  return greedyMesh(X, Y, Z, changed, color);
}
