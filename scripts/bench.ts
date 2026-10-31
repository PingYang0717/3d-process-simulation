// Worker 核心的速度（plan v7 §8.6）：一步操作「只在外框裡算＋relabel 吃外框＋重算碰到的 chunk」對照舊的整個陣列重播。
// 用法：npx vite-node scripts/bench.ts [scale ...]（預設 1 2 3）
//       npx vite-node scripts/bench.ts drag [scale ...]：拖拉中每一幀主執行緒做的事（plan v8 §7.2、§8.4）
import { MATERIALS, demoVolume, greedyMesh, initialLabeled } from '../src/volume/volume';
import { type EditState, type Op, applyOp, matNameOf } from '../src/volume/ops';
import { applyOpLocal } from '../src/volume/apply';
import { applyStep } from '../src/volume/patch';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from '../src/volume/chunks';
import { previewOp } from '../src/volume/preview';
import { newReport } from '../src/volume/kernel';
import { ModelStore, ringsOf } from '../src/slice/model';
import { dragDispFloat } from '../src/slice/snap';
import { editRing } from '../src/slice/raster';
import { opOfGesture, sliceContext } from '../src/pages/Section3D/handleOps';

const matName = matNameOf(MATERIALS);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const args = process.argv.slice(2);
const dragMode = args[0] === 'drag';
const scales = (dragMode ? args.slice(1) : args).length ? (dragMode ? args.slice(1) : args).map(Number) : [1, 2, 3];

/**
 * 拖拉 60 幀（§7.2）：幾何層的環 → 浮點 ghost（dragDispFloat＋segmentPts）→ 手勢 → Op（snap、光柵化、BFS、RLE）
 * → 主切面單片預覽（previewOp 只算這一片）。印每幀的中位數與最大值；不含 three.js 與 React。
 */
function benchDrag(scale: number) {
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const s: EditState = { vol, L, version: 1 };
  const fin = L.comps.find((c) => c.mat === 3)!;
  const z = (fin.bbox.z0 + fin.bbox.z1) >> 1;
  const keys = [fin.key];
  const opts = { scope: { axis: 'z' as const, lo: 0, hi: vol.Z - 1 }, follow: true, backfill: 'orig' as const, nm: 0.5 };
  let t = performance.now();
  const store = new ModelStore();
  const m = store.get(L, vol, 'z', z, keys, 1).model;
  const rings = ringsOf(m, keys);
  const ctx = { ...sliceContext(L, vol, 'z', z, keys, opts, rings), model: m };
  const build = ms(t);
  const r = rings.get(fin.key)![0];
  let node = [...r.nodes][0];
  r.nodes.forEach((i) => {
    if (r.pts[i][0] - r.pts[i][1] > r.pts[node][0] - r.pts[node][1]) node = i;
  });
  const h = { kind: 'node' as const, key: fin.key, ring: 0, index: node };
  const frames: number[] = [];
  for (let k = 1; k <= 60; k++) {
    const delta: [number, number] = [(k * 3 * scale) / 60, -(k * 3 * scale) / 60];
    t = performance.now();
    editRing(r, dragDispFloat(r, h, delta));
    const { op } = opOfGesture(ctx, h, delta, false, false);
    if (op) {
      const one = { ...op, scope: { axis: 'z' as const, lo: z, hi: z } } as Op;
      previewOp(s, vol, one, 2_000_000, newReport());
    }
    frames.push(performance.now() - t);
  }
  frames.sort((a, b) => a - b);
  const p = (q: number) => frames[Math.min(frames.length - 1, Math.floor(q * frames.length))].toFixed(1);
  console.log(`範例 ×${scale}（切面 ${vol.X}×${vol.Y}）：建立幾何層 ${build}｜拖拉每幀 中位數 ${p(0.5)} ms、p95 ${p(0.95)} ms、最大 ${p(1)} ms`);
}

if (dragMode) for (const scale of scales) benchDrag(scale);
else for (const scale of scales) {
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
