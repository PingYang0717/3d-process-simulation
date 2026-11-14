// M0（plan v17 留下的載入檢查；v18 起沒有歡迎頁）：開啟 → 自動載入簡單範例 → 3D 與三張切面出現、清單有結構、沒有頁面錯誤；
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
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  // plan v19：2D 切面預設收起、沒有匯出；左右兩欄可以收合
  ok((await page.locator('.slice-pane').count()) === 0 && (await page.locator('.slices-bar').count()) === 1, '2D 切面預設收起（只有一條橫條）');
  ok((await page.getByRole('button', { name: '匯出' }).count()) === 0, '沒有匯出按鈕');
  await page.locator('.slices-bar').click();
  ok((await page.locator('.slice-pane').count()) === 3, '點橫條展開：三張切面');
  await page.locator('.slices-bar').click();
  ok((await page.locator('.slice-pane').count()) === 0, '再點一下收合');
  const w0 = await page.evaluate(() => document.querySelector('.pane-3d').getBoundingClientRect().width);
  await page.locator('.sider > .fold').click();
  await page.locator('.inspector > .fold').click();
  ok((await page.locator('.sider').count()) === 0 && (await page.locator('.inspector').count()) === 0 && (await page.locator('.rail').count()) === 2, '左右兩欄收成窄邊');
  ok((await page.evaluate(() => document.querySelector('.pane-3d').getBoundingClientRect().width)) > w0 + 400, '3D 變寬');
  await page.locator('.rail.left').click();
  await page.locator('.rail.right').click();
  ok((await page.locator('.sider').count()) === 1 && (await page.locator('.inspector').count()) === 1, '點窄邊展開');
  ok((await page.locator('.group').count()) >= 7, '左欄依材質分組');
  ok(await page.locator('.panel.off').isVisible(), '沒選取時面板反灰');
  await page.locator('.item', { hasText: 'Si fin 1' }).click();
  await page.waitForFunction(() => window.__handles && window.__handles().length === 6, null, { timeout: 10000 });
  ok(true, '選到結構就有六支箭頭（不必進聚焦編輯）');
  // plan v19：箭頭貼在結構的表面上（那一格往箭頭反方向半格是這個結構、往箭頭方向半格不是）
  const onSurface = await page.evaluate(() => {
    const ed = window.__ed;
    const { X, Y } = ed.vol;
    const L = ed.cur.L;
    const ci = L.comps.indexOf(ed.handleComp);
    const at = (p) => L.labels[(Math.floor(p[2]) * Y + Math.floor(p[1])) * X + Math.floor(p[0])];
    return window.__handles().every((h) => at(h.pos.map((v, k) => v - h.dir[k] * 0.5)) === ci && at(h.pos.map((v, k) => v + h.dir[k] * 0.5)) !== ci);
  });
  ok(onSurface, '六支箭頭都貼在結構的表面上');
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
