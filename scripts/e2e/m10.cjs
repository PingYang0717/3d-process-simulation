// plan v10 §2 驗收（U1、U4、U5）：
// U1 任意滾輪／旋轉 50 步之後旋轉中心仍在模型包圍盒（放大 25%）內；
// U4 卡片改數值 → 預覽出現、hist 不變；按套用 → hist + 1；
// U5 聚焦模式裡非把手處拖＝轉視角（不改體素）；面把手拖 n 格的 Op 和卡片「長／縮 n」逐欄相同；右鍵有編輯項。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m10.cjs [http://localhost:5173]`
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
  // plan v11 §8：舊腳本照 v10 行為跑——進階開關（自由形變、筆刷）打開、推面蓋過去
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('se3d.v1.freeform', 'true'); localStorage.setItem('se3d.v1.brushOn', 'true'); localStorage.setItem('se3d.v1.pushPolicy', '"overwrite"'); });
  await page.reload();
  await page.getByRole('button', { name: /用範例試試看/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor();
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector('.busy-bar, .mesh-busy'), null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  const box = await page.locator('.pane-3d canvas').first().boundingBox();
  const inBox = () =>
    page.evaluate(() => {
      const t = window.__controls.target;
      const v = window.__ed.vol;
      const m = 0.25;
      const ok = (x, n) => x >= -n * m && x <= n * (1 + m);
      return { ok: ok(t.x, v.X) && ok(t.y, v.Y) && ok(t.z, v.Z), t: [t.x, t.y, t.z].map((x) => Math.round(x)) };
    });

  // ---- U1：角落滾 20 格、拖轉 10 次、空白處滾、平移 ----
  const corner = { x: box.x + 30, y: box.y + 30 };
  for (let i = 0; i < 20; i++) {
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.wheel(0, i % 3 === 2 ? 240 : -240);
    await page.waitForTimeout(20);
  }
  for (let i = 0; i < 10; i++) {
    const x = box.x + box.width * (0.3 + 0.04 * i);
    const y = box.y + box.height * 0.5;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 80, y + (i % 2 ? 40 : -40), { steps: 4 });
    await page.mouse.up();
  }
  for (let i = 0; i < 15; i++) {
    await page.mouse.move(box.x + box.width - 20, box.y + box.height - 20);
    await page.mouse.wheel(0, -300);
  }
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(box.x + 500, box.y + 260, { steps: 4 });
    await page.mouse.up({ button: 'right' });
  }
  await page.waitForTimeout(900);
  const c1 = await inBox();
  ok(c1.ok, `U1 滾輪／旋轉／平移 50 步後旋轉中心仍在模型（放大 25%）內 ${JSON.stringify(c1.t)}`);
  await page.keyboard.press('h');
  await page.waitForTimeout(600);

  // ---- U4：卡片預覽 → 套用 ----
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await page.waitForTimeout(600);
  const card = page.locator('.inspector .op-card').first();
  await card.scrollIntoViewIfNeeded();
  const t0 = Date.now();
  await card.getByLabel('格數').fill('3');
  await page.waitForFunction(() => !!window.__livePv.get(), null, { timeout: 5000 });
  const dt = Date.now() - t0;
  const h0 = await page.evaluate(() => window.__ed.hist.length);
  ok(h0 === 0, `U4 改格數後預覽出現（${dt} ms，含輸入與 Worker）、hist 不變`);
  await card.locator('button.ant-btn-primary').click();
  await idle();
  const after = await page.evaluate(() => ({ hist: window.__ed.hist.length, pv: !!window.__livePv.get(), op: window.__ed.active.ops.at(-1) }));
  ok(after.hist === 1 && !after.pv, 'U4 按套用 → hist + 1，拖拉預覽收掉');
  const cardOp = after.op;

  // ---- U5：聚焦編輯 ----
  await page.keyboard.press('Control+z');
  await idle();
  await page.keyboard.press('e');
  await page.waitForTimeout(1200);
  ok((await page.evaluate(() => window.__ed.focus?.view)) === '3d', 'U5 E 進入聚焦編輯（3D 把手）');
  // 非把手處拖：轉視角，不改
  const hist1 = await page.evaluate(() => window.__ed.hist.length);
  await page.mouse.move(box.x + 60, box.y + box.height - 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + box.height - 120, { steps: 6 });
  await page.mouse.up();
  await idle();
  ok((await page.evaluate(() => window.__ed.hist.length)) === hist1, 'U5 非把手處左鍵拖＝轉視角，沒有改體素');
  await page.keyboard.press('f');
  await page.waitForTimeout(800);
  // 面把手：頂面往上拖直到 3 格
  const hs = await page.evaluate(() => window.__handles());
  const top = hs.find((h) => h.kind === 'face' && h.dir[1] === -1 && h.visible);
  ok(!!top, 'U5 頂面把手看得到');
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  let tip = '';
  for (let i = 1; i <= 80; i++) {
    await page.mouse.move(top.x, top.y - i * 2);
    tip = (await page.locator('.drag-tip').innerText().catch(() => '')) || '';
    if (/長 3 vx/.test(tip)) break;
  }
  ok(/長 3 vx/.test(tip), `U5 拖面把手時游標旁顯示格數（${tip.split('·')[0].trim()}）`);
  await page.mouse.up();
  await idle();
  const handleOp = await page.evaluate(() => window.__ed.active.ops.at(-1));
  const strip = (o) => JSON.stringify({ ...o, report: undefined });
  ok(strip(handleOp) === strip(cardOp), 'U5 面把手拖 3 格的 Op 和卡片「長／縮 3」逐欄相同');
  // 右鍵編輯項
  const hs2 = await page.evaluate(() => window.__handles());
  const mid = hs2.find((h) => h.kind === 'face' && h.dir[2] === 1 && h.visible) || hs2.find((h) => h.kind === 'face' && h.visible);
  await page.mouse.click(mid.x - 25, mid.y + 10, { button: 'right' });
  await page.waitForTimeout(400);
  const menu = await page.locator('.ctxmenu').innerText().catch(() => '');
  if (!/圓頭…/.test(menu)) console.log('menu:', menu);
  ok(/圓頭…/.test(menu) && /換材質/.test(menu), 'U5 聚焦中右鍵有「圓頭…」「換材質」等編輯項');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => window.__ed.focus)) === null && (await page.evaluate(() => window.__ed.sel.size)) === 1, 'U5 Esc 離開聚焦，選取留著');

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors[0] : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
