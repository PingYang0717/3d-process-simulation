// Worker 核心的速度（plan v7 §8.6）：一步操作「只在外框裡算＋relabel 吃外框＋重算碰到的 chunk」對照舊的整個陣列重播。
// 用法：npx vite-node scripts/bench.ts [scale ...]（預設 1 2 3）
//       npx vite-node scripts/bench.ts drag [scale ...]：拖拉中每一幀主執行緒做的事（plan v8 §7.2、§8.4）；
//         另加 3D 圓角把手拖 Poly-Si 1（plan v14 §4）：主執行緒 roundOp、Worker 第 2 級，新範圍（結構那段）對照舊的整條軸
//       npx vite-node scripts/bench.ts step [scale ...]：一步的全流程（plan v9 §2）：Worker 原地 apply、主執行緒貼補丁、
//         chunk、整陣列複製位元組；mem [scale ...]：連做 50 步後的記憶體增量 vs 補丁總量
//       npx vite-node scripts/bench.ts diff [scale ...]：差異模式（plan v12 §5.2）舊 diffMesh（整個陣列）vs layer diff（只算 diff 外框碰到的 chunk）
//       npx vite-node scripts/bench.ts splits [scale ...]：產生 20 個 split（plan v12 §5.3）：Worker scratch 重播只回補丁的時間、補丁總量、
//         heap 增量（對照舊的每個 split 6N＋6N）、restore 一個的時間
//       plan v15（§3 每一列的量法；旗標可以疊加）。M15.0 量的是舊路徑當基線；M15.7 起量的是新路徑，舊路徑只留作逐位元組對照：
//       npx vite-node scripts/bench.ts step [scale ...] [--sel substrate] [--corners] [--op translate-substrate|push-fin|translate-fin]
//         每步多印：PS 快照位元組（relabelStats.snapshot × 4；括號裡是舊法＝apply 期間最大的一次 Int32 配置，兩者應相同）、move bytes、
//         主執行緒 diffBox＝diffBoxOfAxes（三條軸的 diff 直方圖，A2）ms 與對照 tightBox（掃整個 touch）ms、
//         復原堆疊累計位元組與 trimHist（HISTORY_BYTES 256 MB）截後的筆數／位元組（D1）；
//         --sel substrate＝選到基板時每步主執行緒的新路徑：第一步 maskOf 重建、之後 canPatchMask 通過就在 stepTouch 裡 patchMask（A1；
//         印 ms、配置位元組（應為 0）、重建次數），並和 maskOf＋maskInScope 全量逐位元組對照（不同就印錯誤）；
//         --corners＝先在基板相隔兩角各推一下（touch 撐到整個陣列）再量每步 diffBox；--op translate-substrate＝基板級 translate 連做（hist 位元組）
//       npx vite-node scripts/bench.ts mem [scale ...] [--op translate-substrate]：同 step，50 步
//       npx vite-node scripts/bench.ts drag2 [scale ...]：2D 拖基板頂邊 60 步（也跑 Poly 整層；「對應」開著）：每個 rAF 先算 gestureKey、和上一幀相同就沿用 Op
//         （B3，和 SliceEditor.tick 相同）；印每幀 ms（全部／真的算 Op 的幀）、算 Op 的次數／幀數、profileDelta 次數／幀數（包 raster.deltaOf 實際計數）、
//         位元組相同的 Op 重算比例；每步（沒碰這一片）ModelStore.get(touched=false) 的 ms 與 modelStats（traced／verified 應為 0）、sliceContext ms；
//         50 個版本後 ModelStore 實體快照位元組（store.bytes()）與指標數
//       npx vite-node scripts/bench.ts export [scale ...] [--whole]：合成壓縮比例陣列 .vti（8 個 Float32、zlib、appended raw、32 KB 一塊）：decodeVti ms、
//         encodeVtiLike(hint={diff, box, dims}) 改 2 萬格的 ms 與 ExportStats（重壓／總 block；C1）、--whole 再跑整陣列路徑對照位元組相同、
//         encodeVti（vti1）ms、ZipWriter（sink 收集）20 個 split 的 MB/s 與記憶體（C2；Node 裡 crc32 在呼叫端，頁面在 Worker）
//       npx vite-node scripts/bench.ts decode [scale ...]：同上只量解碼（readBlock 批次 inflate）
//       npx vite-node scripts/bench.ts overlay [scale] [n=200]：n 個 split 疊圖換片一次（overlayEntry＝contourOf 只描 keys 外框＋sliceDiff，進 contourCache）總 ms、
//         對照 contourOf 'full'；legend 滑過 60 次：頁面是 useMemo 命中（0 次重算），另印快取全命中重組 lines 的每次 ms
//       npx vite-node scripts/bench.ts thumbs [scale ...]：thumbRGBA 一張（sliceRGBA(crop) 共用裁切窗暫存）的 ms 與配置位元組
//       npx vite-node scripts/bench.ts layer void [scale ...]：Worker layer {mat: VOID}（X-ray；voidBoxOf＝帳簿 VOID 三軸直方圖的貼合外框）全量、增量、非相鄰版本的 ms
import { type BBox, MATERIALS, VOID, type Vec3, demoVolume, greedyMesh, initialLabeled, unionBBox } from '../src/volume/volume';
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
const mode = ['drag', 'step', 'mem', 'draw', 'diff', 'splits', 'drag2', 'export', 'decode', 'overlay', 'thumbs', 'layer'].includes(args[0]) ? args[0] : 'old';
const dragMode = mode === 'drag';
// plan v15 旗標：--sel substrate、--corners、--op translate-substrate；`layer void` 的 void 當子命令
const flags: Record<string, string | true> = {};
const rest: string[] = [];
for (let i = mode === 'old' ? 0 : 1; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const v = args[i + 1];
    if (v && !v.startsWith('--') && Number.isNaN(Number(v))) flags[a.slice(2)] = v, i++;
    else flags[a.slice(2)] = true;
  } else if (!(mode === 'layer' && a === 'void')) rest.push(a);
}
const scales = rest.length ? rest.map(Number) : [1, 2, 3];
const STEP_OPS = ['translate-substrate', 'push-fin', 'translate-fin'] as const;
const stepOpts = { sel: flags.sel === 'substrate', corners: flags.corners === true, op: (STEP_OPS as readonly string[]).includes(String(flags.op)) ? (flags.op as (typeof STEP_OPS)[number]) : null };

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
const q = (xs: number[], f: number, digits = 1) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))]?.toFixed(digits) ?? '-';
};

/**
 * typed array 配置計數器（plan v15 M15.0）：fn 期間把全域建構子換成會計數的 Proxy，連 prototype.constructor 也換掉
 * （volume.ts 的 cropBox、patch.ts 的 cropArr 走 `new (src.constructor)(n)`，relabel 的 PS 快照就是這樣配的）。
 * 只算真的配置（長度或來源陣列），不算 `new Uint8Array(buffer, …)` 的 view。src 不用加任何 hook。
 */
