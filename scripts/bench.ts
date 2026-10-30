// Worker 核心的速度（plan v7 §8.6）：一步操作「只在外框裡算＋relabel 吃外框＋重算碰到的 chunk」對照舊的整個陣列重播。
// 用法：npx vite-node scripts/bench.ts [scale ...]（預設 1 2 3）
import { MATERIALS, demoVolume, greedyMesh, initialLabeled } from '../src/volume/volume';
import { type EditState, type Op, applyOp, matNameOf } from '../src/volume/ops';
import { applyOpLocal } from '../src/volume/apply';
import { applyStep } from '../src/volume/patch';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from '../src/volume/chunks';

const matName = matNameOf(MATERIALS);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

for (const scale of (process.argv.slice(2).length ? process.argv.slice(2) : ['1', '2', '3']).map(Number)) {
  const vol = demoVolume(scale);
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  const poly = base.L.comps.find((c) => c.mat === 6)!;
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const ops: [string, Op][] = [
    ['poly 長高 1', { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' }],
    ['fin 方頭', { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [0, 0, 0], radius: null }, backfill: 'orig', follow: true }],
  ];
  console.log(`\n範例 ×${scale}：${vol.X}×${vol.Y}×${vol.Z}（${(vol.data.length / 1e6).toFixed(1)} M voxels）`);
  const codes = new Uint16Array(vol.data.length);
  for (let i = 0; i < codes.length; i++) codes[i] = vol.data[i];
  const color = (): [number, number, number] => [1, 1, 1];
  let t = performance.now();
  greedyMesh(vol.X, vol.Y, vol.Z, codes, color);
  console.log(`  整個陣列 greedy mesh：${ms(t)}`);
  const g = gridOf(vol);
  for (const [name, op] of ops) {
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    t = performance.now();
    applyOp(base, op, ctx);
    const old = ms(t);
    t = performance.now();
    const r = applyOpLocal(base, op, ctx);
    const local = ms(t);
    t = performance.now();
    applyStep(base, r.step, 'fwd');
    const main = ms(t);
    t = performance.now();
    const dirty = r.step.data ? chunksTouching(vol, g, r.step.data.box) : [];
    const next = r.state.vol.data;
    for (const k of dirty) greedyMeshChunk(vol, (i) => next[i], chunkBox(vol, g, k), color);
    console.log(`  ${name}：舊（整個陣列）${old}｜外框裡算＋relabel ${local}｜主執行緒貼補丁 ${main}｜重算 ${dirty.length}/${chunkCount(g)} 個 chunk ${ms(t)}`);
  }
}
