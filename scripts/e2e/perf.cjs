// 端到端速度（plan v7 §8.6、M1 驗收）：大範例上「長高 1 格」從按下到 3D 更新完（.mesh-busy 消失）的時間。
// 用法：先 `npm run dev`，再 `node scripts/e2e/perf.cjs [url] [scale=2] [截圖資料夾]`
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const scale = Number(process.argv[3] || 2);
const shots = process.argv[4] || null;

(async () => {
  const browser = await chromium.launch({ args: ['--js-flags=--max-old-space-size=8192'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Worker 訊息計數（plan v9 §6.2：每一步只送 apply＋chunks＋（有選取時）layer）
  await page.addInitScript(() => {
    window.__posts = {};
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (msg, ...rest) {
      if (msg && msg.type) window.__posts[msg.type] = (window.__posts[msg.type] || 0) + 1;
      return post.call(this, msg, ...rest);
    };
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
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const t0 = Date.now();
  await page.getByRole('button', { name: scale === 1 ? /用範例試試看/ : new RegExp(`大範例 ×${scale}`) }).click();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 300000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 });
  console.log(`載入＋第一次網格：${Date.now() - t0} ms`);
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await page.waitForTimeout(1500);
  const times = [];
  const js = [];
  let p0posts = await posts();
  for (let k = 0; k < 4; k++) {
    const t = Date.now();
    const p0 = await page.evaluate(() => performance.now());
    await page.getByRole('button', { name: '長高' }).first().click();
    // 換上正式網格的那一刻（JS 時間，不含 headless 軟體繪圖把畫面畫出來的時間）
    const m = await page.waitForFunction((p) => { const m = window.__meshAt; return m && m.t > p ? m : null; }, p0, { timeout: 120000, polling: 16 }).then((h) => h.jsonValue());
    js.push(`${(m.t - p0).toFixed(0)}（${m.full ? '全部' : m.n} 個 chunk）`);
    await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 120000 });
    times.push(Date.now() - t);
    await page.waitForTimeout(800);
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
  await page.getByRole('button', { name: '剖面' }).click();
  await page.waitForTimeout(500);
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
  const from = [b.x + node[0] * z, b.y + node[1] * z];
  await page.evaluate(() => ((window.__long = 0), (window.__longMax = 0)));
  const cap0 = await page.evaluate(() => [window.__capTex || 0, window.__capDraw || 0]);
  const pane = page.locator('.pane-3d').first();
  const shot0 = await pane.screenshot();
  await page.mouse.move(from[0], from[1]);
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
  console.log(`2D 拖拉節點 60 步（${kind}）：${dragMs} ms、long task ${longs} 個（最長 ${longMax} ms）；拖拉中 3D 小窗${shot0.equals(shot1) ? '沒有變化' : '有即時變化'}`);
  if (errors.length) console.log('頁面錯誤：\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