interface AllocLog {
  bytes: number;
  n: number;
  /** 每種型別最大的一次配置（PS 快照＝apply 期間最大的 Int32Array）。 */
  max: Record<string, number>;
  by: Record<string, number>;
  /** 每種型別配置了幾次（deltaOf 每次呼叫配兩個 Int8Array → profileDelta 次數）。 */
  cnt: Record<string, number>;
}
const ALLOC_CTORS = ['Uint8Array', 'Int8Array', 'Int32Array', 'Uint8ClampedArray', 'Float32Array', 'Float64Array', 'Uint16Array', 'Uint32Array'] as const;
function withAlloc<T>(fn: () => T): { out: T; log: AllocLog } {
  const log: AllocLog = { bytes: 0, n: 0, max: {}, by: {}, cnt: {} };
  const g = globalThis as unknown as Record<string, unknown>;
  const saved: [string, { prototype: object }, PropertyDescriptor | undefined][] = [];
  for (const name of ALLOC_CTORS) {
    const Orig = g[name] as { prototype: object } & (new (...a: unknown[]) => { byteLength: number });
    const proxy: unknown = new Proxy(Orig, {
      construct(target, a, newTarget) {
        const out = Reflect.construct(target, a, newTarget === proxy ? target : newTarget) as { byteLength: number };
        if (!(a[0] instanceof ArrayBuffer)) {
          log.bytes += out.byteLength;
          log.n++;
          log.by[name] = (log.by[name] ?? 0) + out.byteLength;
          log.max[name] = Math.max(log.max[name] ?? 0, out.byteLength);
          log.cnt[name] = (log.cnt[name] ?? 0) + 1;
        }
        return out;
      },
    });
    saved.push([name, Orig, Object.getOwnPropertyDescriptor(Orig.prototype, 'constructor')]);
    g[name] = proxy;
    Object.defineProperty(Orig.prototype, 'constructor', { value: proxy, writable: true, configurable: true });
  }
  try {
    return { out: fn(), log };
  } finally {
    for (const [name, Orig, d] of saved) {
      g[name] = Orig;
      if (d) Object.defineProperty(Orig.prototype, 'constructor', d);
    }
  }
}

/**
 * 一步的全流程（plan v9 §2）：Worker 原地 apply → 主執行緒原地貼補丁＋差量 diff → chunk（只回髒的）。
 * plan v15 M15.0 每步多量：PS 快照位元組（apply 期間最大的 Int32 配置＝relabelInPlace 的 cropBox(labels, Smax)）、move bytes、
 * 主執行緒 diffBox（tightBox 掃整個 touch）ms、復原堆疊累計位元組；旗標見檔頭。
 */
