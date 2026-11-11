// Worker 核心的速度（plan v17）：載入（結構分析＋薄層判定）、一步（相鄰材質規則，Worker 原地 apply＋主執行緒貼補丁＋chunk）、
// 試算（probe）、同格式匯出。×2／×3 只在這裡與 scripts/e2e/perf.cjs 用。
// 用法：npx vite-node scripts/bench.ts [load|step|probe|export] [scale ...]（預設 step 1 2 3）
//   load：labelComponents＋linerTable（plan v17 §5.4.2；×3 的預算 ≤ 2 s）
//   step：fin 上面外推 1 格、Poly 上面外推 1 格、fin 往右平移 1 格（跟著移動）：Worker apply、主執行緒貼補丁、chunk 增量的 ms
//   probe：推拉一面與平移六向的試算 ms
//   export：合成壓縮比例陣列 .vti（8 個 Float32、zlib、32 KB 一塊）：decodeVti、encodeVtiLike（改 2 萬格，只重壓碰到的 block）、encodeVti（vti1）
import { type BBox, MATERIALS, VOID, demoVolume, initialLabeled, labelComponents, linerTable } from '../src/volume/volume';
import { type Op, matNameOf } from '../src/volume/ops';
import { fullScope } from '../src/volume/scope';

const matName = matNameOf(MATERIALS);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const args = process.argv.slice(2);
const MODES = ['load', 'step', 'probe', 'export'];
const mode = MODES.includes(args[0]) ? args[0] : 'step';
const rest = args.slice(MODES.includes(args[0]) ? 1 : 0).filter((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
const scales = rest.length ? rest.map(Number) : [1, 2, 3];
const mb = (n: number) => `${(n / 2 ** 20).toFixed(1)} MB`;

async function benchLoad(scale: number) {
  const vol = demoVolume(scale);
  let t = performance.now();
  labelComponents(vol);
  const tLabel = performance.now() - t;
  t = performance.now();
  const liners = linerTable(vol);
  const tLiner = performance.now() - t;
  console.log(`範例 ×${scale}（${(vol.data.length / 1e6).toFixed(1)} M 格）：結構分析 ${tLabel.toFixed(0)} ms、薄層判定 ${tLiner.toFixed(0)} ms → 薄層 [${liners.join(', ')}]`);
}

async function benchStep(scale: number) {
  const core = await import('../src/volume/workerCore');
  const { applyStepInPlace, carryStepStats, newAxes } = await import('../src/volume/patch');
  type Step = import('../src/volume/patch').Step;
  const vol = demoVolume(scale);
  const N = vol.data.length;
  const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
  const hidden = new Uint8Array(256);
  const palette = new Float32Array(768).fill(0.5);
  let t = performance.now();
  const [ld] = core.handle('load', { sid: 1, vol }) as [{ labels: Int32Array; liners: number[] }, unknown];
  console.log(`\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M 格）：load ${ms(t)}，薄層 [${ld.liners.join(', ')}]`);
  // ×3 每一格大了 3 倍、薄層判定 ≤ 4 格就判不出來：bench 固定用 ×1 判出來的材質，量的是規則本身的速度
  const liners = [4, 5, 7];
  const L = initialLabeled(vol, matName);
  core.handle('fork', { owner: 'cur', src: 'base', sid: 1 });
  const buf = { data: vol.data.slice(), labels: ld.labels.slice(), diff: new Uint8Array(N), diffCount: 0, counts: new Float64Array(256), axes: newAxes(vol) };
  let comps = L.comps;
  let sid = 1;
  core.handle('chunks', { sid, key: 'k', hidden, diff: false, palette });
  const full = fullScope(vol);
  const fin = comps.find((c) => c.mat === 3)!;
  const poly = comps.find((c) => c.mat === 6)!;
  const ops: [string, Op][] = [
    ['fin 上面外推 1（跟著移動）', { kind: 'push', keys: [fin.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'outer', policy: 'adjacent', liners }],
    ['Poly 上面外推 1（跟著移動）', { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'outer', policy: 'adjacent', liners }],
    ['fin 往右平移 1（跟著移動）', { kind: 'translate', keys: [fin.key], scope: full, d: [1, 0, 0], backfill: 'outer', follow: true, policy: 'adjacent', liners }],
    ['fin 上面外推 3（跟著移動）', { kind: 'push', keys: [fin.key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'outer', policy: 'adjacent', liners }],
  ];
  for (const [name, op] of ops) {
    t = performance.now();
    const [r] = core.handle('apply', { owner: 'cur', from: sid, to: sid + 1, comps, op, matNames, keyCounter: 1000 + sid * 10 }) as [{ step: Step; report: { done?: number } }, unknown];
    const tApply = performance.now() - t;
    if (!r.step.data) {
      console.log(`  ${name}：沒有改到`);
      continue;
    }
    t = performance.now();
    comps = applyStepInPlace(vol, buf.data, buf.labels, r.step, 'fwd') ?? comps;
    buf.diffCount = carryStepStats(vol, buf.data, vol.data, buf.diff, buf.diffCount, buf.counts, r.step, 'fwd', buf.axes);
    const tMain = performance.now() - t;
    const shown = sid;
    sid++;
    t = performance.now();
    const [ch] = core.handle('chunks', { sid, key: 'k', hidden, diff: false, palette, base: shown }) as [{ items: unknown[] }, unknown];
    const tChunks = performance.now() - t;
    const b: BBox = r.step.data.box;
    const vox = (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
    console.log(`  ${name}：做了 ${r.report.done} 格｜apply ${tApply.toFixed(0)} ms、主執行緒貼補丁 ${tMain.toFixed(0)} ms、chunk ${ch.items.length} 個 ${tChunks.toFixed(0)} ms｜合計 ${(tApply + tMain + tChunks).toFixed(0)} ms｜補丁外框 ${vox.toLocaleString()} 格`);
  }
}

async function benchProbe(scale: number) {
  const { probe } = await import('../src/volume/probe');
  const vol = demoVolume(scale);
  const L = initialLabeled(vol, matName);
  const liners = [4, 5, 7];
  for (const [name, mat] of [['fin', 3], ['Poly', 6]] as const) {
    const c = L.comps.find((x) => x.mat === mat)!;
    let t = performance.now();
    const p1 = probe({ vol, L }, { keys: [c.key], kind: 'push', dir: [0, -1, 0], follow: true, liners });
    const tPush = performance.now() - t;
    t = performance.now();
    const p2 = probe({ vol, L }, { keys: [c.key], kind: 'translate', follow: true, liners });
    console.log(`範例 ×${scale} ${name}：推拉試算 ${tPush.toFixed(0)} ms（最多外推 ${p1.out?.n}）｜平移六向 ${ms(t)}（${p2.dirs?.map((d) => d.n).join('／')}）`);
  }
}

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

async function benchExport(scale: number) {
  const { decodeVti, encodeVtiLike, encodeVti } = await import('../src/volume/vti');
  type ExportStats = import('../src/volume/vti').ExportStats;
  const vol = demoVolume(scale);
  const N = vol.data.length;
  let t = performance.now();
  const f = await synthVti(vol);
  console.log(`\n範例 ×${scale}（${(N / 1e6).toFixed(1)} M 點）：合成 .vti ${mb(f.bytes.length)}（${f.blocks} 個 32 KB block）${ms(t)}`);
  t = performance.now();
  const { info } = await decodeVti(f.bytes.slice().buffer);
  console.log(`  decodeVti ${ms(t)}（${info.fractions?.length} 個比例陣列）`);
  // 同格式匯出（只重壓改到的 block）：poly 裡一塊 40×25×20 → SiN
  const poly = initialLabeled(vol, matName).comps.find((c) => c.label === 'Poly-Si 1')!;
  const data = vol.data.slice();
  const b = poly.bbox;
  const diffMask = new Uint8Array(N);
  let box: BBox | null = null;
  let chg = 0;
  for (let z = b.z0 + 2; z < b.z0 + 22 && z <= b.z1; z++)
    for (let y = b.y0 + 2; y < b.y0 + 27 && y <= b.y1; y++)
      for (let x = b.x0 + 2; x < b.x0 + 42 && x <= b.x1; x++) {
        const i = (z * vol.Y + y) * vol.X + x;
        if (data[i] === 7) continue;
        data[i] = 7;
        diffMask[i] = 1;
        box = box ? { x0: Math.min(box.x0, x), x1: Math.max(box.x1, x), y0: Math.min(box.y0, y), y1: Math.max(box.y1, y), z0: Math.min(box.z0, z), z1: Math.max(box.z1, z) } : { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z };
        chg++;
      }
  const mats = MATERIALS.map((m) => ({ id: m.id, name: m.name, color: m.color }));
  const stats: ExportStats = { blocks: 0, redone: 0 };
  t = performance.now();
  const out = await encodeVtiLike(f.bytes, info.fractions!, data, vol.data, mats, { diff: diffMask, box, dims: vol }, { stats });
  console.log(`  encodeVtiLike 改 ${chg} 格：${ms(t)} → ${mb(out.length)}｜重壓 ${stats.redone}／${stats.blocks} 塊`);
  if (flags.has('whole')) {
    const st2: ExportStats = { blocks: 0, redone: 0 };
    t = performance.now();
    const whole = await encodeVtiLike(f.bytes, info.fractions!, data, vol.data, mats, undefined, { whole: true, stats: st2 });
    let eq = whole.length === out.length;
    for (let i = 0; eq && i < out.length; i++) if (out[i] !== whole[i]) eq = false;
    console.log(`  --whole 對照：整陣列路徑 ${ms(t)}｜位元組${eq ? '相同' : '不同（錯誤）'}`);
  }
  t = performance.now();
  const one = await encodeVti(vol);
  console.log(`  encodeVti（UInt8 CellData）${ms(t)} → ${mb(one.length)}`);
}

(async () => {
  for (const s of scales) {
    if (mode === 'load') await benchLoad(s);
    else if (mode === 'probe') await benchProbe(s);
    else if (mode === 'export') await benchExport(s);
    else await benchStep(s);
  }
})();
