// Worker 核心的速度（plan v7 §8.6）：一步操作「只在外框裡算＋relabel 吃外框＋重算碰到的 chunk」對照舊的整個陣列重播。
// 用法：npx vite-node scripts/bench.ts [scale ...]（預設 1 2 3）
//       npx vite-node scripts/bench.ts drag [scale ...]：拖拉中每一幀主執行緒做的事（plan v8 §7.2、§8.4）
//       npx vite-node scripts/bench.ts step [scale ...]：一步的全流程（plan v9 §2）：Worker 原地 apply、主執行緒貼補丁、
//         chunk、整陣列複製位元組；mem [scale ...]：連做 50 步後的記憶體增量 vs 補丁總量
import { MATERIALS, demoVolume, greedyMesh, initialLabeled, unionBBox } from '../src/volume/volume';
import { type EditState, type Op, applyOp, matNameOf } from '../src/volume/ops';
import { applyOpLocal } from '../src/volume/apply';
import { applyStep } from '../src/volume/patch';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from '../src/volume/chunks';
import { previewOp } from '../src/volume/preview';
import { previewMesh } from '../src/volume/previewMesh';
import { type TracedHandle, ringCache } from '../src/slice/relative';
import { newReport } from '../src/volume/kernel';
import { ModelStore, ringsOf } from '../src/slice/model';
import { dragDispFloat } from '../src/slice/snap';
import { editRing } from '../src/slice/raster';
import { opOfGesture, sliceContext } from '../src/pages/Section3D/handleOps';

const matName = matNameOf(MATERIALS);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const args = process.argv.slice(2);
const mode = ['drag', 'step', 'mem', 'draw'].includes(args[0]) ? args[0] : 'old';
const dragMode = mode === 'drag';
const rest = mode === 'old' ? args : args.slice(1);
const scales = rest.length ? rest.map(Number) : [1, 2, 3];

// 整陣列複製計數器（只在 bench 開）：長度 ≥ minCopy 的 typed array .slice() 都算
let copied = 0;
let minCopy = Infinity;
for (const T of [Uint8Array, Int32Array, Float64Array, Float32Array, Uint16Array] as unknown as { prototype: { slice: (...a: number[]) => ArrayLike<number> & { byteLength: number } } }[]) {
  const orig = T.prototype.slice;
  T.prototype.slice = function (this: { length: number }, ...a: number[]) {
    const out = orig.apply(this, a);
    if (this.length >= minCopy) copied += out.byteLength;
    return out;
  } as typeof orig;
}
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

