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
  console.log(`長高 1 格，按下 → 畫面不再顯示「更新 3D 中」：${times.join('、')} ms（headless 軟體繪圖很慢，只供參考）`);
  const tu = Date.now();
  await page.keyboard.press('Control+z');
  await page.waitForSelector('.mesh-busy', { state: 'attached', timeout: 5000 }).catch(() => {});
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 120000 });
  console.log(`復原：${Date.now() - tu} ms`);
  if (shots) await page.screenshot({ path: `${shots}/perf-x${scale}.png` });

  // 2D 拖拉（plan v8 §8.4）：Si fin 1 進 2D 編輯，拖右上節點 60 步；記 long task（> 50 ms）數，
  // 拖拉中 3D 小窗有沒有即時變化（截圖比對）
  await page.locator('.item-name', { hasText: /^Si fin 1$/ }).click();
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
  const b = await page.locator('.sedit-img').boundingBox();
  const W = await page.evaluate(() => window.__ed.vol.X);
  const z = b.width / W;
  const from = [b.x + node[0] * z, b.y + node[1] * z];
  await page.evaluate(() => {
    window.__long = 0;
    new PerformanceObserver((l) => (window.__long += l.getEntries().length)).observe({ type: 'longtask' });
  });
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
  const longs = await page.evaluate(() => window.__long);
  await page.mouse.up();
  await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 120000 });
  const kind = await page.evaluate(() => window.__ed.active?.ops.at(-1)?.kind);
  console.log(`2D 拖拉節點 60 步（${kind}）：${dragMs} ms、long task ${longs} 個；拖拉中 3D 小窗${shot0.equals(shot1) ? '沒有變化' : '有即時變化'}`);
  if (errors.length) console.log('頁面錯誤：\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
