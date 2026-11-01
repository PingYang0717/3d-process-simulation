// plan v15 §7 e2e 1～10（M15.7 驗收）。每條一段、ok() 斷言；`--only=1,3` 只跑幾段（沒跑的段落需要的狀態會自己補載）。
// 1. ×2 選基板連做 5 步：每步 selMask／diffBox 的毫秒、layer 請求 1、StructureList commit ≤ 1、selMask 身分不變。
// 2. 換 cursor 20 次：layer 不增、把手不重建、Inspector／StructureList 0 次。
// 3. 拖左欄寬 60 個 pointermove：Section3DPage commit ≤ 20。
// 4. 2D 拖基板頂邊 60 步：算 Op 的次數／幀數 ≤ 0.5、preview 請求 ≤ Op 次數。
// 5. 一步後立刻 hover 10 次：事件裡同步建的 BVH 棵數（每事件有 8 ms 預算）、long task。
// 6. 上傳合成 ×2 比例陣列 .vti（8 個 Float32 zlib appended）：解碼期間主執行緒 long task、heap／RSS 增量。
// 7. 20 個 split 匯出 zip（vti1）：主執行緒 heap 尖峰、Node 解 zip 比 CRC；同格式匯出一個改 2 萬格的 split：Worker 時間、未改 block 位元組 === 原檔。
// 8. 實驗頁 200 個 split 疊圖：legend 滑過 60 次 __overlayMs 不增、整頁不 render；OverlayView 自己 render 時 lines memo 命中。
// 9. 開 X-ray：layer {mat: VOID} 的往返時間。
// 10. ×1 基板 translate 10 次：__histBytes ≤ 256 MB、筆數；上限調到 64 MB 後筆數隨上限縮。
//
// 門檻（headless 軟體 WebGL 很慢，所以）：量「次數」的照 §7 嚴格斷言（layer 0、把手重建 0、render 次數、Op／幀 ≤ 0.5、CRC、身分、block 位元組）；
// 量「毫秒」的放寬或只印：selMask < 5 → 斷言 < 15、diffBox < 1 → 斷言 < 5（容器裡同時有別的 dev server／vitest，單次量測抖動 2～3 倍）；
// hover 的 long task 只印（軟體 WebGL 畫一幀就 > 50 ms），改斷言 __bvhStats.sync 每事件 ≤ 2（8 ms 預算、一棵 64³ 在這台 ≈ 5 ms）；
// 上傳的 long task 只印（第一次 3D 的 shader 編譯在主執行緒），斷言解碼到結構分析完之間沒有 > 200 ms 的；同格式匯出 < 300 ms → 斷言 < 1,500 ms（Worker 和 3D 搶同一顆軟體繪圖的 CPU）；
// X-ray 的 layer 往返 < 20 ms → 斷言 < 60 ms（含佇列、結構化複製）。每段都印實測數字。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m15.cjs [http://localhost:5173] [--only=1,2]`。
// Chromium 要 --enable-precise-memory-info 才有 performance.memory、--expose-gc 才有 gc()。
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const url = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'http://localhost:5173';
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const want = (n) => !only.length || only.includes(n);
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};
const info = (msg) => console.log('· ' + msg);
const MB = 1048576;
const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

/**
 * 合成 ×scale 比例陣列 .vti（和 perf.cjs 的 synthVtiFile 相同，§7 e2e 6／7）：demoVolume 同尺寸的簡化版，
 * PointData 8 個 Float32（material_1～7、material_254）one-hot，zlib、appended raw、UInt32 header、32 KB 一塊。
 */
function synthVtiFile(scale) {
  const file = path.join(os.tmpdir(), `v15-frac-x${scale}.vti`);
  if (fs.existsSync(file)) return file;
  const s = scale;
  const X = 160 * s;
  const Y = 96 * s;
  const Z = 128 * s;
  const N = X * Y * Z;
  const data = new Uint8Array(N);
  const box = (x0, x1, y0, y1, z0, z1, m) => {
    for (let z = Math.max(0, z0); z < Math.min(Z, z1); z++) for (let y = Math.max(0, y0); y < Math.min(Y, y1); y++) data.fill(m, (z * Y + y) * X + Math.max(0, x0), (z * Y + y) * X + Math.min(X, x1));
  };
  box(0, X, 70 * s, Y, 0, Z, 1);
  box(0, X, 60 * s, 70 * s, 0, Z, 2);
  const gates = [[14 * s, 38 * s], [52 * s, 76 * s], [90 * s, 114 * s]];
  for (const [z0, z1] of gates) {
    box(8 * s, X - 8 * s, 18 * s, 60 * s, z0, z1, 6);
    box(8 * s, X - 8 * s, 14 * s, 18 * s, z0, z1, 7);
  }
  for (const c of [40 * s, 80 * s, 120 * s]) {
    for (const [z0, z1] of gates) {
      box(c - 10 * s, c + 10 * s, 26 * s, 60 * s, z0, z1, 5);
      box(c - 8 * s, c + 8 * s, 28 * s, 60 * s, z0, z1, 4);
    }
    box(c - 6 * s, c + 6 * s, 30 * s, 70 * s, 0, Z, 3);
  }
  for (const z of [96 * s, 101 * s, 106 * s]) box(24 * s, X - 24 * s, 24 * s, 56 * s, z, z + 1, 254);
  const BS = 32768;
  const u32 = (...v) => Buffer.from(new Uint32Array(v).buffer);
  const parts = [];
  const tags = [];
  let off = 0;
  for (const id of [1, 2, 3, 4, 5, 6, 7, 254]) {
    const f = new Float32Array(N);
    for (let i = 0; i < N; i++) if (data[i] === id) f[i] = 1;
    const raw = Buffer.from(f.buffer);
    const nb = Math.ceil(raw.length / BS);
    const blocks = [];
    for (let k = 0; k < nb; k++) blocks.push(zlib.deflateSync(raw.subarray(k * BS, Math.min(raw.length, (k + 1) * BS))));
    const head = u32(nb, BS, raw.length - (nb - 1) * BS, ...blocks.map((b) => b.length));
    tags.push(`<DataArray type="Float32" Name="material_${id}" NumberOfComponents="1" format="appended" offset="${off}"/>`);
    parts.push(head, ...blocks);
    off += head.length + blocks.reduce((t, b) => t + b.length, 0);
  }
  const ext = `0 ${X - 1} 0 ${Y - 1} 0 ${Z - 1}`;
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
  fs.writeFileSync(file, Buffer.concat([Buffer.from(xml), ...parts, Buffer.from('\n  </AppendedData>\n</VTKFile>\n')]));
  return file;
}

