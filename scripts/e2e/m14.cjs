// plan v14 §7 e2e：
// 1. 選 Poly-Si 1 → 3D 圓角把手往內拖、放開：拖拉中 3D 有即時預覽（×1 沒超過上限）、沒有「範圍太大」；
//    Op 的範圍＝結構沿 x 的起止、填上面那層、不帶襯層；放開後角落提示收掉。
// 2. 套用後整個陣列的 AIR 格數不變（削掉的格子填上面那層，不是空氣）。
// 3. 實驗頁：選 Si fin 1 加一個圓頭變數 → 換選 Poly-Si 3 → 變數 0 個；重新整理後變數 0 個。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m14.cjs [http://localhost:5173]`。
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
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
  await page.waitForFunction(() => window.__ed);
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector('.busy-bar, .mesh-busy') && !window.__ed.busy, null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  await page.evaluate(() => window.__ed.demo(1));
  await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 3'), null, { timeout: 120000 });
  await idle();
  const select = (label) =>
    page.evaluate((label) => {
      const ed = window.__ed;
      ed.selectKeys([ed.comps.find((c) => c.label === label).key]);
    }, label);
  const airCount = () => page.evaluate(() => window.__ed.cur.vol.data.reduce((n, v) => n + (v === 0 ? 1 : 0), 0));

  // ---- 1. 3D 圓角把手 ----
  await select('Poly-Si 1');
  await page.waitForTimeout(400);
  const air0 = await airCount();
  const bbox = await page.evaluate(() => window.__ed.selBox);
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);
  ok((await page.evaluate(() => window.__ed.focus?.view)) === '3d', '進入聚焦編輯（3D 把手）');
  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  const hs = await page.evaluate(() => window.__handles());
  const corners = hs.filter((h) => h.kind === 'corner' && h.visible);
  ok(corners.length > 0, `角把手看得到（${corners.length} 個）`);
  const cx = corners.reduce((s, h) => s + h.x, 0) / corners.length;
  const cy = corners.reduce((s, h) => s + h.y, 0) / corners.length;
  const h = corners.find((c) => c.id === 'ul') ?? corners[0];
  const len = Math.hypot(cx - h.x, cy - h.y) || 1;
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  let sawPv = false;
  let sawBig = false;
  for (let i = 1; i <= 30; i++) {
    const t = Math.min(0.6, i * 0.02);
    await page.mouse.move(h.x + ((cx - h.x) / len) * len * t, h.y + ((cy - h.y) / len) * len * t);
    await page.waitForTimeout(60);
    if (await page.evaluate(() => !!window.__livePv.get())) sawPv = true;
    if (await page.locator('.too-big-note').count()) sawBig = true;
  }
  ok(sawPv, '拖拉中 3D 有即時預覽（__livePv 非 null）');
  ok(!sawBig, '×1 沒出現「範圍太大」');
  await page.mouse.up();
  await idle();
  const op = await page.evaluate(() => window.__ed.active?.ops.at(-1));
  ok(op?.kind === 'profile' && !!op.rounds, '放開後套用一個圓頭 Op');
  ok(op.scope.axis === 'x' && op.scope.lo === bbox.x0 && op.scope.hi === bbox.x1, `範圍＝結構沿 x 的起止（x ${op.scope.lo}～${op.scope.hi}）`);
  ok(op.backfill === 'above' && op.follow === false, '填上面那層、不帶襯層');
  ok((await page.locator('.too-big-note').count()) === 0, '放開後沒有殘留提示');

  // ---- 2. AIR 不變 ----
  const air1 = await airCount();
  ok(air1 === air0, `套用後 AIR 格數不變（${air0.toLocaleString()} → ${air1.toLocaleString()}）`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ---- 3. 實驗頁草稿 ----
  await select('Si fin 1');
  await page.keyboard.press('Control+2');
  await page.locator('.lab').waitFor();
  const panel = page.locator('.design-panel');
  await panel.getByRole('button', { name: /加一個變數/ }).click();
  await page.locator('.op-menu .op-menu-item', { hasText: '圓頭半徑' }).click();
  ok((await panel.locator('.factor-card').count()) === 1, '選 Si fin 1 加一個圓頭變數');
  await page.keyboard.press('Control+1');
  await page.waitForTimeout(300);
  await select('Poly-Si 3');
  await page.keyboard.press('Control+2');
  await page.locator('.lab').waitFor();
  await page.waitForTimeout(300);
  ok((await panel.locator('.factor-card').count()) === 0, '回編輯頁換選 Poly-Si 3 → 實驗頁變數 0 個');
  await panel.getByRole('button', { name: /加一個變數/ }).click();
  await page.locator('.op-menu .op-menu-item', { hasText: '圓頭半徑' }).click();
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Control+2');
  await page.locator('.lab').waitFor();
  ok((await panel.locator('.factor-card').count()) === 1, '沒換結構：切頁回來變數還在');
  await page.reload();
  await page.waitForFunction(() => window.__ed);
  await page.evaluate(() => window.__ed.demo(1));
  await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 3'), null, { timeout: 120000 });
  await idle();
  await select('Poly-Si 3');
  await page.evaluate(() => window.__ed.setPage('lab'));
  await page.locator('.lab').waitFor();
  ok((await page.locator('.design-panel .factor-card').count()) === 0, '重新整理後變數 0 個');

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors[0] : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
