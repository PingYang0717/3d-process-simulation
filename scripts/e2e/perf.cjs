// 端到端速度（plan v7 §8.6、M1 驗收）：大範例上「長高 1 格」從按下到 3D 更新完（.mesh-busy 消失）的時間。
// plan v10：標題列「長高」→ 右欄「長／縮」卡片（格數 1、預設往上）的「套用」；進 2D 剖面＝按兩下 E；
// 節點要從角的外側抓（見下方 grabNode）。
// 用法：先 `npm run dev`，再 `node scripts/e2e/perf.cjs [url] [scale=2] [截圖資料夾] [--v15]`
// plan v15 M15.0：最後多一段 §3／§7 e2e 1～9 的量測版（拖欄寬、換 cursor、一步後 hover、2D 拖基板頂邊、實驗頁 200 個 split 疊圖 legend、
// 上傳合成 ×scale 比例陣列 .vti、20 個 split 打包 zip、X-ray 的 Worker 往返），只印不斷言；DEV 計數器有就讀、沒有印 n/a。
// Chromium 要 --enable-precise-memory-info 才有 performance.memory；ArrayBuffer 不算在 usedJSHeapSize 裡，另讀 renderer 的 RSS（ps）。
const { chromium } = require('playwright');

const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const url = argv[0] || 'http://localhost:5173';
const scale = Number(argv[1] || 2);
const shots = argv[2] || null;
/** --v15：只跑 plan v15 M15.0 那一段（舊段落的卡片／抓節點流程在不同版面可能要調）。 */
const v15Only = process.argv.includes('--v15');
/**
 * --only=1,2,…：v15 段只跑這幾節。這裡的編號是量測時的順序，和 plan §7 e2e 的編號不同：
 * 1 拖欄寬（§7 的 3）、2 換 cursor（§7 的 2）、3 一步後 hover（§7 的 5，--only=5 也跑）、4 2D 拖基板（§7 的 4）、6 上傳、7 匯出、8 實驗頁、9 X-ray（和 §7 相同）；
 * §7 的 1（選基板連做 5 步）與 10（復原堆疊）只在驗收版 m15.cjs。
 */
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const want = (n) => !only.length || only.includes(n);

/**
 * 合成 ×scale 比例陣列 .vti（plan v15 §7 e2e 6）：和 demoVolume 同尺寸的簡化版（基板、STI、三根 fin、三個閘極＋SiN 蓋、fin 旁兩層襯層、幾個空洞），
 * PointData 8 個 Float32（material_1～7、material_254）one-hot，zlib、appended raw、UInt32 header、32 KB 一塊。寫到暫存目錄，已有就直接用。
 */
function synthVtiFile(scale) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const zlib = require('zlib');
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

