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
  if (errors.length) console.log('頁面錯誤：\n' + errors.join('\n'));
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