/** 一步的全流程（plan v9 §2）：Worker 原地 apply → 主執行緒原地貼補丁＋差量 diff → chunk（只回髒的）。 */
async function benchStep(scale: number, steps: number) {
  const core = await import('../src/volume/workerCore');
  const { applyStepInPlace, carryStepStats, stepBytes } = await import('../src/volume/patch');
  const vol = demoVolume(scale);
  const N = vol.data.length;
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  const hidden = new Uint8Array(256);
  const palette = new Float32Array(768).fill(0.5);
  const [ld] = core.handle('load', { sid: 1, vol }) as [{ labels: Int32Array; raw: unknown[] }, unknown];
  const L = initialLabeled(vol, matName);
  minCopy = N;
  copied = 0;
  // own：主執行緒與 Worker 各複製一次（唯一的整陣列複製）
  core.handle('fork', { owner: 's1', src: 'base', sid: 1 });
  const buf = { data: vol.data.slice(), labels: ld.labels.slice(), diff: new Uint8Array(N), diffCount: 0, counts: new Float64Array(256) };
  console.log(`\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M voxels）：own（主執行緒＋Worker 各一份）複製 ${mb(copied)}`);
  let comps = L.comps;
  const poly = comps.find((c) => c.mat === 6)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  let sid = 1;
  let shown = 1;
  core.handle('chunks', { sid, key: 'k', hidden, diff: true, palette });
  // 選取：基板（最大的結構）＋要長高的 poly；第一次是全量（∝ 選取大小）
  const sub = comps.reduce((a, c) => (c.count > a.count ? c : a));
  const selKeys = new Set([sub.key, poly.key]);
  let t0 = performance.now();
  const sel0 = comps.flatMap((c, i) => (selKeys.has(c.key) ? [i] : []));
  const [ly0] = core.handle('layer', { sid, key: 'sel', filter: { comps: sel0, scope: full, box: unionBBox(sel0.map((i) => comps[i]))! }, tint: [0, 0, 1], inflate: 0.02 }) as [{ items: unknown[] }, unknown];
  console.log(`  選到基板（${sub.label}，${(sub.count / 1e6).toFixed(1)} M 格）＋poly：選取層全量 ${ly0.items.length} 個 chunk ${(performance.now() - t0).toFixed(0)} ms`);
  let selShown = sid;
  const mem0 = process.memoryUsage();
  let patch = 0;
  const rows: string[] = [];
  for (let k = 0; k < steps; k++) {
    copied = 0;
    const op: Op = { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: k % 2 ? -1 : 1, follow: true, backfill: 'orig' };
    let t = performance.now();
    const [r] = core.handle('apply', { owner: 's1', from: sid, to: sid + 1, comps, op, matNames, keyCounter: 1000 + k * 10 }) as [{ step: import('../src/volume/patch').Step }, unknown];
    const tApply = performance.now() - t;
    if (!r.step.data) continue;
    sid++;
    t = performance.now();
    comps = applyStepInPlace(vol, buf.data, buf.labels, r.step, 'fwd') ?? comps;
    buf.diffCount = carryStepStats(vol, buf.data, vol.data, buf.diff, buf.diffCount, buf.counts, r.step, 'fwd');
    const tMain = performance.now() - t;
    t = performance.now();
    const [ch] = core.handle('chunks', { sid, key: 'k', hidden, diff: true, palette, base: shown }) as [{ items: unknown[] }, unknown];
    shown = sid;
    const tChunks = performance.now() - t;
    // 選取層（§4.6）：選了基板＋這根 poly，每一步只重算改到的 chunk
    t = performance.now();
    const selIdx = comps.flatMap((c, i) => (selKeys.has(c.key) ? [i] : []));
    const [ly] = core.handle('layer', { sid, key: 'sel', filter: { comps: selIdx, scope: full, box: unionBBox(selIdx.map((i) => comps[i]))! }, tint: [0, 0, 1], inflate: 0.02, base: selShown }) as [{ items: unknown[] }, unknown];
    selShown = sid;
    const tLayer = performance.now() - t;
    patch += stepBytes(r.step);
    if (k < 10)
      rows.push(
        `  第 ${k + 1} 步：Worker apply ${tApply.toFixed(0)} ms｜主執行緒貼補丁＋diff ${tMain.toFixed(1)} ms｜chunk ${ch.items.length} 個 ${tChunks.toFixed(0)} ms｜選取層 ${ly.items.length} 個 chunk ${tLayer.toFixed(0)} ms｜整陣列複製 ${mb(copied)}`,
      );
  }
  console.log(rows.join('\n'));
  const mem1 = process.memoryUsage();
  const grew = mem1.heapUsed + mem1.arrayBuffers - mem0.heapUsed - mem0.arrayBuffers;
  if (steps > 10) console.log(`  ${steps} 步後記憶體增量 ${mb(grew)}（補丁總量 ${mb(patch)}；目標 < 補丁 ＋ 20 MB；GC 時機不定，只供參考）`);
  minCopy = Infinity;
}

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
  const l2raw: number[] = [];
  const l2: number[] = [];
  const l2mesh: number[] = [];
  const cache = ringCache();
  const ringsFor = (key: string, tt: number, make: () => TracedHandle) => cache.get(`${key}|${tt}`, make);
  const color = (): [number, number, number] => [1, 1, 1];
  let box = 0;
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
    // 第 2 級（整個 scope，現在在 Worker）：每 6 幀量一次沒有快取的，每幀量有快取的＋預覽網格
    if (!op) continue;
    if (k % 6 === 0) {
      t = performance.now();
      previewOp(s, vol, op, Infinity, newReport());
      l2raw.push(performance.now() - t);
    }
    t = performance.now();
    const p2 = previewOp(s, vol, op, Infinity, newReport(), ringsFor)!;
    l2.push(performance.now() - t);
    box = Math.max(box, p2.data.length);
    t = performance.now();
    previewMesh(vol, p2.box, p2.data, () => false, color, null);
    l2mesh.push(performance.now() - t);
  }
  const q = (xs: number[], f: number) => (xs.sort((a, b) => a - b), xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]?.toFixed(1) ?? '-');
  console.log(`範例 ×${scale}（切面 ${vol.X}×${vol.Y}）：建立幾何層 ${build}｜主執行緒（第 1 級）每幀 中位數 ${q(frames, 0.5)} ms、p95 ${q(frames, 0.95)} ms、最大 ${q(frames, 1)} ms`);
  console.log(
    `  第 2 級（Worker，fin 整根 ${vol.Z} 片、外框最大 ${(box / 1e3).toFixed(0)} K 格）：沒有輪廓快取 中位數 ${q(l2raw, 0.5)} ms｜有快取 中位數 ${q(l2, 0.5)} ms、p95 ${q(l2, 0.95)} ms｜預覽網格 中位數 ${q(l2mesh, 0.5)} ms`,
  );
}