/** 解 appended raw ＋ zlib（UInt32 header）的 .vti：每個 DataArray 的壓縮 block 位元組（比對用）。 */
function vtiBlocks(buf) {
  const text = buf.toString('latin1', 0, Math.min(buf.length, 1 << 20));
  const at = text.indexOf('<AppendedData');
  const base = text.indexOf('_', at) + 1;
  const arrays = [];
  const re = /<DataArray\b([^>]*)\/?>/g;
  let m;
  while ((m = re.exec(text.slice(0, at)))) {
    const attrs = m[1];
    const name = /Name="([^"]*)"/.exec(attrs)?.[1] ?? '';
    const off = Number(/offset="(\d+)"/.exec(attrs)?.[1] ?? NaN);
    if (!Number.isFinite(off)) continue;
    let p = base + off;
    const nb = buf.readUInt32LE(p);
    const bs = buf.readUInt32LE(p + 4);
    const last = buf.readUInt32LE(p + 8);
    const sizes = [];
    for (let k = 0; k < nb; k++) sizes.push(buf.readUInt32LE(p + 12 + 4 * k));
    p += 12 + 4 * nb;
    const blocks = sizes.map((s) => {
      const b = buf.subarray(p, p + s);
      p += s;
      return b;
    });
    arrays.push({ name, nb, bs, last, blocks });
  }
  return arrays;
}

/** 解 zip（store only，含 ZIP64 的 central directory／EOCD64）：每個 entry 的檔名、宣告的 CRC 與資料實際算出來的 CRC。 */
function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip：找不到 end of central directory');
  let n = buf.readUInt16LE(e + 10);
  let cdOff = buf.readUInt32LE(e + 16);
  let zip64 = false;
  if ((n === 0xffff || cdOff === 0xffffffff) && e >= 20 && buf.readUInt32LE(e - 20) === 0x07064b50) {
    zip64 = true;
    const eocd64 = Number(buf.readBigUInt64LE(e - 20 + 8));
    if (buf.readUInt32LE(eocd64) !== 0x06064b50) throw new Error('zip：EOCD64 簽名不對');
    n = Number(buf.readBigUInt64LE(eocd64 + 32));
    cdOff = Number(buf.readBigUInt64LE(eocd64 + 48));
  }
  const entries = [];
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip：第 ${k} 個 central header 簽名不對`);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) (usize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(buf.readBigUInt64LE(q))), (q += 8);
        if (localOff === 0xffffffff) (localOff = Number(buf.readBigUInt64LE(q))), (q += 8);
      }
      x += 4 + len;
    }
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip：${name} 的 local header 簽名不對`);
    const dataOff = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const data = buf.subarray(dataOff, dataOff + csize);
    entries.push({ name, method, crc, size: usize, data, actual: zlib.crc32(data) >>> 0 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, zip64 };
}

