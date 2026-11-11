// M0（plan v17 留下的載入檢查）：歡迎頁 → 簡單範例 → 3D 與三張切面出現、清單有結構、沒有頁面錯誤；
// 點清單選一個結構 → 3D 出現六支箭頭、右欄面板可以按；Esc 取消選取 → 面板反灰。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m0.cjs [http://localhost:5173] [截圖資料夾]`
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const shots = process.argv[3] || null;
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: /簡單範例/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  ok((await page.locator('.slice-pane').count()) === 3, '三張切面');
  ok((await page.locator('.group').count()) >= 7, '左欄依材質分組');
  ok(await page.locator('.panel.off').isVisible(), '沒選取時面板反灰');
  await page.locator('.item', { hasText: 'Si fin 1' }).click();
  await page.waitForFunction(() => window.__handles && window.__handles().length === 6, null, { timeout: 10000 });
  ok(true, '選到結構就有六支箭頭（不必進聚焦編輯）');
  ok(!(await page.locator('.panel.off').count()), '選取後面板可以按');
  if (shots) await page.screenshot({ path: `${shots}/m0-selected.png` });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__ed.sel.size === 0);
  ok(await page.locator('.panel.off').isVisible(), 'Esc 取消選取，面板反灰');
  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