async function benchStep(scale: number, steps: number, o = stepOpts) {
  const core = await import('../src/volume/workerCore');
  const { applyStepInPlace, carryStepStats, stepBytes, tightBox, unionBox, boxSize, newAxes, diffBoxOfAxes } = await import('../src/volume/patch');
  const { stepTouch } = await import('../src/splits/lifecycle');
  const { maskOf, patchMask, relabelStats } = await import('../src/volume/volume');
  const { maskInScope, canPatchMask, trimHist, HISTORY_BYTES } = await import('../src/pages/Section3D/editor');
  type HistEntry = import('../src/pages/Section3D/editor').HistEntry;
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
  // axes（A2）：和 diff 一起差量維護的三軸直方圖，diffBox 從它 O(X+Y+Z) 取
  const buf = { data: vol.data.slice(), labels: ld.labels.slice(), diff: new Uint8Array(N), diffCount: 0, counts: new Float64Array(256), touch: null as BBox | null, axes: newAxes(vol) };
  console.log(`\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M voxels）：own（主執行緒＋Worker 各一份）複製 ${mb(copied)}${o.sel ? '｜--sel substrate' : ''}${o.corners ? '｜--corners' : ''}${o.op ? `｜--op ${o.op}` : ''}`);
  let comps = L.comps;
  const poly = comps.find((c) => c.mat === 6)!;
  const fin = comps.find((c) => c.mat === 3)!;
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
  let hist = 0;
  /** 復原堆疊（D1）：每步 push 一筆，trimHist 依筆數與 HISTORY_BYTES 截；被截掉的筆 GC 回收，和 editor.ts 相同。 */
  let histEntries: HistEntry[] = [];
  let histDropped = 0;
  const rows: string[] = [];
  type Step = import('../src/volume/patch').Step;
  /** 一步：Worker apply（PS 快照＝relabelStats.snapshot；舊法 Int32 配置計數留作對照）→ 主執行緒貼補丁＋diff＋axes＋touch。 */
  const doStep = (op: Op, k: number) => {
    let t = performance.now();
    relabelStats.snapshot = 0;
    const { out, log } = withAlloc(() => core.handle('apply', { owner: 's1', from: sid, to: sid + 1, comps, op, matNames, keyCounter: 1000 + k * 10 }) as [{ step: Step }, unknown]);
    const tApply = performance.now() - t;
    const [r] = out;
    if (!r.step.data) return null;
    sid++;
    const prevComps = comps;
    t = performance.now();
    comps = applyStepInPlace(vol, buf.data, buf.labels, r.step, 'fwd') ?? comps;
    buf.diffCount = carryStepStats(vol, buf.data, vol.data, buf.diff, buf.diffCount, buf.counts, r.step, 'fwd', buf.axes);
    const touch = stepTouch(r.step);
    buf.touch = unionBox(buf.touch, touch);
    const tMain = performance.now() - t;
    return { step: r.step, tApply, tMain, ps: relabelStats.snapshot * 4, psOld: log.max.Int32Array ?? 0, prevComps, touch };
  };
  const subTop = sub.bbox.y0;
  if (o.corners) {
    // 相隔兩角各推一下（基板頂面的角落、筆刷 3 格）：touch 撐到整個 X×Z，之後每步 diffBox 都掃整個 touch
    for (const [name, center] of [
      ['左前角', [1, subTop, 1]],
      ['右後角', [vol.X - 2, subTop, vol.Z - 2]],
    ] as const) {
      const op: Op = { kind: 'push', keys: [sub.key], scope: full, dir: [0, -1, 0], n: 1, follow: false, backfill: 'orig', local: { center: [...center] as Vec3, radius: 3 * scale, shape: 'square' } };
      const r = doStep(op, 100 + name.length);
      const tb = r && r.step.data ? r.step.data.box : null;
      console.log(`  --corners ${name}：${r ? `Worker apply ${r.tApply.toFixed(0)} ms、補丁外框 ${tb ? `${tb.x1 - tb.x0 + 1}×${tb.y1 - tb.y0 + 1}×${tb.z1 - tb.z0 + 1}` : '-'}` : '沒改到'}`);
    }
    const tc = buf.touch!;
    console.log(`  --corners 之後 touch ＝ ${tc.x1 - tc.x0 + 1}×${tc.y1 - tc.y0 + 1}×${tc.z1 - tc.z0 + 1}（${(boxSize(tc) / 1e6).toFixed(1)} M 格，整個陣列的 ${((boxSize(tc) / N) * 100).toFixed(0)}%）`);
  }
  const selSet = new Set([sub.key]);
  const sliceScope = { axis: 'z' as const, lo: vol.Z >> 1, hi: vol.Z >> 1 };
  // A1 新路徑的狀態：同一個選取裡 mask／aff 陣列身分不變（和 useSelMasks 的 ref 相同）
  const plane = vol.X * vol.Y;
  const inScope = (i: number) => {
    const z = Math.floor(i / plane);
    return z >= sliceScope.lo && z <= sliceScope.hi;
  };
  const sameBytes = (a: Uint8Array, b: Uint8Array) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  let selMask: Uint8Array | null = null;
  let affMask: Uint8Array | null = null;
  let selRebuilds = 0;
  let selMismatch = 0;
  const selMs: number[] = [];
  const selOldMs: number[] = [];
  const diffMs: number[] = [];
  const diffOldMs: number[] = [];
  let diffMismatch = 0;
  const psList: number[] = [];
  const mvList: number[] = [];
  for (let k = 0; k < steps; k++) {
    copied = 0;
    // 預設 poly 長高／縮 1；--op translate-substrate＝基板整塊左右搬 1（復原堆疊一筆最大）；push-fin＝fin 長高 1；
    // translate-fin＝fin 左右搬 1（R±1 碰到基板 → relabel 的 Smax 把整個基板 bbox 包進來）
    const op: Op =
      o.op === 'translate-substrate'
        ? { kind: 'translate', keys: [sub.key], scope: full, d: [k % 2 ? -1 : 1, 0, 0], backfill: 'orig' }
        : o.op === 'push-fin'
          ? { kind: 'push', keys: [fin.key], scope: full, dir: [0, -1, 0], n: k % 2 ? -1 : 1, follow: true, backfill: 'orig' }
          : o.op === 'translate-fin'
            ? { kind: 'translate', keys: [fin.key], scope: full, d: [k % 2 ? -1 : 1, 0, 0], backfill: 'orig', follow: true }
            : { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: k % 2 ? -1 : 1, follow: true, backfill: 'orig' };
    const r = doStep(op, k);
    if (!r) continue;
    let t = performance.now();
    const [ch] = core.handle('chunks', { sid, key: 'k', hidden, diff: true, palette, base: shown }) as [{ items: unknown[] }, unknown];
    shown = sid;
    const tChunks = performance.now() - t;
    // 選取層（§4.6）：選了基板＋這根 poly，每一步只重算改到的 chunk
    t = performance.now();
    const selIdx = comps.flatMap((c, i) => (selKeys.has(c.key) ? [i] : []));
    const [ly] = core.handle('layer', { sid, key: 'sel', filter: { comps: selIdx, scope: full, box: unionBBox(selIdx.map((i) => comps[i]))! }, tint: [0, 0, 1], inflate: 0.02, base: selShown }) as [{ items: unknown[] }, unknown];
    selShown = sid;
    const tLayer = performance.now() - t;
    // A2：主執行緒每步 statsOf → buffersStats → diffBoxOfAxes（O(X+Y+Z)）；對照 tightBox 掃整個累積的 touch
    t = performance.now();
    const dbNew = diffBoxOfAxes(buf.axes);
    const tDiff = performance.now() - t;
    diffMs.push(tDiff);
    t = performance.now();
    const dbOld = tightBox(vol, buf.diff, buf.touch);
    const tDiffOld = performance.now() - t;
    diffOldMs.push(tDiffOld);
    if (JSON.stringify(dbNew) !== JSON.stringify(dbOld)) {
      diffMismatch++;
      console.error(`  錯誤：第 ${k + 1} 步 diffBoxOfAxes ${JSON.stringify(dbNew)} ≠ tightBox ${JSON.stringify(dbOld)}`);
    }
    // A1：選到基板時每步 selMask／affMask 的原地維護：第一步 maskOf 重建；之後 canPatchMask 通過就只在 stepTouch 裡 patchMask（配置 0）；
    // 對照 maskOf＋maskInScope 全量逐位元組相同
    let selCol = '';
    if (o.sel) {
      const L2 = { labels: buf.labels, comps };
      const box = unionBBox(comps.filter((c) => selSet.has(c.key)));
      const on = new Uint8Array(comps.length);
      comps.forEach((c, i) => {
        if (selSet.has(c.key)) on[i] = 1;
      });
      let how: string;
      t = performance.now();
      let a: { log: AllocLog };
      if (selMask && affMask && r.touch && canPatchMask(r.prevComps, comps, selSet, r.touch)) {
        const m = selMask;
        const f = affMask;
        const bx = r.touch;
        a = withAlloc(() => {
          patchMask(m, buf.labels, on, vol, bx);
          patchMask(f, buf.labels, on, vol, bx, inScope);
        });
        how = `patchMask(${bx.x1 - bx.x0 + 1}×${bx.y1 - bx.y0 + 1}×${bx.z1 - bx.z0 + 1})`;
      } else {
        a = withAlloc(() => {
          selMask = maskOf(L2, selSet, vol)!;
          affMask = maskInScope(selMask, vol, sliceScope, box);
        });
        selRebuilds++;
        how = selMask ? '重建（maskOf＋maskInScope）' : '重建';
      }
      const tNew = performance.now() - t;
      selMs.push(tNew);
      // 對照（舊路徑；不計入）
      t = performance.now();
      const wantMask = maskOf(L2, selSet, vol)!;
      const wantAff = maskInScope(wantMask, vol, sliceScope, box);
      const tOld = performance.now() - t;
      selOldMs.push(tOld);
      if (!sameBytes(wantMask, selMask!) || !sameBytes(wantAff, affMask!)) {
        selMismatch++;
        console.error(`  錯誤：第 ${k + 1} 步 selMask／affMask 原地維護和 maskOf 全量不同`);
      }
      selCol = `｜selMask＋affMask ${how} ${tNew.toFixed(2)} ms（配 ${mb(a.log.bytes)}；對照全量 ${tOld.toFixed(1)} ms）`;
    }
    const sb = stepBytes(r.step);
    patch += sb;
    hist += sb;
    histEntries.push({ step: r.step, ops: [op], version: sid });
    const trimmed = trimHist(histEntries, HISTORY_BYTES);
    histEntries = trimmed.hist;
    histDropped += trimmed.dropped;
    const histKept = histEntries.reduce((s, h) => s + stepBytes(h.step), 0);
    const mv = r.step.labels?.moves.reduce((s, m) => s + boxSize(m.box) * 4, 0) ?? 0;
    psList.push(r.ps);
    mvList.push(mv);
    const tc = buf.touch!;
    if (k < 10)
      rows.push(
        `  第 ${k + 1} 步：Worker apply ${r.tApply.toFixed(0)} ms｜主執行緒貼補丁＋diff＋axes ${r.tMain.toFixed(1)} ms｜chunk ${ch.items.length} 個 ${tChunks.toFixed(0)} ms｜選取層 ${ly.items.length} 個 chunk ${tLayer.toFixed(0)} ms｜整陣列複製 ${mb(copied)}` +
          `\n      PS 快照 ${mb(r.ps)}（舊法 Int32 配置 ${mb(r.psOld)}；S 的 before ${mb(r.step.labels?.before.byteLength ?? 0)}）｜move ${mb(mv)}｜diffBox(axes) ${tDiff.toFixed(2)} ms（對照 tightBox ${tDiffOld.toFixed(1)} ms，touch ${(boxSize(tc) / 1e6).toFixed(1)} M 格）｜hist 累計 ${mb(hist)}、截後 ${histEntries.length} 筆 ${mb(histKept)}${selCol}`,
      );
  }
  console.log(rows.join('\n'));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const histKept = histEntries.reduce((s, h) => s + stepBytes(h.step), 0);
  console.log(
    `  小結：PS 快照 平均 ${mb(avg(psList))}、最大 ${mb(Math.max(0, ...psList))}｜move 平均 ${mb(avg(mvList))}｜diffBox(axes) 中位數 ${q(diffMs, 0.5, 2)} ms、最大 ${q(diffMs, 1, 2)} ms（對照 tightBox 中位數 ${q(diffOldMs, 0.5)}、最大 ${q(diffOldMs, 1)}；不同 ${diffMismatch} 次）` +
      (o.sel ? `｜selMask＋affMask 中位數 ${q(selMs, 0.5, 2)} ms、最大 ${q(selMs, 1, 2)} ms（重建 ${selRebuilds}／${selMs.length} 步；對照全量中位數 ${q(selOldMs, 0.5)} ms；不同 ${selMismatch} 次）` : '') +
      `｜復原堆疊 ${steps} 步累計 ${mb(hist)}（每筆平均 ${mb(hist / Math.max(1, steps))}），trimHist 截後 ${histEntries.length} 筆 ${mb(histKept)}（丟 ${histDropped} 筆；上限 ${mb(HISTORY_BYTES)}）`,
  );
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

/**
 * 3D 圓角把手拖 Poly-Si 1（plan v14）：半徑 1→16 每一步＝一幀。主執行緒＝roundOp（參考片的 roundCells＋RLE）；
 * Worker＝previewOp（上限 40 萬格，超過回 null＝3D 沒有預覽）。範圍：新（選取外框沿 x）vs 舊（整條 x）。
 */
async function benchDragRound(scale: number) {
  const { roundOp } = await import('../src/slice/round');
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const s: EditState = { vol, L, version: 1 };
  const poly = L.comps.find((c) => c.label === 'Poly-Si 1') ?? L.comps.find((c) => c.mat === 6)!;
  const b = poly.bbox;
  const at = (b.x0 + b.x1) >> 1;
  const CAP = 400_000;
  for (const [name, scope] of [
    ['新：結構那段', { axis: 'x' as const, lo: b.x0, hi: b.x1 }],
    ['舊：整條 x', { axis: 'x' as const, lo: 0, hi: vol.X - 1 }],
  ] as const) {
    const main: number[] = [];
    const worker: number[] = [];
    let none = 0;
    for (let r = 1; r <= 16; r++) {
      let t = performance.now();
      const op = roundOp(L, vol, [poly.key], scope, at, { kind: 'round', corners: [{ id: 'ul' }], r, n: 2, mode: 'match' }, false, 'orig', 0.5);
      main.push(performance.now() - t);
      if (!op) continue;
      t = performance.now();
      const p = previewOp(s, vol, op, CAP, newReport());
      if (!p) none++;
      worker.push(performance.now() - t);
    }
    const q = (xs: number[], f: number) => (xs.sort((a, c) => a - c), xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]?.toFixed(1) ?? '-');
    console.log(`  圓角把手 Poly-Si 1（${name}）：主執行緒每幀 中位數 ${q(main, 0.5)} ms、最大 ${q(main, 1)} ms｜Worker 每幀 中位數 ${q(worker, 0.5)} ms、最大 ${q(worker, 1)} ms｜超過即時上限 ${none}／${worker.length} 幀`);
  }
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

/** 差異模式（plan v12 §5.2）：舊 diffMesh（兩份 Uint16Array(N)、整個模型 greedy mesh 兩次）vs layer diff（diff 外框碰到的 chunk）。 */
async function benchDiff(scale: number) {
  const core = await import('../src/volume/workerCore');
  const { diffMeshOld } = await import('../src/volume/ref/diffMeshOld');
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  core.handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
  const poly = L.comps.find((c) => c.label === 'Poly-Si 3')!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const ops: Op[] = [{ kind: 'translate', keys: [poly.key], scope: full, d: [0, 0, 2], backfill: 'orig' }];
  core.handle('replay', { owner: 's1', src: 'base', from: 1, to: 2, comps: L.comps, ops, matNames, keyCounter: 1000 });
  const b = core.inspect().books.get('s1')!;
  const o = core.inspect().books.get('base')!;
  const hidden = new Uint8Array(256);
  const pal = new Float32Array(768).fill(0.5);
  let t = performance.now();
  const old = diffMeshOld({ ...vol, data: b.data }, o.data, b.diff, hidden, pal);
  // 舊版還有一層整個模型的 ghost
  const codes = new Uint16Array(vol.data.length);
  for (let i = 0; i < codes.length; i++) if (b.data[i] && !b.diff![i]) codes[i] = 1;
  greedyMesh(vol.X, vol.Y, vol.Z, codes, () => [0.7, 0.7, 0.7]);
  const tOld = ms(t);
  t = performance.now();
  const r = core.handle('layer', { sid: 2, key: 'd', filter: { diff: true }, tint: [1, 0, 0], palette: pal, hidden })[0] as { items: { m: { quads: number } }[] };
  const tNew = ms(t);
  console.log(`\n範例 ×${scale}（${(vol.data.length / 1e6).toFixed(1)} M voxels）差異模式：舊 diffMesh＋ghost ${tOld}（暫存 ${mb(vol.data.length * 4)}）｜layer diff ${tNew}（${r.items.length} 個 chunk、${r.items.reduce((s, it) => s + it.m.quads, 0)} quads；舊 ${old.quads}）`);
}

/** 產生 20 個 split（plan v12 §5.3）：Worker scratch 重播只回補丁；對照舊的每個 split 主執行緒＋Worker 各 6N。 */
async function benchSplits(scale: number) {
  const core = await import('../src/volume/workerCore');
  const { patchBytes, restoreBuffers } = await import('../src/splits/lifecycle');
  const vol = demoVolume(scale);
  const N = vol.data.length;
  const L = initialLabeled(vol, matName);
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  const [ld] = core.handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } }) as [{ labels: Int32Array; counts: Float64Array }, unknown];
  const poly = L.comps.find((c) => c.label === 'Poly-Si 2')!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const t = performance.now();
  const pats = [];
  for (let k = 1; k <= 20; k++) {
    const ops: Op[] = [{ kind: 'translate', keys: [poly.key], scope: full, d: [0, 0, k % 2 ? k : -k], backfill: 'orig' }];
    pats.push((core.handle('replayPatch', { src: 'base', from: 1, comps: L.comps, ops, matNames, keyCounter: 1000 })[0] as { patch: Parameters<typeof patchBytes>[0] }).patch);
  }
  const tGen = ms(t);
  (globalThis as { gc?: () => void }).gc?.();
  const h1 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
  const bytes = pats.reduce((s, p) => s + patchBytes(p), 0);
  const t2 = performance.now();
  core.handle('restore', { owner: 'r', sid: 99, patch: pats[0]! });
  restoreBuffers(vol, vol.data, ld.labels, ld.counts, pats[0]!);
  console.log(
    `\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M voxels）產生 20 個 split：${tGen}；補丁共 ${mb(bytes)}（scratch 帳簿 ${mb(N * 6)} 一份）；` +
      `記憶體增量 ${mb(h1 - h0)}（舊：主執行緒＋Worker 各 6N × 20 ＝ ${mb(N * 12 * 20)}）｜restore 一個（Worker＋主執行緒）${ms(t2)}`,
  );
}