/** drawSlice（plan v9 P11）：LUT 版 vs 舊版（每像素 toVoxel／Map／Set、描邊每像素配陣列），三個軸各 20 次。 */
async function benchDraw(scale: number) {
  const { sliceRGBA, SEL_RGB } = await import('../src/pages/Section3D/drawSlice');
  const { hexToRgb, idx, maskOf } = await import('../src/volume/volume');
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const rgb = new Map(MATERIALS.map((m) => [m.id, hexToRgb(m.color)] as const));
  const sel = maskOf(L, new Set(L.comps.filter((c) => c.mat === 6).map((c) => c.key)))!;
  const diff = new Uint8Array(vol.data.length);
  for (let i = 0; i < diff.length; i += 3) diff[i] = 1;
  const hidden = new Set<number>([4]);
  const old = (axis: 'x' | 'y' | 'z', at: number) => {
    const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
    const toVoxel = (u: number, v: number): [number, number, number] => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]);
    const data = new Uint8ClampedArray(W * H * 4);
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        const [x, y, z] = toVoxel(u, v);
        const i = idx(vol, x, y, z);
        const m = vol.data[i];
        const c = hidden.has(m) ? [245, 245, 245] : (rgb.get(m) ?? [255, 0, 255]);
        const o = (v * W + u) * 4;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = 255;
        if (sel[i]) for (let k = 0; k < 3; k++) data[o + k] = (data[o + k] + SEL_RGB[k]) >> 1;
      }
    const on = (u: number, v: number) => {
      const [x, y, z] = toVoxel(u, v);
      return diff[idx(vol, x, y, z)];
    };
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++)
        if (on(u, v) && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([du, dv]) => u + du < 0 || v + dv < 0 || u + du >= W || v + dv >= H || !on(u + du, v + dv))) data.set([255, 77, 79, 255], (v * W + u) * 4);
    return data;
  };
  console.log(`\n範例 ×${scale}：`);
  // 點選一次的主執行緒掃描（plan v9 P10）：maskOf＋maskInScope（此片）＋slicesWith，整個陣列 vs 只掃選取外框
  {
    const { maskInScope, slicesWith } = await import('../src/pages/Section3D/editor');
    const { unionBBox } = await import('../src/volume/volume');
    for (const [name, comps] of [
      ['poly', L.comps.filter((c) => c.mat === 6).slice(0, 1)],
      ['基板', [L.comps.reduce((a, c) => (c.count > a.count ? c : a))]],
    ] as const) {
      const keys = new Set(comps.map((c) => c.key));
      const box = unionBBox([...comps]);
      const scope = { axis: 'z' as const, lo: vol.Z >> 1, hi: vol.Z >> 1 };
      let t = performance.now();
      const m0 = maskOf(L, keys)!;
      maskInScope(m0, vol, scope);
      slicesWith(m0, vol, 'z');
      const tFull = performance.now() - t;
      t = performance.now();
      const m1 = maskOf(L, keys, vol)!;
      maskInScope(m1, vol, scope, box);
      slicesWith(m1, vol, 'z', box);
      console.log(`  點選 ${name}：整個陣列掃 ${tFull.toFixed(0)} ms｜只掃外框 ${(performance.now() - t).toFixed(0)} ms`);
    }
  }
  for (const axis of ['z', 'y', 'x'] as const) {
    const at = axis === 'z' ? vol.Z >> 1 : axis === 'y' ? vol.Y >> 1 : vol.X >> 1;
    // 先跑幾次（JIT 暖機），再量；差異只在選取附近（實際情況），另量一次整片三分之一是差異的極端情況
    const sparse = new Uint8Array(vol.data.length);
    for (let i = 0; i < sel.length; i++) if (sel[i] && i % 5 === 0) sparse[i] = 1;
    for (let k = 0; k < 5; k++) (old(axis, at), sliceRGBA(vol, axis, at, rgb, hidden, sel, sparse, null));
    let t = performance.now();
    for (let k = 0; k < 20; k++) old(axis, at);
    const tOld = (performance.now() - t) / 20;
    t = performance.now();
    let n = 0;
    for (let k = 0; k < 20; k++) n = sliceRGBA(vol, axis, at, rgb, hidden, sel, sparse, null).data.length / 4;
    const tNew = (performance.now() - t) / 20;
    t = performance.now();
    for (let k = 0; k < 20; k++) sliceRGBA(vol, axis, at, rgb, hidden, sel, diff, null);
    const tDense = (performance.now() - t) / 20;
    console.log(`  ${axis} 切面（${n.toLocaleString()} 像素，選取＋差異描邊）：舊 ${tOld.toFixed(2)} ms｜LUT ${tNew.toFixed(2)} ms（三分之一是差異的極端情況 ${tDense.toFixed(2)} ms）`);
  }
}

if (mode === 'draw') for (const scale of scales) await benchDraw(scale);
else if (mode === 'step' || mode === 'mem') for (const scale of scales) await benchStep(scale, mode === 'mem' ? 50 : 10);
else if (dragMode) for (const scale of scales) benchDrag(scale);
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
