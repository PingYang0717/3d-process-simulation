// 效能（plan v17 G5）：一步（按下外推 → 換上正式網格）的時間，×1 目標 ≤ 700 ms、×3 ≤ 1.3 s；
// 拖箭頭時 3D 有即時預覽（Worker 第 2 級預覽回來的次數）；載入（結構分析＋薄層判定）的時間；主執行緒 long task。
// 用法：先 `npm run dev`，再 `node scripts/e2e/perf.cjs [http://localhost:5173] [scale ...]`（預設 1 3）
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const scales = process.argv.slice(3).map(Number).filter(Boolean);
const LIMIT = { 1: 700, 2: 1000, 3: 1300 };
const q = (xs, f) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(f * xs.length))];

(async () => {
  const browser = await chromium.launch();
  let failed = false;
  for (const scale of scales.length ? scales : [1, 3]) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
    await page.goto(url);
    await page.evaluate(() => localStorage.clear());
    // longtask 要從頁面一開始就記（v18：開啟就自動載入簡單範例）
    await page.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__longTasks.push(e.duration))).observe({ entryTypes: ['longtask'] });
    });
    // ×1＝重新整理 → 範例的網格畫完；×2／×3 等 ×1 好了再走開發模式的 __loadDemo
    let t0 = Date.now();
    await page.reload();
    if (scale !== 1) {
      await page.locator('.pane-3d canvas').first().waitFor({ timeout: 120000 });
      await page.waitForFunction(() => window.__ed && !window.__ed.busy, null, { timeout: 120000 });
      await page.evaluate(() => (window.__longTasks.length = 0));
      t0 = Date.now();
      await page.evaluate((s) => window.__loadDemo(s), scale);
    }
    await page.waitForFunction((s) => window.__ed && window.__ed.vol.X === 160 * s && !window.__ed.busy, scale, { timeout: 300000 });
    await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 300000 });
    const tLoad = Date.now() - t0;
    const liners = await page.evaluate(() => window.__ed.liners);
    const name = page.locator('.item-name', { hasText: /^Poly-Si 1$/ });
    await page.locator('.item', { has: name }).click();
    await page.waitForFunction(() => window.__ed.probe, null, { timeout: 60000 });
    // 第一步會先複製一份帳簿（idle 時已經先抄好）；量 5 步
    const times = [];
    for (let k = 0; k < 5; k++) {
      const n = await page.evaluate(() => window.__ed.hist.length);
      const before = await page.evaluate(() => window.__meshAt?.t ?? 0);
      const t = await page.evaluate(() => performance.now());
      await page.getByTestId(k % 2 ? 'shrink' : 'grow').click();
      await page.waitForFunction(([m, b]) => window.__ed.hist.length === m + 1 && !window.__ed.busy && (window.__meshAt?.t ?? 0) > b, [n, before], { timeout: 120000 });
      const at = await page.evaluate(() => window.__meshAt.t);
      times.push(at - t);
    }
    // 拖箭頭：Worker 的即時預覽有回來
    const hs = await page.evaluate(() => window.__handles());
    const up = hs.find((h) => h.dir[1] === -1);
    const calls0 = await page.evaluate(() => (window.__calls || []).filter((c) => c.type === 'preview').length);
    await page.mouse.move(up.x, up.y);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) {
      await page.mouse.move(up.x, up.y - k * 5);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(300);
    const previews = (await page.evaluate(() => (window.__calls || []).filter((c) => c.type === 'preview').length)) - calls0;
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const long = await page.evaluate(() => window.__longTasks);
    const p50 = q(times, 0.5);
    const max = Math.max(...times);
    const lim = LIMIT[scale] ?? Infinity;
    console.log(
      `×${scale}：載入 ${tLoad} ms（薄層 [${liners.join(', ')}]）｜一步（按下 → 正式網格）${times.map((x) => x.toFixed(0)).join('／')} ms，中位 ${p50.toFixed(0)}、最大 ${max.toFixed(0)}（目標 ≤ ${lim}）` +
        `｜拖箭頭時 Worker 預覽 ${previews} 次｜long task ${long.length} 個、最長 ${long.length ? Math.max(...long).toFixed(0) : 0} ms`,
    );
    if (p50 > lim || previews === 0) failed = true;
    await page.close();
  }
  await browser.close();
  if (failed) {
    console.error('✗ 沒達到 G5');
    process.exit(1);
  }
  console.log('✓ G5');
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