// ---- plan v15 M15.0：§3 的量法 ----

/**
 * 2D 拖基板頂邊 60 步（plan v15 B3、A4）：和 SliceEditor.tick() 每個 rAF 做的事相同——opOfGesture（「對應」開著 → mirroredOp）
 * → 第 1 級 previewOp（主切面這一片）；第 2 級（Worker）另外量。也跑 Poly 整層（Poly-Si 1 橫跨整片）的頂邊。
 * 每步（A4）：stairs（每個已選 key 的 boundaryLoops）、ModelStore.get 的 verifyKey（版本變了就每個 key 驗證一次，就算這一步沒碰這一片）、
 * sliceContext（每個 key 掃 bbox 算 area）；50 個版本後估 ModelStore 快照位元組。
 */
async function benchDrag2(scale: number) {
  const { boundaryLoops } = await import('../src/slice/trace');
  const { sliceOfKey, modelStats } = await import('../src/slice/model');
  const { gestureKey } = await import('../src/slice/gestures');
  // profileDelta 次數＝raster.deltaOf 真的被叫幾次：vite-node 的模組命名空間是 configurable getter，gestures.ts 每次呼叫都經它讀，所以可以包起來計數
  const raster = await import('../src/slice/raster');
  let deltaCalls = 0;
  {
    const orig = raster.deltaOf;
    Object.defineProperty(raster, 'deltaOf', { configurable: true, get: () => (...a: Parameters<typeof orig>) => (deltaCalls++, orig(...a)) });
  }
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const s: EditState = { vol, L, version: 1 };
  const sub = L.comps.reduce((a, c) => (c.count > a.count ? c : a));
  const sti = L.comps.find((c) => c.mat === 2)!;
  const poly = L.comps.find((c) => c.label === 'Poly-Si 1') ?? L.comps.find((c) => c.mat === 6)!;
  const fins = L.comps.filter((c) => c.mat === 3);
  const z = (poly.bbox.z0 + poly.bbox.z1) >> 1;
  const opts = { scope: { axis: 'z' as const, lo: 0, hi: vol.Z - 1 }, follow: true, backfill: 'orig' as const, nm: 0.5 };
  console.log(`\n範例 ×${scale}（切面 ${vol.X}×${vol.Y}，z = ${z}）：`);
  type SliceModel = import('../src/slice/model').SliceModel;
  /** ModelStore 快照位元組（估計：XY 32 B、頂點 64 B、id 16 B、Map／Set 項 32 B）。 */
  const modelBytes = (m: SliceModel) =>
    Object.keys(m.vertices).length * 64 +
    m.rings.reduce((t, r) => t + r.loop.length * 16, 0) +
    [...m.exact.values()].reduce((t, v) => t + v.length * 32 + 64, 0) +
    (m.handles.size + m.removed.size + m.custom.size + m.edited.size) * 32 +
    Object.keys(m.origin).length * 80;
  for (const [name, key, selKeys] of [
    ['基板頂邊', sub.key, [sub.key, sti.key, ...fins.map((c) => c.key)]],
    ['Poly 整層頂邊', poly.key, [poly.key, sti.key, ...fins.map((c) => c.key)]],
  ] as const) {
    const store = new ModelStore();
    let t = performance.now();
    const m = store.get(L, vol, 'z', z, [...selKeys], 1).model;
    const rings = ringsOf(m, [...selKeys]);
    const ctx = { ...sliceContext(L, vol, 'z', z, [...selKeys], opts, rings), model: m };
    const build = ms(t);
    const r = rings.get(key)![0];
    // 頂邊：v 最小的那條水平邊（最長的）
    let edge = -1;
    let best = -Infinity;
    const vmin = Math.min(...r.pts.map((p) => p[1]));
    for (let i = 0; i < r.pts.length; i++) {
      const a = r.pts[i];
      const b = r.pts[(i + 1) % r.pts.length];
      if (a[1] === vmin && b[1] === vmin && Math.abs(a[0] - b[0]) > best) (best = Math.abs(a[0] - b[0])), (edge = i);
    }
    console.log(`  ${name}（已選 ${selKeys.length} 個，對應開著）：建立幾何層 ${build}`);
    // 兩種把手：整條頂邊（軸向、最外側、橫跨整個結構 → gestureToOp 早退成 push）；頂邊左端的角節點（→ profileDelta：掃 key 所有環的聯集 bbox、rasterize、BFS ×2、RLE）
    for (const [hname, h, diag] of [
      ['拖頂邊（→ push）', { kind: 'edge' as const, key, ring: 0, index: edge }, false],
      ['拖頂邊左端角節點（→ profile）', { kind: 'node' as const, key, ring: 0, index: edge }, true],
    ] as const) {
      const frames: number[] = [];
      const calcFrames: number[] = [];
      const opMs: number[] = [];
      const l2: number[] = [];
      const kinds = new Map<string, number>();
      const seen = new Set<string>();
      let same = 0;
      let none = 0;
      let computed = 0;
      let lastKey = '';
      let last: ReturnType<typeof opOfGesture> = { op: null, missed: [] };
      deltaCalls = 0;
      const cache = ringCache();
      const ringsFor = (k: string, tt: number, make: () => TracedHandle) => cache.get(`${k}|${tt}`, make);
      for (let k = 1; k <= 60; k++) {
        const delta: [number, number] = [diag ? (k * 3 * scale) / 60 : 0, -(k * 3 * scale) / 60];
        t = performance.now();
        // B3：先算 gestureKey；和上一幀相同就沿用 Op，不重算、也不再送第 1 級／Worker 預覽（SliceEditor.tick 的規則；'' 不去重）
        const gk = gestureKey(ctx.rings, h, delta, false);
        const key = gk ? `10|${gk}` : '';
        const fresh = !key || key !== lastKey;
        let tOp = 0;
        if (fresh) {
          const t1 = performance.now();
          last = opOfGesture(ctx, h, delta, false, true);
          tOp = performance.now() - t1;
          lastKey = key;
          computed++;
          const op = last.op;
          if (op) {
            const one = { ...op, scope: { axis: 'z' as const, lo: z, hi: z } } as Op;
            previewOp(s, vol, one, 2_000_000, newReport());
          } else none++;
        }
        const dt = performance.now() - t;
        frames.push(dt);
        if (fresh) {
          calcFrames.push(dt);
          opMs.push(tOp);
        }
        const op = last.op;
        if (fresh && op) {
          const j = JSON.stringify(op);
          if (seen.has(j)) same++;
          seen.add(j);
          kinds.set(op.kind, (kinds.get(op.kind) ?? 0) + 1);
          t = performance.now();
          previewOp(s, vol, op, Infinity, newReport(), ringsFor);
          l2.push(performance.now() - t);
        }
      }
      const withOp = computed - none;
      console.log(
        `    ${hname}：主執行緒每幀（gestureKey＋沒去重掉的 opOfGesture＋第 1 級）全部 60 幀 中位數 ${q(frames, 0.5)} ms、p95 ${q(frames, 0.95)} ms、最大 ${q(frames, 1)} ms` +
          `｜真的算 Op 的 ${computed} 幀 中位數 ${q(calcFrames, 0.5)} ms、p95 ${q(calcFrames, 0.95)} ms｜opOfGesture 本身 中位數 ${q(opMs, 0.5)} ms、最大 ${q(opMs, 1)} ms`,
      );
      console.log(
        `      算 Op 的次數／幀數 ${(computed / 60).toFixed(2)}（gestureKey 去重）｜profileDelta 次數／幀數 ${(deltaCalls / 60).toFixed(2)}（deltaOf 實際 ${deltaCalls} 次）｜Op 種類 ${[...kinds].map(([k, n]) => `${k}×${n}`).join('、') || '無'}` +
          `｜位元組相同的 Op 重算 ${same}／${withOp} 次（${((withOp ? same / withOp : 0) * 100).toFixed(0)}%）｜第 2 級（Worker）中位數 ${q(l2, 0.5)} ms（只在 Op 變了才送）`,
      );
    }
    // A4：每步（版本變了、這一步沒碰這一片）：useSliceRev 算出 touched=false → stairs／rings 的 memo 不重算（0 次），
    // ModelStore.get(touched=false) 只把版本號接上、不 verify；sliceContext 仍每步重建但 area 是 lazy getter（不再掃 bbox）
    const stairsMs: number[] = [];
    const getMs: number[] = [];
    const sctxMs: number[] = [];
    let version = 1;
    let traced = 0;
    let verified = 0;
    let loops = 0;
    for (let step = 1; step <= 5; step++) {
      version++;
      // 對照：stairs 若照舊每步重描要多少（頁面在 touched=false 時不跑這段）
      t = performance.now();
      loops = 0;
      for (const k of selKeys) {
        const sl = sliceOfKey(L, vol, 'z', z, k);
        if (sl) loops += boundaryLoops((u, v) => u >= sl.u0 && v >= sl.v0 && u <= sl.u1 && v <= sl.v1 && sl.inside(u, v), sl.u0, sl.v0, sl.u1, sl.v1).length;
      }
      stairsMs.push(performance.now() - t);
      const ms0 = { ...modelStats };
      t = performance.now();
      const got = store.get(L, vol, 'z', z, [...selKeys], version, step, false);
      getMs.push(performance.now() - t);
      traced += modelStats.traced - ms0.traced;
      verified += modelStats.verified - ms0.verified;
      t = performance.now();
      sliceContext(L, vol, 'z', z, [...selKeys], opts, ringsOf(got.model, [...selKeys]));
      sctxMs.push(performance.now() - t);
    }
    console.log(
      `    每步（沒碰這一片，${selKeys.length} 個 key）：stairs 0 次（memo 看 rev；照舊重描 ${loops} 條迴圈會是 ${q(stairsMs, 0.5)} ms）｜ModelStore.get(touched=false) 中位數 ${q(getMs, 0.5)} ms、5 步 traced ${traced}、verified ${verified}｜sliceContext（area lazy）中位數 ${q(sctxMs, 0.5)} ms`,
    );
    for (; version < 50; ) store.get(L, vol, 'z', z, [...selKeys], ++version, version, true);
    const snaps = (store as unknown as { snaps: Map<string, SliceModel> }).snaps;
    let est = 0;
    for (const sm of snaps.values()) if (sm.rings) est += modelBytes(sm);
    const cnt = store.counts();
    console.log(`    50 個版本後 ModelStore：store.bytes() ${mb(store.bytes())}（實體 ${cnt.entities} 份、指標 ${cnt.aliases} 份；舊估法 ${mb(est)}；SNAP_LIMIT ${ModelStore.SNAP_LIMIT}）`);
  }
}
/**
 * 合成壓縮比例陣列 .vti（plan v15 C1、C4）：PointData 8 個 Float32（material_1～7、material_254），zlib、appended raw、
 * header UInt32、32 KB 一塊（VTK 預設）。值＝demoVolume 的材質 one-hot。回傳位元組與每個陣列的 block 數。
 */