(async () => {
  const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192 --expose-gc', '--enable-precise-memory-info'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Worker 訊息計數（plan v9 §6.2：每一步只送 apply＋chunks＋（有選取時）layer）
  await page.addInitScript(() => {
    window.__posts = {};
    // plan v15：每個請求的往返時間（postMessage → onmessage，含 Worker 佇列）；layer {mat} 另記成 layer:void
    window.__rt = {};
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
            (window.__rt[p.key] ||= []).push(performance.now() - p.t);
          }
          return fn.call(this, e);
        });
      },
    });
    // rAF 回呼數與幀數（同一幀的回呼 timestamp 相同）
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
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        window.__long++;
        window.__longMax = Math.max(window.__longMax, e.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  const posts = () => page.evaluate(() => ({ ...window.__posts }));
  const delta = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => (b[k] || 0) !== (a[k] || 0)).map((k) => [k, b[k] - (a[k] || 0)]));
  const measureLongs = async (fn) => {
    await page.evaluate(() => ((window.__long = 0), (window.__longMax = 0)));
    await fn();
    return page.evaluate(() => [window.__long, Math.round(window.__longMax)]);
  };
  await page.goto(url);
  if (!v15Only) {
    // plan v11 §8：舊腳本照 v10 行為跑——進階開關（自由形變、筆刷）打開、推面蓋過去
    await page.evaluate(() => { localStorage.clear(); localStorage.setItem('se3d.v1.freeform', 'true'); localStorage.setItem('se3d.v1.brushOn', 'true'); localStorage.setItem('se3d.v1.pushPolicy', '"overwrite"'); });
    await page.reload();
    const t0 = Date.now();
    await page.getByRole('button', { name: scale === 1 ? /用範例試試看/ : new RegExp(`大範例 ×${scale}`) }).click();
    await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
    await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 });
    console.log(`載入＋第一次網格：${Date.now() - t0} ms`);
    await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
    await page.waitForTimeout(1500);
    const card = page.locator('.inspector .op-card').first();
    await card.scrollIntoViewIfNeeded();
    await card.getByLabel('格數').fill('1');
    await page.mouse.click(5, 5); // 收掉卡片預覽，計時只算「套用」
    await page.waitForTimeout(500);
    const apply = card.locator('button.ant-btn-primary');
    const times = [];
    const js = [];
    let p0posts = await posts();
    for (let k = 0; k < 4; k++) {
      const t = Date.now();
      const p0 = await page.evaluate(() => performance.now());
      await apply.click();
      // 換上正式網格的那一刻（JS 時間，不含 headless 軟體繪圖把畫面畫出來的時間）
      const m = await page.waitForFunction((p) => { const m = window.__meshAt; return m && m.t > p ? m : null; }, p0, { timeout: 120000, polling: 16 }).then((h) => h.jsonValue());
      js.push(`${(m.t - p0).toFixed(0)}（${m.full ? '全部' : m.n} 個 chunk）`);
      await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 120000 });
      times.push(Date.now() - t);
      await page.waitForTimeout(800);
    }
    const grown = await page.evaluate(() => window.__ed.active?.ops.map((o) => `${o.kind}${o.dir}:${o.n}`) ?? []);
    if (grown.length !== 4 || !grown.every((o) => o === 'push0,-1,0:1')) {
      console.log(`✗ 「長／縮」卡片套用 4 次應該是 4 步往上 1 格：${grown.join('、')}`);
      process.exitCode = 1;
    }
    console.log(`長高 1 格，按下 → 換上正式網格（JS）：${js.join('、')} ms`);
    console.log(`  4 步送 Worker 的請求：${JSON.stringify(delta(p0posts, await posts()))}`);
    console.log(`長高 1 格，按下 → 畫面不再顯示「更新 3D 中」：${times.join('、')} ms（headless 軟體繪圖很慢，只供參考）`);
    // B 切原始再切回 20 次：第二次起都從主執行緒快取換上，不送 chunks；geometry 數不漲（plan v9 M9.3）
    {
      const geos = () => page.evaluate(() => window.__renderer?.info.memory.geometries ?? -1);
      const g0 = await geos();
      const q0 = await posts();
      let g2 = 0;
      const [n, max] = await measureLongs(async () => {
        for (let k = 0; k < 20; k++) {
          await page.keyboard.press('b');
          await page.waitForTimeout(250);
          await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 120000 });
          if (k === 1) g2 = await geos();
        }
      });
      const d = delta(q0, await posts());
      console.log(`B 切 20 次：送 Worker ${JSON.stringify(d)}（chunks ≤ 1 次＝只有第一次看原始）；geometry ${g0} →（2 次後）${g2} →（20 次後）${await geos()}；long task ${n} 個（最長 ${max} ms）`);
    }
    // 整個網格換掉（隱藏一個材質＝新畫法，全量）：主執行緒不再同步建幾百棵 BVH
    {
      const [n, max] = await measureLongs(async () => {
        await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click({ button: 'right' }).catch(() => {});
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__ed.toggleHidden(5));
        await page.waitForFunction(() => window.__meshAt && window.__meshAt.full, null, { timeout: 120000 });
        await page.waitForTimeout(300);
        await page.evaluate(() => window.__ed.toggleHidden(5));
        await page.waitForTimeout(300);
        await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 120000 });
      });
      console.log(`整個網格換上（隱藏／顯示一個材質）：long task ${n} 個（最長 ${max} ms）`);
    }
    // 復原：主執行緒原地貼補丁；上一個版本的網格在快取裡就直接換上（不一定會出現「更新 3D 中」）
    const pu = await page.evaluate(() => performance.now());
    await page.keyboard.press('Control+z');
    const mu = await page.waitForFunction((p) => { const m = window.__meshAt; return m && m.t > p ? m : null; }, pu, { timeout: 120000, polling: 16 }).then((h) => h.jsonValue());
    console.log(`復原 → 換上網格（JS）：${(mu.t - pu).toFixed(0)} ms（${mu.n ? `${mu.n} 個 chunk` : '快取'}）`);
    if (shots) await page.screenshot({ path: `${shots}/perf-x${scale}.png` });

    // 2D 拖拉（plan v8 §8.4）：Si fin 1 進 2D 編輯，拖右上節點 60 步；記 long task（> 50 ms）數，
    // 拖拉中 3D 小窗有沒有即時變化（截圖比對）
    await page.locator('.item-name', { hasText: /^Si fin 1$/ }).click();
    await page.waitForTimeout(500);
    // 剖面打開（沿 z、在十字那一片）：拖拉中每幀不重建貼圖物件，只在預覽碰到剖口那一片時重畫（plan v9 P9）
    await page.getByRole('button', { name: '剖面', exact: true }).click();
    await page.waitForTimeout(500);
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__ed.focus?.view === '3d');
    await page.keyboard.press('e');
    await page.locator('.main-slice').waitFor();
    await page.waitForTimeout(1500);
    await page.addStyleTag({ content: '.float-tb { display: none !important; }' });
    const node = await page.evaluate(() => {
      const e = window.__ed;
      const m = e.models.get(e.L, e.vol, 'z', e.cursor[2], [...e.sel], e.version, e.stepSeq).model;
      let best = null;
      for (const id of m.handles) {
        const p = m.vertices[id];
        // 右上角：最上面、再最右邊的節點
        if (!best || p.v < best.v || (p.v === best.v && p.u > best.u)) best = p;
      }
      return [best.u, best.v];
    });
    // 主切面上滑鼠移動 60 次（不按）：整頁 render 次數（plan v9 P7：目標 0）
    {
      const sb = await page.locator('.sedit-img').boundingBox();
      const r0 = await page.evaluate(() => window.__renders);
      for (let k = 0; k < 60; k++) {
        await page.mouse.move(sb.x + 10 + ((k * 7) % Math.max(20, sb.width - 20)), sb.y + 10 + ((k * 5) % Math.max(20, sb.height - 20)));
        await page.waitForTimeout(8);
      }
      console.log(`主切面上滑鼠移動 60 次：整頁 render ${(await page.evaluate(() => window.__renders)) - r0} 次`);
    }
    const b = await page.locator('.sedit-img').boundingBox();
    const W = await page.evaluate(() => window.__ed.vol.X);
    const z = b.width / W;
    /**
     * 抓節點：v10 hitTest 節點與邊比「距離／半徑」（都是 6 px），相鄰邊的線段通到節點，游標不是剛好在節點上時幾乎都抓到邊；
     * 從節點開始往外（上方）一點一點偏，直到游標變成角的游標（nwse／nesw-resize）。
     */
    const grabNode = async (x, y) => {
      for (const [dx, dy] of [[0, 0], [0, -2], [1, -2], [2, -2], [-1, -2], [2, -1], [0, -3], [3, -3], [-2, -2]]) {
        await page.mouse.move(x + dx, y + dy);
        await page.waitForTimeout(30);
        const cur = await page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, [x + dx, y + dy]);
        if (/nwse|nesw/.test(cur)) return [x + dx, y + dy];
      }
      console.log('（找不到抓得到節點的位置，照原座標拖）');
      return [x, y];
    };
    const from = await grabNode(b.x + node[0] * z, b.y + node[1] * z);
    await page.evaluate(() => ((window.__long = 0), (window.__longMax = 0)));
    const cap0 = await page.evaluate(() => [window.__capTex || 0, window.__capDraw || 0]);
    const pane = page.locator('.pane-3d').first();
    const shot0 = await pane.screenshot();
    await page.mouse.move(from[0], from[1]);
    await page.waitForTimeout(100);
    const grabCursor = await page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, from);
    await page.mouse.down();
    const t2 = Date.now();
    for (let k = 1; k <= 60; k++) {
      await page.mouse.move(from[0], from[1] - (k * 3 * scale * z) / 60);
      await page.waitForTimeout(16);
    }
    const dragMs = Date.now() - t2;
    await page.waitForTimeout(300);
    const shot1 = await pane.screenshot();
    if (shots) await page.screenshot({ path: `${shots}/perf-drag-x${scale}.png` });
    const [longs, longMax] = await page.evaluate(() => [window.__long, Math.round(window.__longMax)]);
    await page.mouse.up();
    await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 120000 });
    const kind = await page.evaluate(() => window.__ed.active?.ops.at(-1)?.kind);
    const cap1 = await page.evaluate(() => [window.__capTex || 0, window.__capDraw || 0]);
    console.log(`剖面開著拖拉 60 步：新建貼圖 ${cap1[0] - cap0[0]} 次、重畫剖口 ${cap1[1] - cap0[1]} 次`);
    if (!/nwse|nesw/.test(grabCursor)) {
      console.log(`✗ 按下時游標是 ${grabCursor}，抓到的不是節點`);
      process.exitCode = 1;
    }
    console.log(`2D 拖拉節點 60 步（${kind}）：${dragMs} ms、long task ${longs} 個（最長 ${longMax} ms）；拖拉中 3D 小窗${shot0.equals(shot1) ? '沒有變化' : '有即時變化'}`);
  }

  // ---- plan v15 M15.0：§3／§7 e2e 1～9 的量測版（只印不斷言）。DEV 計數器（__selMaskMs、__diffBoxMs、__handleBuilds、__bvhBuilds、__ops、
  // __overlayMemoHits、__histBytes、__renders[元件]）要等 M15.x 在 src 裡掛；這裡有就讀、沒有就印 n/a。 ----
  const v15 = async () => {
    console.log('\n—— plan v15 M15.0 基線 ——');
    const dev = async (name) => {
      const v = await page.evaluate((n) => window[n], name);
      return v === undefined ? 'n/a' : typeof v === 'object' ? JSON.stringify(v) : v;
    };
    const heapMB = async () => {
      const h = await page.evaluate(() => (window.gc?.(), performance.memory?.usedJSHeapSize ?? -1));
      return h < 0 ? NaN : h / 1048576;
    };
    /** Chromium renderer 的 RSS（MB）：usedJSHeapSize 不含 ArrayBuffer 的後備儲存，匯出／上傳的尖峰要看這個。取最大的那個 renderer。 */
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
    const pollPeak = (ms = 50) => {
      let heap = 0;
      let rss = 0;
      const h = setInterval(() => {
        page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0).then((x) => (heap = Math.max(heap, x / 1048576))).catch(() => {});
        rss = Math.max(rss, rendererMB());
      }, ms);
      return { stop: () => (clearInterval(h), { heap, rss }) };
    };
    const idle = async () => {
      await page.waitForFunction(() => !document.querySelector('.busy-bar') && !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 300000 }).catch(() => {});
      await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 }).catch(() => {});
      await page.waitForTimeout(400);
    };
    const loadDemo = async (s) => {
      await page.evaluate((s) => window.__ed.demo(s), s);
      await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 3'), null, { timeout: 300000 });
      await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
      await idle();
    };
    const keyOf = (label) => page.evaluate((label) => window.__ed.comps.find((c) => c.label === label).key, label);
    const select = (label) => page.evaluate((label) => window.__ed.selectKeys([window.__ed.comps.find((c) => c.label === label).key]), label);
    const renders = () => page.evaluate(() => window.__renders ?? 0);
    const frames3d = () => page.evaluate(() => window.__renderer?.info.render.frame ?? 0);
    const rafs = () => page.evaluate(() => [window.__rafs ?? 0, window.__frames ?? 0]);
    const longs = () => page.evaluate(() => [window.__long, Math.round(window.__longMax)]);
    const resetLongs = () => page.evaluate(() => ((window.__long = 0), (window.__longMax = 0)));
    const roundTrips = (type) => page.evaluate((t) => (window.__rt?.[t] ?? []).map((x) => Math.round(x)), type);

    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => window.__ed);
    await loadDemo(scale);

    // 1. 拖左欄寬 60 個 pointermove（B2）：Resizer 沒有 rAF，每個原始 pointermove 都整頁 render＋renderer.setSize
    if (want(1)) {
      const rz = page.locator('.resizer[aria-label="左欄寬度"]');
      const bb = await rz.boundingBox();
      const x0 = bb.x + bb.width / 2;
      const y0 = bb.y + bb.height / 2;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      const r0 = await renders();
      const f0 = await frames3d();
      await resetLongs();
      const t0 = Date.now();
      for (let k = 1; k <= 60; k++) {
        await page.mouse.move(x0 + (k % 2 ? 2 : -2) + Math.floor(k / 2), y0);
        await page.waitForTimeout(8);
      }
      const dt = Date.now() - t0;
      const [n, max] = await longs();
      const r1 = await renders();
      const f1 = await frames3d();
      await page.mouse.up();
      console.log(`1. 拖左欄寬 60 個 pointermove（${dt} ms）：整頁 render ${r1 - r0} 次、3D 重畫 ${f1 - f0} 幀、long task ${n} 個（最長 ${max} ms）｜__renders 分元件 ${await dev('__rendersBy')}`);
      await page.waitForTimeout(300);
    }

    // 2. 換 cursor 20 次（B1）：whole 模式下 scope 身分換新 → 選取層 layer 請求、把手重建、整頁 render
    if (want(2)) {
      await select('Poly-Si 1');
      await page.waitForTimeout(600);
      await page.keyboard.press('e'); // 聚焦編輯（3D 把手）
      await page.waitForFunction(() => window.__ed.focus, null, { timeout: 10000 }).catch(() => {});
      await idle();
      const p0 = await posts();
      const r0 = await renders();
      const hb0 = await dev('__handleBuilds');
      await resetLongs();
      const t0 = Date.now();
      for (let k = 0; k < 20; k++) {
        await page.evaluate((k) => {
          const ed = window.__ed;
          const c = ed.cursor;
          ed.setCursor([c[0], c[1], Math.max(0, Math.min(ed.vol.Z - 1, c[2] + (k % 2 ? 1 : -1)))]);
        }, k);
        await page.waitForTimeout(120);
      }
      await idle();
      const dt = Date.now() - t0;
      const [n, max] = await longs();
      const d = delta(p0, await posts());
      console.log(
        `2. 換 cursor 20 次（setCursor，${dt} ms）：送 Worker ${JSON.stringify(d)}（layer ${d.layer ?? 0} 次）、整頁 render ${(await renders()) - r0} 次、long task ${n} 個（最長 ${max} ms）｜__handleBuilds ${hb0} → ${await dev('__handleBuilds')}`,
      );
    }

    // 3. 一步後立刻 hover 10 次（B4）：碰到的 chunk 是沒 BVH 的新 geometry，hover handler 裡同步建 MeshBVH。
    //    這段在 plan §7 的 e2e 編號是 5（M15.7：--only=5 也跑這段；驗收版在 m15.cjs 第 5 段）
    if (want(3) || want(5)) {
      await page.evaluate(() => window.__ed.push([0, -1, 0], 1));
      await idle();
      const pane = await page.locator('.pane-3d').first().boundingBox();
      await resetLongs();
      const b0 = await dev('__bvhBuilds');
      const per = [];
      for (let k = 0; k < 10; k++) {
        const t = await page.evaluate(() => performance.now());
        await page.mouse.move(pane.x + pane.width * (0.3 + 0.04 * k), pane.y + pane.height * (0.35 + 0.03 * k));
        await page.waitForTimeout(100);
        per.push(Math.round((await page.evaluate(() => performance.now())) - t - 100));
      }
      const [n, max] = await longs();
      console.log(`3. 一步後 hover 10 次：long task ${n} 個（最長 ${max} ms）；每次 pointermove 到下一次可量的時間差（扣掉 100 ms 等待）${per.join('、')} ms｜__bvhBuilds ${b0} → ${await dev('__bvhBuilds')}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // 4. 2D 拖基板頂邊 60 步（B3）：每幀 tick() 重算 Op → 第 1 級 previewOp → 第 2 級 Worker preview
    if (want(4)) {
      await page.evaluate(() => window.__ed.clearSel());
      // 沿 z 切、關掉自動放大：主切面就是整片，頁面座標 ＝ 圖框 ＋ (u, v) × 縮放（否則 editAxis 會自動挑、畫面裁到選取外框）
      await page.evaluate(() => (window.__ed.setAutoZoom(false), window.__ed.setEditAxis('z')));
      await page.evaluate(() => window.__ed.selectKeys([window.__ed.comps.reduce((a, c) => (c.count > a.count ? c : a)).key]));
      await page.waitForTimeout(600);
      if (!(await page.evaluate(() => window.__ed.focus))) {
        await page.keyboard.press('e');
        await page.waitForFunction(() => window.__ed.focus?.view === '3d', null, { timeout: 10000 }).catch(() => {});
      }
      await page.keyboard.press('e');
      await page.locator('.main-slice').waitFor({ timeout: 10000 });
      await page.waitForTimeout(1200);
      await page.addStyleTag({ content: '.float-tb { display: none !important; }' });
      // 基板那一環的頂邊：v 最小的相鄰兩個頂點，抓中點
      const edge = await page.evaluate(() => {
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
      const bb = await page.locator('.sedit-img').boundingBox();
      const [W, H] = await page.evaluate(() => {
        const v = window.__ed.vol;
        const a = window.__ed.editAxis;
        return a === 'z' ? [v.X, v.Y] : a === 'y' ? [v.X, v.Z] : [v.Z, v.Y];
      });
      const zf = bb.width / W;
      if (Math.abs(bb.height / H - zf) > 0.05) console.log(`   （主切面縮放不等向：${zf.toFixed(2)} vs ${(bb.height / H).toFixed(2)}，抓邊可能抓不到）`);
      const from = [bb.x + edge.u * zf, bb.y + edge.v * zf];
      let cur = '';
      for (const dy of [0, -1, 1, -2, 2]) {
        await page.mouse.move(from[0], from[1] + dy);
        await page.waitForTimeout(40);
        cur = await page.evaluate(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [from[0], from[1] + dy]);
        if (/resize/.test(cur)) {
          from[1] += dy;
          break;
        }
      }
      const p0 = await posts();
      const [ra0, fr0] = await rafs();
      const ops0 = await dev('__ops');
      await resetLongs();
      await page.mouse.down();
      const t0 = Date.now();
      for (let k = 1; k <= 60; k++) {
        await page.mouse.move(from[0], from[1] - (k * 3 * scale * zf) / 60);
        await page.waitForTimeout(16);
      }
      const dt = Date.now() - t0;
      await page.waitForTimeout(200);
      const [n, max] = await longs();
      const d = delta(p0, await posts());
      const [ra1, fr1] = await rafs();
      const ra = ra1 - ra0;
      const fr = fr1 - fr0;
      await page.mouse.up();
      await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 120000 });
      const kind = await page.evaluate(() => window.__ed.active?.ops.at(-1)?.kind);
      console.log(
        `4. 2D 拖基板頂邊 60 步（游標 ${cur}，放開 → ${kind ?? '沒改到：預設 pushPolicy 停在 STI'}；基板整根超過 LIVE_PREVIEW_CAP 所以只有第 1 級、沒有 Worker preview）：${dt} ms、${fr} 幀（rAF 回呼 ${ra} 個；每幀 ≈ ${(dt / Math.max(1, fr)).toFixed(1)} ms）、preview 請求 ${d.preview ?? 0} 個、long task ${n} 個（最長 ${max} ms）｜__ops ${ops0} → ${await dev('__ops')}`,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // 8. 實驗頁 200 個 split 疊圖，legend 滑過 60 次（C5）。UI 一次最多比 COMPARE_MAX = 12 個，所以疊 12 條（總共 200 個 split 都在）；
    //    200 條的純函式版在 bench.ts overlay。
    if (want(8)) {
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForFunction(() => window.__ed);
      await loadDemo(1);
      await page.keyboard.press('Control+2');
      await page.locator('.lab').waitFor();
      const t0 = Date.now();
      const made = await page.evaluate(async () => {
        const ed = window.__ed;
        const key = ed.orig.L.comps.find((c) => c.label === 'Poly-Si 1').key;
        const a = { id: 'dx', name: 'dx', keys: [key], op: 'translate', param: 'd', template: { axis: 0 }, unit: 'vx', nominal: 0, mode: 'relative' };
        const b = { id: 'dz', name: 'dz', keys: [key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
        const ids = await ed.addDesign({ factors: [a, b], levels: { dx: Array.from({ length: 20 }, (_, i) => i - 10), dz: Array.from({ length: 10 }, (_, i) => i - 5) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
        return ids.length;
      });
      await idle();
      console.log(`8. 實驗頁產生 ${made} 個 split（×1）：${Date.now() - t0} ms`);
      await page.waitForTimeout(1000);
      const cards = page.locator('.split-card');
      const nCards = Math.min(12, await cards.count());
      for (let k = 0; k < nCards; k++) await cards.nth(k).locator('.ant-checkbox-input').check();
      await page.locator('.lab-toolbar').getByRole('button', { name: /比較勾選的/ }).click();
      await page.locator('.compare .ant-segmented').first().getByText('疊圖').click();
      await page.locator('.overlay-view').waitFor();
      await page.waitForTimeout(500);
      const rows = page.locator('.overlay-legend .legend-row');
      const nRows = await rows.count();
      const boxes = [];
      for (let k = 1; k < nRows; k++) boxes.push(await rows.nth(k).boundingBox());
      const ms = [];
      const r0 = await renders();
      const mh0 = await dev('__overlayMemoHits');
      await resetLongs();
      for (let k = 0; k < 60; k++) {
        const b = boxes[k % boxes.length];
        await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
        await page.waitForTimeout(30);
        ms.push(await page.evaluate(() => window.__overlayMs ?? 0));
      }
      const [n, max] = await longs();
      const sum = ms.reduce((s, x) => s + x, 0);
      console.log(
        `   疊圖 ${nRows - 1} 條（UI 上限 12）legend 滑過 60 次：__overlayMs 總和 ${sum.toFixed(0)} ms（每次 ${(sum / 60).toFixed(1)} ms、最大 ${Math.max(...ms).toFixed(1)} ms；200 條 ≈ ×${(200 / Math.max(1, nRows - 1)).toFixed(0)}）、整頁 render ${(await renders()) - r0} 次、long task ${n} 個（最長 ${max} ms）｜__overlayMemoHits ${mh0} → ${await dev('__overlayMemoHits')}`,
      );
      await page.getByRole('button', { name: /回到結果/ }).click().catch(() => {});
    }

    // 6. 上傳合成的 ×2 比例陣列 .vti（C3、C4）：8 個 Float32 zlib appended；decodeVti 在主執行緒
    const vtiPath = synthVtiFile(scale);
    if (want(6)) {
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.waitForFunction(() => window.__ed);
      await page.waitForTimeout(300);
      const h0 = await heapMB();
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
      const [n, max] = await longs();
      const h1 = await heapMB();
      const size = require('fs').statSync(vtiPath).size / 1048576;
      const N = await page.evaluate(() => window.__ed.vol.data.length);
      console.log(
        `6. 上傳合成 ×${scale} 比例陣列 .vti（${size.toFixed(1)} MB，${(N / 1e6).toFixed(1)} M 點 × 8 Float32）：偵測 ${tInspect} ms、到結構分析完 ${tDecode} ms、到 3D ${Date.now() - t0} ms、long task ${n} 個（最長 ${max} ms）` +
          `｜JS heap ${h0.toFixed(0)} → ${h1.toFixed(0)} MB（期間最高 ${pk.heap.toFixed(0)}）、renderer RSS ${rss0.toFixed(0)} → ${rendererMB().toFixed(0)} MB（期間最高 ${pk.rss.toFixed(0)}；N×(1＋4) ＝ ${((N * 5) / 1048576).toFixed(0)} MB、原檔 ×2 ＝ ${(size * 2).toFixed(0)} MB）`,
      );
    }

    // 7. 產生 20 個 split → 全部打包 zip（C2）；同格式匯出一個改 2 萬格的 split（C1，Worker encodeVtiLike）
    if (want(7)) {
      if (!(await page.evaluate(() => window.__ed.meta?.format === 'vti'))) {
        await page.evaluate(() => localStorage.clear());
        await page.reload();
        await page.waitForFunction(() => window.__ed);
        await page.locator('.ant-upload input[type=file]').setInputFiles(vtiPath);
        await page.locator('.load-confirm').getByRole('button', { name: /載\s*入/ }).click();
        await page.waitForFunction(() => window.__ed.comps.length > 1, null, { timeout: 600000 });
        await idle();
      }
      const t0 = Date.now();
      const made = await page.evaluate(async () => {
        const ed = window.__ed;
        const c = [...ed.comps].sort((a, b) => b.count - a.count)[2];
        const f = { id: 'r', name: 'r', keys: [c.key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
        const ids = await ed.addDesign({ factors: [f], levels: { r: Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : -1) * (1 + (i >> 1))) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
        return { n: ids.length, label: c.label };
      });
      await idle();
      console.log(`7. 產生 20 個 split（搬 ${made.label}）：${Date.now() - t0} ms（${made.n} 個）`);
      await page.keyboard.press('Control+1');
      await page.waitForTimeout(500);
      // 同格式匯出一個（改到的格數＝這個 split 的 changed）
      const one = await page.evaluate(async () => {
        const ed = window.__ed;
        const s = ed.splits.find((x) => ed.stats(x).changed > 0);
        const req = { format: 'vti', spacing: ed.meta.spacing ?? [1, 1, 1], origin: ed.meta.origin ?? [0, 0, 0], arrayName: 'material' };
        const t = performance.now();
        const bytes = await ed.exportBytes(s, req);
        return { ms: performance.now() - t, mb: bytes.length / 1048576, changed: ed.stats(s).changed, name: s.name };
      });
      console.log(`   同格式匯出一個 split（${one.name}，改 ${one.changed} 格）：Worker 往返 ${one.ms.toFixed(0)} ms → ${one.mb.toFixed(1)} MB`);
      const h0 = await heapMB();
      const rss0 = rendererMB();
      const peak = pollPeak();
      const t1 = Date.now();
      // v15 C2：匯出 zip 走 showSaveFilePicker 時 headless 不會有 download 事件；關掉 picker 走 Blob 退路
      await page.evaluate(() => localStorage.setItem('noSavePicker', '1'));
      await page.locator('button[aria-label="匯出"]').click();
      await page.getByRole('menuitem', { name: /打包 zip（單一編號 \.vti/ }).click();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 600000 }), page.locator('.ant-modal').getByRole('button', { name: '匯出 zip' }).click()]);
      const dt = Date.now() - t1;
      const path = await dl.path();
      const zipMB = require('fs').statSync(path).size / 1048576;
      await page.waitForTimeout(500);
      const pk = peak.stop();
      console.log(
        `   匯出 20 個 split 的 zip（vti1）：${dt} ms → ${zipMB.toFixed(0)} MB｜JS heap ${h0.toFixed(0)} → ${(await heapMB()).toFixed(0)} MB（期間最高 ${pk.heap.toFixed(0)}）、renderer RSS ${rss0.toFixed(0)} → ${rendererMB().toFixed(0)} MB（期間最高 ${pk.rss.toFixed(0)}；一個 split ≈ ${(zipMB / 20).toFixed(1)} MB）`,
      );
    }

    // 9. X-ray（A5）：Worker layer {mat: VOID} 的往返時間（postMessage → onmessage，含 Worker 佇列等待）
    if (want(9)) {
      if (!(await page.evaluate(() => window.__ed.ready))) await loadDemo(scale);
      await page.locator('button[aria-label="顯示"]').click();
      const sw = page.locator('.ant-popover').locator('.ant-switch').first();
      await sw.waitFor();
      const n0 = (await roundTrips('layer:void')).length;
      await sw.click();
      await page.waitForFunction((n) => (window.__rt?.['layer:void'] ?? []).length > n, n0, { timeout: 120000 });
      await page.waitForTimeout(300);
      const rt = await roundTrips('layer:void');
      console.log(`9. 開 X-ray：Worker layer {mat: VOID} 往返 ${rt.slice(n0).join('、')} ms（含佇列；Worker 端 boxOf 掃整個陣列的時間看 bench.ts layer void）`);
      await sw.click();
      await page.keyboard.press('Escape');
    }
    console.log(`DEV 計數器現況：__selMaskMs ${await dev('__selMaskMs')}、__diffBoxMs ${await dev('__diffBoxMs')}、__histBytes ${await dev('__histBytes')}、__renders(整頁) ${await dev('__renders')}`);
  };
  await v15();
  if (errors.length) console.log('頁面錯誤：\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