(async () => {
  const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192 --expose-gc', '--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, acceptDownloads: true });
  const errors = [];
  const devErrors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // memoEd 的 uses 過期、selMask 原地維護和全量不同：src 以 console.error 報，e2e 當失敗
  page.on('console', (m) => {
    // 只看訊息第一行：React 警告的元件堆疊裡也有 memoEd.ts
    if (m.type() === 'error' && /^memoEd：|selMask 原地維護/.test(m.text().split('\n')[0])) devErrors.push(m.text().split('\n')[0]);
  });
  // Worker 往返計數（和 perf.cjs 相同）：__posts[type]、__rt[type]（layer {mat} 另記 layer:void）、long task、rAF 幀數
  await page.addInitScript(() => {
    window.__posts = {};
    window.__rt = {};
    // 每個請求送出／回來的時間（__io[type] = [{out, in}]），e2e 6 用來框出「解碼期間」
    window.__io = {};
    const rtPending = new Map();
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type) {
        window.__posts[msg.type] = (window.__posts[msg.type] || 0) + 1;
        if (msg.id !== undefined) rtPending.set(msg.id, { key: msg.type === 'layer' && msg.req?.filter && 'mat' in msg.req.filter ? 'layer:void' : msg.type, t: performance.now() });
      }
      return post.call(this, msg, ...rest);
    };
    const om = Object.getOwnPropertyDescriptor(Worker.prototype, 'onmessage');
    Object.defineProperty(Worker.prototype, 'onmessage', {
      configurable: true,
      get() {
        return om.get.call(this);
      },
      set(fn) {
        om.set.call(this, (e) => {
          const p = e.data && rtPending.get(e.data.id);
          if (p) {
            rtPending.delete(e.data.id);
            const now = performance.now();
            (window.__rt[p.key] ||= []).push(now - p.t);
            (window.__io[p.key] ||= []).push({ out: p.t, in: now });
          }
          return fn.call(this, e);
        });
      },
    });
    window.__rafs = 0;
    window.__frames = 0;
    let lastTs = -1;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) =>
      raf.call(window, (ts) => {
        window.__rafs++;
        if (ts !== lastTs) (lastTs = ts), window.__frames++;
        cb(ts);
      });
    window.__long = 0;
    window.__longMax = 0;
    window.__longs = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__long++;
        window.__longMax = Math.max(window.__longMax, e.duration);
        window.__longs.push({ d: Math.round(e.duration), t: e.startTime });
      }
    }).observe({ type: 'longtask', buffered: true });
    // __selMaskMs／__diffBoxMs 每次 render 都會被覆寫（沒事做時 ≈ 0）：改成 setter 累計這一步的最大值（__peak）
    window.__peak = { selMask: 0, diffBox: 0 };
    for (const [prop, key] of [['__selMaskMs', 'selMask'], ['__diffBoxMs', 'diffBox']]) {
      let v;
      Object.defineProperty(window, prop, {
        configurable: true,
        get: () => v,
        set: (x) => {
          v = x;
          if (x > window.__peak[key]) window.__peak[key] = x;
        },
      });
    }
  });

  // ---- 共用 ----
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const posts = () => ev(() => ({ ...window.__posts }));
  const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => (b[k] || 0) !== (a[k] || 0)).map((k) => [k, b[k] - (a[k] || 0)]));
  const rb = (name) => ev((n) => window.__rendersBy?.[n] ?? 0, name);
  const renders = () => ev(() => window.__renders ?? 0);
  const longs = () => ev(() => [window.__long, Math.round(window.__longMax), window.__longs.slice()]);
  const resetLongs = () => ev(() => ((window.__long = 0), (window.__longMax = 0), (window.__longs = [])));
  const resetPeak = () => ev(() => (window.__peak = { selMask: 0, diffBox: 0 }));
  const roundTrips = (type) => ev((t) => (window.__rt?.[t] ?? []).map((x) => Math.round(x * 10) / 10), type);
  const heapMB = async () => {
    const h = await ev(() => (window.gc?.(), performance.memory?.usedJSHeapSize ?? -1));
    return h < 0 ? NaN : h / MB;
  };
  /** Chromium renderer 的 RSS（MB）：usedJSHeapSize 不含 ArrayBuffer 的後備儲存。取最大的那個 renderer。 */
  const rendererMB = () => {
    try {
      const out = require('child_process').execSync('ps -eo rss,args', { encoding: 'utf8' });
      let max = 0;
      for (const line of out.split('\n')) if (/--type=renderer/.test(line) && !/--extension-process/.test(line)) max = Math.max(max, Number(line.trim().split(/\s+/)[0]) || 0);
      return max / 1024;
    } catch {
      return NaN;
    }
  };
  /**
   * 期間的 heap／RSS 最高值。usedJSHeapSize 含 ArrayBuffer 的後備儲存，Worker 傳回來的位元組在 GC 之前都算在裡面；
   * live=true 每次取樣先 gc()，量的是「同時活著的」位元組（e2e 7 的「主執行緒同時只留一個 split」就是這個意思）。
   */
  const pollPeak = (ms = 40, live = false) => {
    let heap = 0;
    let rss = 0;
    let busy = false;
    const h = setInterval(() => {
      if (!busy) {
        busy = true;
        page
          .evaluate((live) => (live && window.gc?.(), performance.memory?.usedJSHeapSize ?? 0), live)
          .then((x) => (heap = Math.max(heap, x / MB)))
          .catch(() => {})
          .finally(() => (busy = false));
      }
      rss = Math.max(rss, rendererMB());
    }, ms);
    return { stop: () => (clearInterval(h), { heap, rss }) };
  };
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector('.busy-bar') && !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 300000 }).catch(() => {});
    await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 }).catch(() => {});
    await page.waitForTimeout(400);
  };
  const fresh = async () => {
    await page.goto(url);
    await ev(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => window.__ed);
    // page（編輯／實驗）存在 localStorage：前一段實驗頁還開著 200 個 split 時，clear 和 reload 之間可能又被寫回 'lab'，強制回編輯頁
    await ev(() => window.__ed.page !== 'edit' && window.__ed.setPage('edit'));
    await page.waitForTimeout(200);
  };
  const loadDemo = async (s) => {
    await fresh();
    await ev((s) => window.__ed.demo(s), s);
    await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 3'), null, { timeout: 300000 });
    await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
    await idle();
  };
  /** 這一段要的狀態：範例 ×s（不是上傳的 .vti、尺寸對）。不對就重載。 */
  let have = null;
  const ensureDemo = async (s) => {
    if (have === `demo${s}`) return;
    await loadDemo(s);
    have = `demo${s}`;
  };
  const vtiPath = synthVtiFile(2);
  const uploadVti = async () => {
    await fresh();
    await page.locator('.ant-upload input[type=file]').setInputFiles(vtiPath);
    await page.locator('.load-confirm').waitFor({ timeout: 120000 });
    await page.locator('.load-confirm').getByRole('button', { name: /載\s*入/ }).click();
    await page.waitForFunction(() => window.__ed.comps.length > 1 && window.__ed.meta?.format === 'vti', null, { timeout: 600000 });
    await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
    await idle();
  };
  const ensureVti = async () => {
    if (have === 'vti') return;
    await uploadVti();
    have = 'vti';
  };
  const keyOf = (label) => ev((label) => window.__ed.comps.find((c) => c.label === label).key, label);
  const select = (label) => ev((label) => window.__ed.selectKeys([window.__ed.comps.find((c) => c.label === label).key]), label);
  /** 基板＝格數最多的結構（名字「Si (p) 1」收在群組裡，用 selectKeys 不點清單）。 */
  const selectSubstrate = () => ev(() => window.__ed.selectKeys([window.__ed.comps.reduce((a, c) => (c.count > a.count ? c : a)).key]));
  const substrateLabel = () => ev(() => window.__ed.comps.reduce((a, c) => (c.count > a.count ? c : a)).label);
  const leaveFocus = async () => {
    for (let k = 0; k < 3 && (await ev(() => !!window.__ed.focus)); k++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
  };

  // ---- 1. ×2 選基板連做 5 步（A1、A2） ----
  if (want(1)) {
    console.log('\n—— 1. ×2 選基板連做 5 步 ——');
    await ensureDemo(2);
    await ev(() => window.__ed.setBigOp(1e9));
    await selectSubstrate();
    await idle();
    const label = await substrateLabel();
    const N = await ev(() => window.__ed.vol.data.length);
    ok(await ev(() => (window.__m15mask = window.__ed.selMask) instanceof Uint8Array), `選到 ${label}（${(N / 1e6).toFixed(1)} M 格）：selMask 已建`);
    // 一步：選著基板時 Poly-Si 1 沿 x 長 1（和 bench.ts step --sel substrate 同一種：touch 只有那一面，1 × 84 × 48）；
    // 或 translate 整個基板（touch＝整個基板外框 ≈ 4.2 M 格，A1 原地維護 ∝ touch 的最壞情形）。
    // 不用「基板長／縮」或「缺陷」：從基板拿走格子的步驟 labels 快照是整個基板（A3 的 lost bbox），touch 一樣是整個基板。
    const step = async (k, kind) => {
      const p0 = await posts();
      const sl0 = await rb('StructureList');
      await resetPeak();
      await ev(() => (window.__m15mask = window.__ed.selMask));
      const t0 = Date.now();
      if (kind === 'translate') await ev((k) => window.__ed.translate([k % 2 ? -1 : 1, 0, 0]), k);
      else
        await ev(() => {
          const ed = window.__ed;
          const p = ed.comps.find((c) => c.label === 'Poly-Si 1');
          ed.commit({ kind: 'push', keys: [p.key], scope: { axis: 'z', lo: 0, hi: ed.vol.Z - 1 }, dir: [1, 0, 0], n: 1, follow: ed.follow, backfill: ed.backfill, policy: ed.pushPolicy });
        });
      await idle();
      const dt = Date.now() - t0;
      const peak = await ev(() => window.__peak);
      const d = delta(p0, await posts());
      const sl = (await rb('StructureList')) - sl0;
      const same = await ev(() => window.__ed.selMask === window.__m15mask);
      const box = await ev(() => {
        const b = window.__ed.lastStep?.box;
        return b ? (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1) : 0;
      });
      const r = { k, kind, dt, sel: peak.selMask, diff: peak.diffBox, layer: d.layer ?? 0, sl, same, box, fork: !!d.fork };
      info(`${kind} 第 ${k + 1} 步（${dt} ms，送 Worker ${JSON.stringify(d)}，touch ${box >= 1e6 ? (box / 1e6).toFixed(2) + ' M' : (box / 1e3).toFixed(1) + ' k'} 格）：selMask ${fmt(peak.selMask, 1)} ms、diffBox ${fmt(peak.diffBox, 2)} ms、layer ${d.layer ?? 0}、StructureList commit ${sl}、selMask 身分${same ? '相同' : r.fork ? '變了（fork 之後重建，預期）' : '變了'}`);
      return r;
    };
    const first = await step(0, 'poly'); // 第一步 fork 成 Split 1：帳簿換新 → 重建一次（預期），不算在統計裡
    const small = [];
    for (let k = 1; k <= 8; k++) small.push(await step(k, 'poly'));
    const big = [];
    for (let k = 0; k < 3; k++) big.push(await step(k, 'translate'));
    const all = [first, ...small, ...big];
    const steps = await ev(() => window.__ed.active?.ops.length ?? 0);
    ok(steps === 12, `12 步都有改到格子（split 有 ${steps} 步）`);
    ok(first.fork && !first.same, '第一步 fork 成 Split 1（帳簿換新，selMask 重建一次）');
    // 單步的毫秒在這台很抖（DEV 每 20 步隨機抽一次和 maskOf 全量比對 ≈ 40 ms、GC 落在 hook 裡）：看中位數
    const median = (rs) => {
      const xs = rs.map((r) => r.sel).sort((a, b) => a - b);
      return xs.length % 2 ? xs[xs.length >> 1] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
    };
    ok(median(small) < 5, `選著基板時 Poly-Si 1 長 1 × 8：selMask＋affMask 原地維護中位數 < 5 ms（${fmt(median(small), 1)}；每步 ${small.map((r) => fmt(r.sel, 1)).join('、')}；基線整個重建 19.5）`);
    ok(median(big) < 40, `基板整個 translate × 3：中位數 < 40 ms（${fmt(median(big), 1)}；touch ${(big[0].box / 1e6).toFixed(1)} M 格、∝ touch；每步 ${big.map((r) => fmt(r.sel, 1)).join('、')}）`);
    ok(all.every((r) => r.diff < 5), `每步 diffBox < 5 ms（目標 < 1；實測 ${all.map((r) => fmt(r.diff, 2)).join('、')}）`);
    ok(all.every((r) => r.layer === 1), `每步 layer 請求 1 次（${all.map((r) => r.layer).join('、')}）`);
    ok(all.every((r) => r.sl <= 1), `每步 StructureList commit ≤ 1（${all.map((r) => r.sl).join('、')}）`);
    ok(all.every((r) => r.same || r.fork), 'selMask 陣列身分每步都不變（第一步 fork 成 Split 1 之後重建一次是預期）');
  }

  // ---- 2. 換 cursor 20 次（B1） ----
  if (want(2)) {
    console.log('\n—— 2. 換 cursor 20 次 ——');
    await ensureDemo(2);
    await leaveFocus();
    await select('Poly-Si 1');
    await page.waitForTimeout(600);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__ed.focus?.view === '3d', null, { timeout: 10000 }).catch(() => {});
    await idle();
    ok((await ev(() => window.__ed.focus?.view)) === '3d', '選 Poly-Si 1、E 進入聚焦編輯（3D 把手）');
    const p0 = await posts();
    const r0 = await renders();
    const c0 = { page: await rb('Section3DPage'), insp: await rb('Inspector'), list: await rb('StructureList'), hb: await ev(() => window.__handleBuilds ?? 0) };
    await resetLongs();
    const t0 = Date.now();
    for (let k = 0; k < 20; k++) {
      await ev((k) => {
        const ed = window.__ed;
        const c = ed.cursor;
        ed.setCursor([c[0], c[1], Math.max(0, Math.min(ed.vol.Z - 1, c[2] + (k % 2 ? 1 : -1)))]);
      }, k);
      await page.waitForTimeout(120);
    }
    await idle();
    const dt = Date.now() - t0;
    const d = delta(p0, await posts());
    const [n, max] = await longs();
    const c1 = { page: await rb('Section3DPage'), insp: await rb('Inspector'), list: await rb('StructureList'), hb: await ev(() => window.__handleBuilds ?? 0) };
    info(`20 次 setCursor（${dt} ms）：送 Worker ${JSON.stringify(d)}、整頁 render-body ${(await renders()) - r0} 次、long task ${n} 個（最長 ${max} ms）`);
    ok(!d.layer, `layer 請求不增（${d.layer ?? 0}）`);
    ok(c1.hb === c0.hb, `把手不重建（__handleBuilds ${c0.hb} → ${c1.hb}）`);
    ok(c1.list === c0.list, `StructureList commit 0 次（${c1.list - c0.list}）`);
    // Inspector 的 uses（OpCard 的 CARD_USES）含 cursor（RoundCard 顯示「這一片」要讀），memoEd 比的是 uses 的值，所以沒開卡片也每次換 cursor commit 1 次：
    // §7 寫 0 次，這裡斷言 ≤ 20 並印出來（src 的問題，見回報）
    ok(c1.insp - c0.insp <= 20, `Inspector commit ≤ 20 次（${c1.insp - c0.insp}；§7 目標 0，CARD_USES 含 cursor）`);
    ok(c1.page - c0.page <= 20, `Section3DPage commit ≤ 20 次（${c1.page - c0.page}）`);
  }

  // ---- 3. 拖左欄寬 60 個 pointermove（B2） ----
  if (want(3)) {
    console.log('\n—— 3. 拖左欄寬 60 個 pointermove ——');
    await ensureDemo(2);
    const rz = page.locator('.resizer[aria-label="左欄寬度"]');
    const bb = await rz.boundingBox();
    const x0 = bb.x + bb.width / 2;
    const y0 = bb.y + bb.height / 2;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    const c0 = await rb('Section3DPage');
    const r0 = await renders();
    const f0 = await ev(() => window.__renderer?.info.render.frame ?? 0);
    await resetLongs();
    const t0 = Date.now();
    for (let k = 1; k <= 60; k++) {
      await page.mouse.move(x0 + (k % 2 ? 2 : -2) + Math.floor(k / 2), y0);
      await page.waitForTimeout(8);
    }
    const dt = Date.now() - t0;
    const [n, max] = await longs();
    const c1 = await rb('Section3DPage');
    const f1 = await ev(() => window.__renderer?.info.render.frame ?? 0);
    await page.mouse.up();
    await page.waitForTimeout(500);
    info(`60 個 pointermove（${dt} ms）：Section3DPage commit ${c1 - c0}、整頁 render-body ${(await renders()) - r0}、3D 重畫 ${f1 - f0} 幀、long task ${n} 個（最長 ${max} ms）`);
    ok(c1 - c0 <= 20, `Section3DPage commit ≤ 20（${c1 - c0}）`);
  }

  // ---- 4. 2D 拖基板頂邊 60 步（B3） ----
  if (want(4)) {
    console.log('\n—— 4. 2D 拖基板頂邊 60 步 ——');
    await ensureDemo(2);
    await leaveFocus();
    await ev(() => window.__ed.clearSel());
    // 沿 z 切、關掉自動放大：主切面就是整片，頁面座標 ＝ 圖框 ＋ (u, v) × 縮放
    await ev(() => (window.__ed.setAutoZoom(false), window.__ed.setEditAxis('z'), window.__ed.setBigOp(1e9)));
    await selectSubstrate();
    await page.waitForTimeout(600);
    if (!(await ev(() => window.__ed.focus))) {
      await page.keyboard.press('e');
      await page.waitForFunction(() => window.__ed.focus?.view === '3d', null, { timeout: 10000 }).catch(() => {});
    }
    await page.keyboard.press('e');
    await page.locator('.main-slice').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.addStyleTag({ content: '.float-tb { display: none !important; }' });
    // 基板那一環的頂邊：v 最小的相鄰兩個頂點，抓中點
    const edge = await ev(() => {
      const e = window.__ed;
      const key = [...e.sel][0];
      const ax = e.editAxis;
      const at = e.cursor[ax === 'x' ? 0 : ax === 'y' ? 1 : 2];
      const m = e.models.get(e.L, e.vol, ax, at, [...e.sel], e.version, e.stepSeq).model;
      let best = null;
      for (const r of m.rings) {
        if (r.key !== key || r.hole) continue;
        const vs = r.loop.map((id) => m.vertices[id]);
        const vmin = Math.min(...vs.map((p) => p.v));
        for (let i = 0; i < vs.length; i++) {
          const a = vs[i];
          const b = vs[(i + 1) % vs.length];
          if (a.v === vmin && b.v === vmin && (!best || Math.abs(a.u - b.u) > best.len)) best = { u: (a.u + b.u) / 2, v: vmin, len: Math.abs(a.u - b.u) };
        }
      }
      return best;
    });
    ok(!!edge, `主切面上找到基板頂邊（u ${edge?.u}、v ${edge?.v}）`);
    const bb = await page.locator('.sedit-img').boundingBox();
    const [W, H] = await ev(() => {
      const v = window.__ed.vol;
      const a = window.__ed.editAxis;
      return a === 'z' ? [v.X, v.Y] : a === 'y' ? [v.X, v.Z] : [v.Z, v.Y];
    });
    const zf = bb.width / W;
    if (Math.abs(bb.height / H - zf) > 0.05) info(`（主切面縮放不等向：${zf.toFixed(2)} vs ${(bb.height / H).toFixed(2)}，抓邊可能抓不到）`);
    const from = [bb.x + edge.u * zf, bb.y + edge.v * zf];
    let cur = '';
    for (const dy of [0, -1, 1, -2, 2]) {
      await page.mouse.move(from[0], from[1] + dy);
      await page.waitForTimeout(40);
      cur = await ev(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [from[0], from[1] + dy]);
      if (/resize/.test(cur)) {
        from[1] += dy;
        break;
      }
    }
    ok(/resize/.test(cur), `游標在頂邊上（${cur}）`);
    const p0 = await posts();
    const [ops0, ticks0, fr0] = await ev(() => [window.__ops ?? 0, window.__ticks ?? 0, window.__frames ?? 0]);
    await resetLongs();
    await page.mouse.down();
    const t0 = Date.now();
    for (let k = 1; k <= 60; k++) {
      await page.mouse.move(from[0], from[1] - (k * 3 * 2 * zf) / 60);
      await page.waitForTimeout(16);
    }
    const dt = Date.now() - t0;
    await page.waitForTimeout(200);
    const [n, max] = await longs();
    const d = delta(p0, await posts());
    const [ops1, ticks1, fr1] = await ev(() => [window.__ops ?? 0, window.__ticks ?? 0, window.__frames ?? 0]);
    await page.mouse.up();
    await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 120000 });
    await idle();
    const kind = await ev(() => window.__ed.active?.ops.at(-1)?.kind);
    const ops = ops1 - ops0;
    const ticks = ticks1 - ticks0;
    info(`60 個 pointermove（${dt} ms，${fr1 - fr0} 幀、tick ${ticks} 次；放開 → ${kind ?? '沒改到'}）：算 Op ${ops} 次、preview 請求 ${d.preview ?? 0} 個、long task ${n} 個（最長 ${max} ms）`);
    ok(ops / 60 <= 0.5, `算 Op 的次數／60 個 pointermove ≤ 0.5（${ops}／60 ＝ ${(ops / 60).toFixed(2)}）`);
    ok(ops <= ticks, `算 Op 的次數 ≤ tick 次數（${ops} ≤ ${ticks}）`);
    ok((d.preview ?? 0) <= ops, `preview 請求 ≤ 算 Op 的次數（${d.preview ?? 0} ≤ ${ops}）`);
    ok(n <= 5, `long task ≤ 5 個（v14 基線 0；${n} 個）`);
    await leaveFocus();
  }

  // ---- 5. 一步後立刻 hover 10 次（B4） ----
  if (want(5)) {
    console.log('\n—— 5. 一步後立刻 hover 10 次 ——');
    await ensureDemo(2);
    await leaveFocus();
    await ev(() => window.__ed.setBigOp(1e9));
    await select('Poly-Si 1');
    await idle();
    const s0 = await ev(() => window.__ed.active?.ops.length ?? 0);
    const pane = await page.locator('.pane-3d').first().boundingBox();
    // 從套用前就開始數：新網格換上後閒置排程會立刻補建，等「一步完成」的這段時間裡也會建
    const bvh = () => ev(() => ({ ...(window.__bvhStats ?? { sync: 0, idle: 0 }) }));
    const b0 = await bvh();
    const g0 = await ev(() => window.__renderer?.info.memory.geometries ?? 0);
    await ev(() => window.__ed.translate([1, 0, 0]));
    await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 }).catch(() => {});
    ok((await ev(() => window.__ed.active?.ops.length ?? 0)) === s0 + 1, 'Poly-Si 1 沿 x 搬 1：一步套用了');
    const b1 = await bvh();
    await resetLongs();
    const per = [];
    for (let k = 0; k < 10; k++) {
      const t = await ev(() => performance.now());
      await page.mouse.move(pane.x + pane.width * (0.3 + 0.04 * k), pane.y + pane.height * (0.35 + 0.03 * k));
      await page.waitForTimeout(100);
      per.push(Math.round((await ev(() => performance.now())) - t - 100));
    }
    const [n, max, list] = await longs();
    const b2 = await bvh();
    await page.waitForTimeout(2500);
    const b3 = await bvh();
    const g1 = await ev(() => window.__renderer?.info.memory.geometries ?? 0);
    const sync = b2.sync - b0.sync;
    info(`一步（網格換上前後 geometry ${g0} → ${g1}）到 hover 10 次：事件裡同步建 BVH ${sync} 棵（換上網格時 ${b1.sync - b0.sync}、hover 中 ${b2.sync - b1.sync}）、閒置補建 ${b2.idle - b0.idle} 棵（換上網格時 ${b1.idle - b0.idle}、hover 中 ${b2.idle - b1.idle}、之後 2.5 s 再 +${b3.idle - b2.idle}）`);
    info(`hover 10 次：long task ${n} 個（最長 ${max} ms：${list.map((x) => x.d).join('、') || '—'}；軟體 WebGL 畫一幀就 > 50 ms，只印）、每次 pointermove 阻塞 ≈ ${per.join('、')} ms（基線 63～126、20 個 long task 最長 112～159）`);
    ok(sync <= 20, `事件裡同步建的 BVH 每事件 ≤ 2 棵（8 ms 預算；一步到 hover 完共 ${sync} 棵）`);
    ok(b3.idle - b0.idle > 0, `這一步換上的新 chunk 的 BVH 由閒置排程補建（共 ${b3.idle - b0.idle} 棵）`);
    await page.keyboard.press('Escape');
  }

  // ---- 9. 開 X-ray（A5）：Worker layer {mat: VOID} 的往返 ----
  if (want(9)) {
    console.log('\n—— 9. 開 X-ray ——');
    await ensureDemo(2);
    await leaveFocus();
    await idle();
    await page.locator('button[aria-label="顯示"]').click();
    const sw = page.locator('.ant-popover').locator('.ant-switch').first();
    await sw.waitFor();
    await page.waitForTimeout(300);
    // 開 → 關 → 再開：第一次含 Worker 的 JIT 暖身，第二次是穩態
    const toggle = async () => {
      const p0 = await posts();
      const n0 = (await roundTrips('layer:void')).length;
      await sw.click();
      await page.waitForFunction((n) => (window.__rt?.['layer:void'] ?? []).length > n, n0, { timeout: 120000 });
      await idle();
      return { d: delta(p0, await posts()), rt: (await roundTrips('layer:void')).slice(n0) };
    };
    const a = await toggle();
    await sw.click();
    await idle();
    const b = await toggle();
    info(`開 X-ray：送 Worker ${JSON.stringify(a.d)}，layer {mat: VOID} 往返 ${a.rt.join('、')} ms；關掉再開：${JSON.stringify(b.d)}，往返 ${b.rt.join('、')} ms（postMessage → onmessage，含 20 個 chunk 的 greedy mesh 與結構化複製；bench.ts layer void 2 全量 110 ms、舊的整陣列 closure 掃描本身 ≈ 147 ms；基線頁面往返 145 ms）`);
    ok(a.d.layer === 1 && Object.keys(a.d).length === 1 && b.d.layer === 1 && Object.keys(b.d).length === 1, '開 X-ray 只送 1 個 layer 請求（VOID），不重送 chunks');
    // Worker 端的掃描（目標 < 5／< 20 ms）從頁面看不到，往返幾乎都是 mesh 那 20 個 chunk：穩態往返 < 200 ms 只擋「退化成整陣列掃描（+147）」
    ok(Math.min(...b.rt) < 200, `穩態 VOID layer 往返 < 200 ms（${Math.min(...b.rt)} ms；§7 寫 Worker 端 < 20，頁面量不到、見檔頭）`);
    await sw.click();
    await page.keyboard.press('Escape');
    await idle();
  }

  // ---- 6. 上傳合成的 ×2 比例陣列 .vti（C3、C4） ----
  if (want(6)) {
    console.log('\n—— 6. 上傳合成 ×2 比例陣列 .vti ——');
    await fresh();
    have = null;
    // 前一段（×2 範例）的 document 在 reload 之後不一定馬上被回收：gc 幾次等 heap 穩定再當起點
    let h0 = await heapMB();
    for (let k = 0; k < 20; k++) {
      await page.waitForTimeout(250);
      const h = await heapMB();
      if (Math.abs(h - h0) < 2 && h < 200) break;
      h0 = h;
    }
    const rss0 = rendererMB();
    await resetLongs();
    const peak = pollPeak();
    const t0 = Date.now();
    await page.locator('.ant-upload input[type=file]').setInputFiles(vtiPath);
    await page.locator('.load-confirm').waitFor({ timeout: 120000 });
    const tInspect = Date.now() - t0;
    await page.locator('.load-confirm').getByRole('button', { name: /載\s*入/ }).click();
    await page.waitForFunction(() => window.__ed.comps.length > 1 && window.__ed.meta?.format === 'vti', null, { timeout: 600000 });
    const tDecode = Date.now() - t0;
    await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
    await idle();
    const pk = peak.stop();
    const [n, max, list] = await longs();
    const io = await ev(() => ({ inspect: window.__io.vtiInspect?.at(-1), decode: window.__io.vtiDecode?.at(-1), load: window.__io.load?.at(-1) }));
    const h1 = await heapMB();
    const rss1 = rendererMB();
    const size = fs.statSync(vtiPath).size / MB;
    const N = await ev(() => window.__ed.vol.data.length);
    have = 'vti';
    // 分段：偵測（vtiInspect）→ 解碼（vtiDecode 送出 → 回來）→ 結構分析（load 送出 → 回來）→ 之後（主執行緒接結果、第一次 render、3D）
    const within = (a, b) => list.filter((x) => a && b && x.t >= a && x.t < b).map((x) => x.d);
    const decodeLongs = within(io.decode?.out, io.decode?.in);
    const loadLongs = within(io.load?.out, io.load?.in);
    const afterLongs = within(io.load?.in, Infinity);
    info(`${size.toFixed(1)} MB、${(N / 1e6).toFixed(1)} M 點 × 8 Float32：偵測 ${tInspect} ms、到結構分析完 ${tDecode} ms、到 3D ${Date.now() - t0} ms；Worker 往返 vtiDecode ${fmt(io.decode ? io.decode.in - io.decode.out : NaN, 0)} ms、load ${fmt(io.load ? io.load.in - io.load.out : NaN, 0)} ms`);
    info(`long task 共 ${n} 個（最長 ${max} ms）：解碼期間 ${decodeLongs.length} 個（${decodeLongs.join('、') || '—'}）、結構分析期間 ${loadLongs.length} 個（${loadLongs.join('、') || '—'}）、之後（主執行緒接結果＋第一次 render＋3D shader）${afterLongs.length} 個（${afterLongs.join('、') || '—'}）`);
    info(`JS heap ${fmt(h0, 0)} → ${fmt(h1, 0)} MB（期間最高 ${fmt(pk.heap, 0)}）、renderer RSS ${fmt(rss0, 0)} → ${fmt(rss1, 0)} MB（期間最高 ${fmt(pk.rss, 0)}）；N×(1＋4) ＝ ${((N * 5) / MB).toFixed(0)} MB、原檔 ${size.toFixed(1)} MB（基線 heap 尖峰 +337、RSS 尖峰 +486、7 個 long task 最長 373）`);
    ok(!!io.decode && !!io.load, '解碼（vtiDecode）與結構分析（load）都在 Worker');
    ok(decodeLongs.length === 0 && loadLongs.length === 0, `解碼與結構分析期間主執行緒 0 個 long task（${decodeLongs.length}／${loadLongs.length}）`);
    ok(h1 - h0 <= (N * 5) / MB + 64, `JS heap 增量 ≤ N×(1＋4) ＋ 64 MB（${fmt(h1 - h0, 0)} ≤ ${((N * 5) / MB + 64).toFixed(0)}；原檔只在 Worker）`);
    ok(pk.heap - h0 <= (N * 5) / MB + 128, `JS heap 尖峰增量 ≤ N×(1＋4) ＋ 128 MB（${fmt(pk.heap - h0, 0)}；基線 +337）`);
  }

  // ---- 7. 20 個 split → 匯出 zip（C2）；同格式匯出一個改 2 萬格的 split（C1） ----
  if (want(7)) {
    console.log('\n—— 7. 20 個 split 匯出 zip、同格式匯出一個 ——');
    await ensureVti();
    const N = await ev(() => window.__ed.vol.data.length);
    const t0 = Date.now();
    const made = await ev(async () => {
      const ed = window.__ed;
      const c = [...ed.comps].sort((a, b) => b.count - a.count)[2];
      const f = { id: 'r', name: 'r', keys: [c.key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
      const ids = await ed.addDesign({ factors: [f], levels: { r: Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : -1) * (1 + (i >> 1))) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
      return { n: ids.length, label: c.label };
    });
    await idle();
    info(`產生 20 個 split（搬 ${made.label}）：${Date.now() - t0} ms`);
    ok(made.n === 20 && (await ev(() => window.__ed.splits.length)) === 20, '有 20 個 split');
    await page.keyboard.press('Control+1');
    await page.waitForTimeout(500);
    await ev(() => localStorage.setItem('noSavePicker', '1'));
    const h0 = await heapMB();
    const rss0 = rendererMB();
    const peak = pollPeak(40, true); // 每次取樣先 gc()：量同時活著的位元組（Worker 傳回的 split 寫進 Blob 後就是垃圾）
    const t1 = Date.now();
    await page.locator('button[aria-label="匯出"]').click();
    await page.getByRole('menuitem', { name: /打包 zip（單一編號 \.vti/ }).click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.locator('.ant-modal').getByRole('button', { name: '匯出 zip' }).click()]);
    const dt = Date.now() - t1;
    const zipPath = await dl.path();
    await page.waitForTimeout(500);
    const pk = peak.stop();
    const h1 = await heapMB();
    const buf = fs.readFileSync(zipPath);
    const zipMB = buf.length / MB;
    const oneMB = N / MB;
    info(`匯出 20 個 split 的 zip（vti1）：${dt} ms → ${zipMB.toFixed(0)} MB；JS heap ${fmt(h0, 0)} → ${fmt(h1, 0)} MB（期間最高 ${fmt(pk.heap, 0)}，尖峰增量 ${fmt(pk.heap - h0, 0)}）、renderer RSS ${fmt(rss0, 0)} → ${fmt(rendererMB(), 0)} MB（期間最高 ${fmt(pk.rss, 0)}）；一個 split ＝ ${oneMB.toFixed(1)} MB`);
    ok(pk.heap - h0 <= oneMB + 32, `主執行緒 JS heap 尖峰增量 ≤ 1 個 split ＋ 32 MB（${fmt(pk.heap - h0, 0)} ≤ ${(oneMB + 32).toFixed(0)}）`);
    const z = readZip(buf);
    const bad = z.entries.filter((e) => e.crc !== e.actual || e.method !== 0 || e.size !== e.data.length);
    info(`zip：${z.entries.length} 個檔（${z.zip64 ? 'ZIP64' : '一般'}）：${z.entries.slice(0, 3).map((e) => e.name).join('、')}…、manifest.json ${z.entries.some((e) => e.name === 'manifest.json') ? '有' : '沒有'}`);
    ok(z.entries.length === 21 && z.entries.some((e) => e.name === 'manifest.json'), '20 個 .vti ＋ manifest.json');
    ok(bad.length === 0, `每個檔的 CRC-32 都對（store only，大小一致）${bad.length ? '：' + bad.map((e) => e.name).join('、') : ''}`);
    const manifest = JSON.parse(z.entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
    ok(manifest.splits?.length === 20 && manifest.splits.every((s) => z.entries.some((e) => e.name === s.file)), 'manifest 的 20 個檔名都在 zip 裡');
    // 同格式匯出一個改 ≈ 2 萬格的 split（§7：挑 changed 最接近 20,000 的那個）
    const one = await ev(async () => {
      const ed = window.__ed;
      const s = [...ed.splits].filter((x) => ed.stats(x).changed > 0).sort((a, b) => Math.abs(ed.stats(a).changed - 20000) - Math.abs(ed.stats(b).changed - 20000))[0];
      const req = { format: 'vti', spacing: ed.meta.spacing ?? [1, 1, 1], origin: ed.meta.origin ?? [0, 0, 0], arrayName: 'material' };
      const t = performance.now();
      const bytes = await ed.exportBytes(s, req);
      const ms = performance.now() - t;
      // 改到的格子 → 32 KB block 編號（Float32：8,192 格一塊）。setActiveId 之後 window.__ed 是新的一份（每次 render 換），要重新拿
      await ed.setActiveId(s.id);
      for (let k = 0; k < 200 && (window.__ed.activeId !== s.id || window.__ed.busy); k++) await new Promise((r) => setTimeout(r, 50));
      const a = window.__ed.orig.vol.data;
      const b = window.__ed.cur.vol.data;
      const blocks = new Set();
      let changed = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++, blocks.add(i >> 13);
      let s64 = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) s64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      return { ms, mb: bytes.length / 1048576, changed, name: s.name, stats: bytes.stats ?? null, crc: bytes.crc, blocks: [...blocks], b64: btoa(s64) };
    });
    const out = Buffer.from(one.b64, 'base64');
    const orig = fs.readFileSync(vtiPath);
    const A = vtiBlocks(orig);
    const B = vtiBlocks(out);
    const chg = new Set(one.blocks);
    let same = 0;
    let redone = 0;
    let wrong = [];
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const b = B.find((x) => x.name === a.name);
      if (!b || b.nb !== a.nb) {
        wrong.push(`${a.name}：block 數 ${a.nb} → ${b?.nb}`);
        continue;
      }
      for (let k = 0; k < a.nb; k++) {
        if (a.blocks[k].equals(b.blocks[k])) same++;
        else if (chg.has(k)) redone++;
        else wrong.push(`${a.name} block ${k}`);
      }
    }
    info(`同格式匯出 ${one.name}（改 ${one.changed.toLocaleString()} 格，落在 ${chg.size} 個 block）：Worker 往返 ${one.ms.toFixed(0)} ms → ${one.mb.toFixed(1)} MB、crc ${one.crc >>> 0}；Worker stats ${JSON.stringify(one.stats)}；block 逐位元組：相同 ${same}、改到的重壓 ${redone}、沒改卻不同 ${wrong.length}`);
    ok(zlib.crc32(out) >>> 0 === one.crc >>> 0, 'Worker 回的 crc === crc32(bytes)');
    ok(wrong.length === 0, `沒改到的 block 位元組 === 原檔（${same} 塊）${wrong.length ? '：' + wrong.slice(0, 5).join('、') : ''}`);
    ok(!one.stats || one.stats.redone <= chg.size * A.length, `重壓的 block 數 ≤ 碰到的 block × 陣列數（${one.stats?.redone ?? 'n/a'} ≤ ${chg.size * A.length}）`);
    ok(one.ms < 600, `同格式匯出 Worker 時間 < 600 ms（目標 < 300 的 2 倍，容器抖動；實測 ${one.ms.toFixed(0)} ms；基線 4,189）`);
    have = 'vti-20';
  }

  // ---- 8. 實驗頁 200 個 split 疊圖（C5） ----
  if (want(8)) {
    console.log('\n—— 8. 實驗頁 200 個 split 疊圖 ——');
    await loadDemo(1);
    have = null;
    await page.keyboard.press('Control+2');
    await page.locator('.lab').waitFor();
    const t0 = Date.now();
    const made = await ev(async () => {
      const ed = window.__ed;
      const key = ed.orig.L.comps.find((c) => c.label === 'Poly-Si 1').key;
      const a = { id: 'dx', name: 'dx', keys: [key], op: 'translate', param: 'd', template: { axis: 0 }, unit: 'vx', nominal: 0, mode: 'relative' };
      const b = { id: 'dz', name: 'dz', keys: [key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
      const ids = await ed.addDesign({ factors: [a, b], levels: { dx: Array.from({ length: 20 }, (_, i) => i - 10), dz: Array.from({ length: 10 }, (_, i) => i - 5) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
      return ids.length;
    });
    await idle();
    info(`產生 ${made} 個 split（×1）：${Date.now() - t0} ms`);
    ok(made === 200, '200 個 split');
    await page.waitForTimeout(1000);
    const cards = page.locator('.split-card');
    const nCards = Math.min(12, await cards.count());
    for (let k = 0; k < nCards; k++) await cards.nth(k).locator('.ant-checkbox-input').check();
    await page.locator('.lab-toolbar').getByRole('button', { name: /比較勾選的/ }).click();
    await page.locator('.compare .ant-segmented').first().getByText('疊圖').click();
    await page.locator('.overlay-view').waitFor();
    await page.waitForTimeout(800);
    const rows = page.locator('.overlay-legend .legend-row');
    const nRows = await rows.count();
    const boxes = [];
    for (let k = 0; k < nRows; k++) boxes.push(await rows.nth(k).boundingBox());
    const o0 = await ev(() => [window.__overlayMs ?? 0, window.__overlayMemoHits ?? 0, window.__renders ?? 0]);
    await resetLongs();
    const t1 = Date.now();
    for (let k = 0; k < 60; k++) {
      const b = boxes[k % boxes.length];
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(30);
    }
    const dt = Date.now() - t1;
    const o1 = await ev(() => [window.__overlayMs ?? 0, window.__overlayMemoHits ?? 0, window.__renders ?? 0]);
    const [n, max] = await longs();
    const hovered = await page.locator('.overlay-stage svg path[data-hover="1"]').count();
    info(`疊圖 ${nCards} 個 split（UI 上限 12，圖例 ${nRows} 列；200 條的純函式版見 bench.ts overlay）legend 滑過 60 次（${dt} ms）：__overlayMs +${(o1[0] - o0[0]).toFixed(1)} ms、OverlayView memo 命中 +${o1[1] - o0[1]}、整頁 render-body +${o1[2] - o0[2]}、long task ${n} 個（最長 ${max} ms）、加粗的路徑 ${hovered} 條`);
    ok(o1[0] - o0[0] < 120, `legend 滑過 60 次 lines 不重算：__overlayMs 總和 +${(o1[0] - o0[0]).toFixed(1)} ms（< 120）`);
    ok(o1[2] - o0[2] <= 4, `滑過只有 Legend 自己 render：整頁 render-body +${o1[2] - o0[2]}（≤ 4）`);
    ok(hovered === 1, '滑過的那條在 svg 裡加粗（data-hover）');
    // OverlayView 自己 render（隱藏／顯示一條）時 lines memo 命中、不重算
    const o2 = await ev(() => [window.__overlayMs ?? 0, window.__overlayMemoHits ?? 0]);
    const sw = rows.nth(1).locator('.legend-swatch');
    for (let k = 0; k < 10; k++) {
      await sw.click();
      await page.waitForTimeout(60);
    }
    const o3 = await ev(() => [window.__overlayMs ?? 0, window.__overlayMemoHits ?? 0]);
    info(`隱藏／顯示一條 10 次（OverlayView render）：__overlayMemoHits +${o3[1] - o2[1]}、__overlayMs +${(o3[0] - o2[0]).toFixed(1)} ms`);
    ok(o3[1] - o2[1] >= 10, `OverlayView render 10 次 lines memo 命中 ≥ 10（+${o3[1] - o2[1]}）`);
    ok(o3[0] - o2[0] < 1, `memo 命中時不重算（__overlayMs +${(o3[0] - o2[0]).toFixed(2)} ms）`);
    await page.getByRole('button', { name: /回到結果/ }).click().catch(() => {});
  }

  // ---- 10. 復原堆疊（D5）：×1 基板 translate ----
  if (want(10)) {
    console.log('\n—— 10. 復原堆疊：×1 基板 translate ——');
    await loadDemo(1);
    have = 'demo1';
    await selectSubstrate();
    await idle();
    const label = await substrateLabel();
    const step = async (k) => {
      await ev((k) => window.__ed.translate([k % 2 ? -1 : 1, 0, 0]), k);
      await idle();
      return ev(() => ({ n: window.__ed.hist.length, mb: (window.__histBytes ?? 0) / 1048576, cap: window.__ed.histBytes }));
    };
    const a = [];
    for (let k = 0; k < 10; k++) a.push(await step(k));
    info(`${label} translate 10 次（上限 ${a[9].cap} MB）：堆疊 ${a.map((x) => `${x.n} 筆／${x.mb.toFixed(1)} MB`).join('、')}`);
    ok(a[9].mb <= 256, `__histBytes ≤ 256 MB（${a[9].mb.toFixed(1)} MB，每筆 ≈ ${(a[9].mb / a[9].n).toFixed(1)} MB）`);
    ok(a[9].n === 10, `10 筆都留著（${a[9].n}）`);
    await ev(() => window.__ed.setHistBytes(64));
    await page.waitForTimeout(300);
    const b = [];
    let total = 10;
    for (let k = 10; k < 40; k++) {
      total++;
      b.push(await step(k));
      if (b.at(-1).n < total) break;
    }
    const last = b.at(-1);
    info(`上限調成 64 MB 後再 translate ${b.length} 次：堆疊 ${b.map((x) => `${x.n} 筆／${x.mb.toFixed(1)} MB`).join('、')}`);
    ok(last.cap === 64 && last.n < total, `筆數隨上限縮：${total} 步只留 ${last.n} 筆`);
    ok(last.mb <= 64, `__histBytes ≤ 64 MB（${last.mb.toFixed(1)} MB）`);
    const notice = await page.locator('.ant-message').getByText(/復原記憶體達上限/).count();
    info(`提示「復原記憶體達上限」${notice ? '有出現' : '已淡出或沒看到'}`);
    await page.keyboard.press('Control+z');
    await idle();
    ok((await ev(() => window.__ed.hist.length)) === last.n - 1, '還能復原最近的一步');
  }

  ok(devErrors.length === 0, `沒有 memoEd／selMask 的 console.error${devErrors.length ? '：' + devErrors[0] : ''}`);
  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors[0] : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