async function synthVti(vol: Volume) {
  const zlib = await import('node:zlib');
  const ids = [1, 2, 3, 4, 5, 6, 7, VOID];
  const N = vol.data.length;
  const BS = 32768;
  const enc = new TextEncoder();
  const u32 = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
  const app: Uint8Array[] = [];
  const tags: string[] = [];
  let off = 0;
  let blocks = 0;
  for (const id of ids) {
    const f = new Float32Array(N);
    for (let i = 0; i < N; i++) if (vol.data[i] === id) f[i] = 1;
    const raw = new Uint8Array(f.buffer);
    const nb = Math.ceil(raw.length / BS);
    const parts: Uint8Array[] = [];
    for (let k = 0; k < nb; k++) parts.push(new Uint8Array(zlib.deflateSync(raw.subarray(k * BS, Math.min(raw.length, (k + 1) * BS)))));
    const head = u32(nb, BS, raw.length - (nb - 1) * BS, ...parts.map((p) => p.length));
    tags.push(`<DataArray type="Float32" Name="material_${id}" NumberOfComponents="1" format="appended" offset="${off}"/>`);
    app.push(head, ...parts);
    off += head.length + parts.reduce((t, p) => t + p.length, 0);
    blocks += nb;
  }
  const ext = `0 ${vol.X - 1} 0 ${vol.Y - 1} 0 ${vol.Z - 1}`;
  const xml = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">
  <ImageData WholeExtent="${ext}" Origin="0 0 0" Spacing="0.5 0.5 0.5">
    <Piece Extent="${ext}">
      <PointData Scalars="material_1">
        ${tags.join('\n        ')}
      </PointData>
      <CellData>
      </CellData>
    </Piece>
  </ImageData>
  <AppendedData encoding="raw">
   _`;
  const head = enc.encode(xml);
  const tail = enc.encode('\n  </AppendedData>\n</VTKFile>\n');
  const out = new Uint8Array(head.length + off + tail.length);
  out.set(head);
  let at = head.length;
  for (const p of app) (out.set(p, at), (at += p.length));
  out.set(tail, at);
  return { bytes: out, blocks, perArray: Math.ceil((N * 4) / BS), BS, ids };
}
type Volume = import('../src/volume/volume').Volume;

/** 解碼（C4）：decodeVti 在主執行緒的 ms（序列 inflate ＋ argmax O(N·k)）與記憶體。decodeOnly＝decode 模式。 */
async function benchExport(scale: number, decodeOnly: boolean) {
  const { decodeVti, encodeVtiLike, encodeVti } = await import('../src/volume/vti');
  const { ZipWriter, crc32 } = await import('../src/volume/zip');
  type ExportStats = import('../src/volume/vti').ExportStats;
  const vol = demoVolume(scale);
  const N = vol.data.length;
  let t = performance.now();
  const f = await synthVti(vol);
  console.log(`\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M 點）：合成 .vti ${mb(f.bytes.length)}（8 個 Float32 × ${mb(N * 4)} 原始、${f.blocks} 個 32 KB block）${ms(t)}`);
  (globalThis as { gc?: () => void }).gc?.();
  const m0 = process.memoryUsage();
  t = performance.now();
  const { vol: dec, info } = await decodeVti(f.bytes.slice().buffer);
  const tDec = performance.now() - t;
  const m1 = process.memoryUsage();
  let diff = 0;
  for (let i = 0; i < N; i++) if (dec.data[i] !== vol.data[i]) diff++;
  console.log(`  decodeVti ${tDec.toFixed(0)} ms（${info.fractions?.length} 個比例陣列、${diff} 格不同）｜heap＋arrayBuffers 增量 ${mb(m1.heapUsed + m1.arrayBuffers - m0.heapUsed - m0.arrayBuffers)}（原檔 ${mb(f.bytes.length)} 另常駐）`);
  if (decodeOnly) return;
  // 同格式匯出（C1）：改 2 萬格（poly 裡一塊 40×25×20 → SiN）
  const poly = initialLabeled(vol, matName).comps.find((c) => c.label === 'Poly-Si 1')!;
  const data = vol.data.slice();
  const b = poly.bbox;
  let chg = 0;
  const touched = new Set<number>();
  // 和 live split 一樣：diff mask ＋ diff 外框（Worker 給的 hint）
  const diffMask = new Uint8Array(N);
  let box: BBox | null = null;
  for (let z = b.z0 + 2; z < b.z0 + 22 && z <= b.z1; z++)
    for (let y = b.y0 + 2; y < b.y0 + 27 && y <= b.y1; y++)
      for (let x = b.x0 + 2; x < b.x0 + 42 && x <= b.x1; x++) {
        const i = (z * vol.Y + y) * vol.X + x;
        if (data[i] === 7) continue;
        data[i] = 7;
        diffMask[i] = 1;
        box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y), z0: Math.min(box.z0, z), z1: Math.max(box.z1, z) } : { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z };
        chg++;
        touched.add(Math.floor((i * 4) / f.BS));
      }
  const mats = MATERIALS.map((m) => ({ id: m.id, name: m.name, color: m.color }));
  (globalThis as { gc?: () => void }).gc?.();
  const m2 = process.memoryUsage();
  const stats: ExportStats = { blocks: 0, redone: 0 };
  t = performance.now();
  const out = await encodeVtiLike(f.bytes, info.fractions!, data, vol.data, mats, { diff: diffMask, box, dims: vol }, { stats });
  const tEnc = performance.now() - t;
  const m3 = process.memoryUsage();
  console.log(
    `  encodeVtiLike(hint) 改 ${chg} 格：${tEnc.toFixed(0)} ms → ${mb(out.length)}｜ExportStats 重壓 ${stats.redone}／${stats.blocks} 塊（碰到的 block ${touched.size}／${f.perArray}（每陣列）× 8 陣列＝${touched.size * 8}）` +
      `｜heap＋arrayBuffers 增量 ${mb(m3.heapUsed + m3.arrayBuffers - m2.heapUsed - m2.arrayBuffers)}`,
  );
  if (flags.whole) {
    // 對照：整陣列路徑（M15.0 的量法），位元組必須相同
    const st2: ExportStats = { blocks: 0, redone: 0 };
    t = performance.now();
    const whole = await encodeVtiLike(f.bytes, info.fractions!, data, vol.data, mats, undefined, { whole: true, stats: st2 });
    const tWhole = performance.now() - t;
    let eq = whole.length === out.length;
    for (let i = 0; eq && i < out.length; i++) if (out[i] !== whole[i]) eq = false;
    console.log(`  --whole 對照：整陣列路徑 ${tWhole.toFixed(0)} ms（重壓 ${st2.redone}／${st2.blocks}）｜位元組${eq ? '相同' : '不同（錯誤）'}`);
  }
  // vti1（單一 UInt8 編號）＋ ZipWriter 20 個 split（C2）：sink 收集每一段（頁面是 Blob／串流 sink），crc32 事先算好、不用 data descriptor
  t = performance.now();
  const one = await encodeVti(vol);
  const tOne = performance.now() - t;
  const total = one.length * 20;
  (globalThis as { gc?: () => void }).gc?.();
  const m4 = process.memoryUsage();
  t = performance.now();
  const crc = crc32(one);
  const tCrc = performance.now() - t;
  t = performance.now();
  const parts: Uint8Array[] = [];
  let zipLen = 0;
  const w = new ZipWriter((p) => {
    parts.push(p);
    zipLen += p.length;
  });
  for (let k = 0; k < 20; k++) await w.add(`split_${k + 1}.vti`, one.length, crc, [one]);
  await w.finish();
  const tZip = performance.now() - t;
  const m5 = process.memoryUsage();
  console.log(
    `  encodeVti（vti1）${tOne.toFixed(0)} ms → ${mb(one.length)}｜crc32 一個 split ${tCrc.toFixed(0)} ms（頁面在 Worker 算）｜ZipWriter 20 個（共 ${mb(total)}）${tZip.toFixed(0)} ms ＝ ${(total / 2 ** 20 / (tZip / 1000)).toFixed(0)} MB/s → ${mb(zipLen)}、${parts.length} 段（資料段是同一個 Uint8Array 的參考，不複製）` +
      `｜arrayBuffers 增量 ${mb(m5.arrayBuffers - m4.arrayBuffers)}、rss 增量 ${mb(m5.rss - m4.rss)}`,
  );
}

/** n 個 split 的補丁（push poly 1～10 格，輪流三根 poly）：Worker scratch 重播只回補丁（和實驗頁產生 split 同一條路）。 */
async function makeSplits(scale: number, n: number) {
  const core = await import('../src/volume/workerCore');
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  const [ld] = core.handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } }) as [{ labels: Int32Array; counts: Float64Array }, unknown];
  const polys = L.comps.filter((c) => c.mat === 6);
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  type SplitPatch = import('../src/splits/lifecycle').SplitPatch;
  const t = performance.now();
  const pats: { patch: SplitPatch; keys: string[] }[] = [];
  for (let k = 0; k < n; k++) {
    const p = polys[k % polys.length];
    const ops: Op[] = [{ kind: 'push', keys: [p.key], scope: full, dir: [0, -1, 0], n: 1 + (k % 10), follow: true, backfill: 'orig' }];
    pats.push({ patch: (core.handle('replayPatch', { src: 'base', from: 1, comps: L.comps, ops, matNames, keyCounter: 1000 })[0] as { patch: SplitPatch }).patch, keys: [p.key] });
  }
  return { vol, L, labels: ld.labels, pats, gen: performance.now() - t, polys };
}

/**
 * 疊圖（C5）：n 個 split 換片一次＝每個 split contourOf（描整片）＋ sliceDiff（整片比對）；legend 滑過一次＝OverlayView 重 render，
 * lines 沒 memo → 每個 split 再跑 cache.get（命中）＋ sliceDiff。
 */
async function benchOverlay(scale: number, n: number) {
  const { contourOf, contourCache, sliceDiff, overlayKey, overlayEntry, loopsPath } = await import('../src/pages/Section3D/overlay');
  type OverlayEntry = import('../src/pages/Section3D/overlay').OverlayEntry;
  const { slabOfPatch, slabOfArrays } = await import('../src/splits/lifecycle');
  const { vol, L, labels, pats, gen, polys } = await makeSplits(scale, n);
  const at = (polys[0].bbox.z0 + polys[0].bbox.z1) >> 1;
  const base = slabOfArrays(vol, vol.data, labels, L.comps, vol.data, 'z', at);
  let t = performance.now();
  const slabs = pats.map((p) => slabOfPatch(vol, vol.data, labels, p.patch, 'z', at));
  const tSlab = performance.now() - t;
  const cache = contourCache<OverlayEntry>();
  const baseVersion = 1;
  // 和 OverlayView 的 useMemo 相同：每個 split 一個 OverlayEntry（contourOf 只描 keys 外框 ＋ sliceDiff），key 含基準版本
  const lines = () =>
    slabs.map((sl, k) => {
      const e = cache.get(overlayKey(k + 2, 'z', at, pats[k].keys, baseVersion), () => overlayEntry(sl.L, sl.vol, base.vol.data, pats[k].keys, 'z', 0));
      return { d: loopsPath(e.loops), diff: e.diff };
    });
  t = performance.now();
  lines();
  const tCold = performance.now() - t;
  // legend 滑過：頁面是 useMemo 命中（lines 不重算、0 ms）；這裡量「memo 沒命中但快取全命中」重組 lines 的成本當上限
  const hover: number[] = [];
  for (let k = 0; k < 60; k++) {
    t = performance.now();
    lines();
    hover.push(performance.now() - t);
  }
  t = performance.now();
  for (const sl of slabs) contourOf(sl.L, sl.vol, pats[0].keys, 'z', 0);
  const tContour = performance.now() - t;
  t = performance.now();
  for (const sl of slabs) contourOf(sl.L, sl.vol, pats[0].keys, 'z', 0, 'full');
  const tContourFull = performance.now() - t;
  t = performance.now();
  for (const sl of slabs) sliceDiff(sl.vol.data, base.vol.data, sl.vol, 'z', 0);
  const tDiff = performance.now() - t;
  console.log(
    `\n範例 ×${scale}（切面 ${vol.X}×${vol.Y}）${n} 個 split：產生 ${gen.toFixed(0)} ms、切片 ${tSlab.toFixed(0)} ms｜換片一次（overlayEntry 全部）${tCold.toFixed(0)} ms（其中描輪廓 keys 外框 ${tContour.toFixed(0)} ms、對照 'full' 整片 ${tContourFull.toFixed(0)} ms；整片比對 sliceDiff ${tDiff.toFixed(0)} ms）` +
      `｜legend 滑過 60 次：useMemo 命中 0 次重算；快取全命中重組 lines 每次 中位數 ${q(hover, 0.5)} ms、最大 ${q(hover, 1)} ms｜快取 ${JSON.stringify(cache.stats())}（上限 400）`,
  );
}

/** 縮圖（C6）：thumbRGBA 一張＝sliceRGBA 整片（W×H×4 配置）→ 裁 crop → nearest。 */
async function benchThumbs(scale: number) {
  const { thumbRGBA, thumbCrop } = await import('../src/pages/Section3D/thumbs');
  const { contourOf } = await import('../src/pages/Section3D/overlay');
  const { slabOfPatch, slabOfArrays, patchStats } = await import('../src/splits/lifecycle');
  const { hexToRgb } = await import('../src/volume/volume');
  const { vol, L, labels, pats, polys } = await makeSplits(scale, 1);
  const at = (polys[0].bbox.z0 + polys[0].bbox.z1) >> 1;
  const counts = new Float64Array(256);
  const stats = patchStats(vol, pats[0].patch, vol.data, counts);
  const slab = slabOfPatch(vol, vol.data, labels, pats[0].patch, 'z', at);
  const base = slabOfArrays(vol, vol.data, labels, L.comps, vol.data, 'z', at);
  const crop = thumbCrop('z', [stats.diffBox, polys[0].bbox], vol);
  const rgb = new Map(MATERIALS.map((m) => [m.id, hexToRgb(m.color)] as const));
  const loops = contourOf(base.L, base.vol, pats[0].keys, 'z', 0);
  for (let k = 0; k < 3; k++) thumbRGBA(slab, crop, rgb, new Set(), loops);
  const times: number[] = [];
  let log: AllocLog | null = null;
  for (let k = 0; k < 20; k++) {
    const t = performance.now();
    const r = withAlloc(() => thumbRGBA(slab, crop, rgb, new Set(), loops));
    times.push(performance.now() - t);
    log = r.log;
  }
  console.log(
    `\n範例 ×${scale}（切面 ${vol.X}×${vol.Y} ＝ ${mb(vol.X * vol.Y * 4)} RGBA）：thumbRGBA 一張（裁切窗 ${crop.u1 - crop.u0 + 1}×${crop.v1 - crop.v0 + 1}）中位數 ${q(times, 0.5)} ms、最大 ${q(times, 1)} ms｜配置 ${mb(log!.bytes)}（${log!.n} 次；最大一次 Uint8ClampedArray ${mb(log!.max.Uint8ClampedArray ?? 0)}＝縮圖輸出，裁切窗 RGBA 走共用暫存）`,
  );
}

/** 空洞層（A5）：Worker layer {mat: VOID}（X-ray）全量＝貼合 VOID 外框（M15.7：帳簿的 VOID 三軸直方圖，O(X+Y+Z)；舊版 boxOf 掃整個陣列、每格一個 closure）碰到的 chunk 再 mesh；增量（base＝上一步）只看補丁外框；非相鄰版本又是全量（poly 推過一步之後 touch 是整根 poly，貼合外框不受影響）。 */
async function benchLayerVoid(scale: number) {
  const core = await import('../src/volume/workerCore');
  const vol = demoVolume(scale);
  const N = vol.data.length;
  const L = initialLabeled(vol, matName);
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  core.handle('load', { sid: 1, vol: { ...vol, data: vol.data.slice() } });
  core.handle('fork', { owner: 's1', src: 'base', sid: 1 });
  const req = (sid: number, base?: number) => ({ sid, key: 'void', filter: { mat: VOID }, tint: [0.15, 0.15, 0.15] as [number, number, number], base });
  let t = performance.now();
  const r0 = core.handle('layer', req(1))[0] as { items: unknown[]; full: boolean };
  const tFull = performance.now() - t;
  // 舊版的整陣列 closure 掃描在這裡重現（boxOf 沒有 export），對照省下多少
  const data = vol.data;
  const test = (i: number) => data[i] === VOID;
  t = performance.now();
  let n = 0;
  for (let i = 0; i < N; i++) if (test(i)) n++;
  const tScan = performance.now() - t;
  const poly = L.comps.find((c) => c.mat === 6)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const op: Op = { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' };
  core.handle('apply', { owner: 's1', from: 1, to: 2, comps: L.comps, op, matNames, keyCounter: 1000 });
  t = performance.now();
  const r1 = core.handle('layer', req(2, 1))[0] as { items: unknown[]; full: boolean };
  const tInc = performance.now() - t;
  t = performance.now();
  const r2 = core.handle('layer', req(2))[0] as { items: unknown[]; full: boolean };
  const tAgain = performance.now() - t;
  console.log(
    `\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M voxels，VOID ${n} 格）：layer {mat: VOID} 全量 ${tFull.toFixed(0)} ms（${r0.items.length} 個 chunk；整陣列 closure 掃描本身 ≈ ${tScan.toFixed(0)} ms）` +
      `｜一步後增量（base＝上一步）${tInc.toFixed(0)} ms（${r1.items.length} 個 chunk，full=${r1.full}）｜非相鄰版本（沒有 base）${tAgain.toFixed(0)} ms（${r2.items.length} 個 chunk）`,
  );
}

if (mode === 'diff') for (const scale of scales) await benchDiff(scale);
else if (mode === 'drag2') for (const scale of scales) await benchDrag2(scale);
else if (mode === 'export' || mode === 'decode') for (const scale of scales) await benchExport(scale, mode === 'decode');
else if (mode === 'overlay') await benchOverlay(Number(rest[0] ?? 1), Number(rest[1] ?? 200));
else if (mode === 'thumbs') for (const scale of scales) await benchThumbs(scale);
else if (mode === 'layer') for (const scale of scales) await benchLayerVoid(scale);
else if (mode === 'splits') for (const scale of scales) await benchSplits(scale);
else if (mode === 'draw') for (const scale of scales) await benchDraw(scale);
else if (mode === 'step' || mode === 'mem') for (const scale of scales) await benchStep(scale, mode === 'mem' ? 50 : 10);
else if (dragMode)
  for (const scale of scales) {
    benchDrag(scale);
    await benchDragRound(scale);
  }
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
