// plan v9 M9.1 手測項目自動化：兩個 split 各改、複製 split 後各改、回到原始、復原到底再重做到底、看原始 B。
// 每一本帳簿只有一份、原地改；這裡確認 split 之間不互相污染、改動數字（主執行緒差量更新）前後一致。
// plan v10：標題列「長高」→ 右欄「長／縮」卡片（格數 1、預設往上）＋「套用」；
// 「回到原始」→「改了哪些」頁籤底部「丟掉所有改動」（Popconfirm「丟掉」）；看改前／差異時順便確認分段「改後／改前／差異」跟著切。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m9.cjs [http://localhost:5173]`
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
    await page.waitForTimeout(400);
  };
  const changed = async () => {
    const t = await page.locator('body').innerText();
    const m = t.match(/已改動 ([\d,]+) 個 voxel/);
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  };
  /** 右欄「長／縮」卡片：往上 1 格、套用。 */
  const grow = async () => {
    await page.getByRole('tab', { name: /選取與調整/ }).click();
    const card = page.locator('.inspector .op-card').first();
    await card.scrollIntoViewIfNeeded();
    await card.getByLabel('格數').fill('1');
    await card.locator('button.ant-btn-primary').click();
    await idle();
  };
  /** 3D 標題列的分段（改後／改前／差異）目前選哪一個。 */
  const viewMode = () => page.locator('.ant-segmented.tb .ant-segmented-item-selected').innerText();
  const tab = (name) => page.locator('.split-tab', { has: page.locator('.split-name', { hasText: new RegExp(`^${name}$`) }) });

  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await grow();
  const a = await changed();
  ok(a > 0, `原始上長高 → 自動建立 Split 1，改動 ${a}`);
  await grow();
  const a2 = await changed();
  ok(a2 > a, `Split 1 再長高：${a2}`);

  // 複製 split 後各改
  await tab('Split 1').locator('.split-more').click({ force: true }).catch(async () => {
    await page.locator('.split-more').first().click({ force: true });
  });
  await page.getByText('複製這個 split').click();
  await idle();
  ok((await changed()) === a2, `複本和來源相同（${a2}）`);
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await grow();
  const b = await changed();
  ok(b > a2, `複本再長高：${b}`);
  await tab('Split 1').click();
  await idle();
  const back = await changed();
  ok(back === a2, `切回 Split 1：仍是 ${a2}（沒被複本污染）[${back}，作用中：${await page.locator('.split-tab.on .split-name').innerText()}]`);
  await page.keyboard.press('Control+z');
  await idle();
  ok((await changed()) === a, `Split 1 復原一步：${a}`);
  await page.keyboard.press('Control+z');
  await idle();
  ok((await changed()) === 0, 'Split 1 復原到底：0');
  await page.keyboard.press('Control+y');
  await idle();
  await page.keyboard.press('Control+y');
  await idle();
  ok((await changed()) === a2, `重做到底：${a2}`);
  await tab('Split 1 複本').click();
  await idle();
  ok((await changed()) === b, `複本仍是 ${b}`);

  // 回到原始（這個 split 的帳簿釋放）；再改一次和第一次相同
  await page.getByRole('tab', { name: /改了哪些/ }).click();
  await page.getByRole('button', { name: /丟掉所有改動/ }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: /丟\s*掉/ }).click();
  await idle();
  ok((await changed()) === 0, '複本「丟掉所有改動」：0');
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await grow();
  ok((await changed()) === a, `丟掉所有改動後再長高：${a}（和第一次相同）`);
  await tab('Split 1').click();
  await idle();
  ok((await changed()) === a2, `Split 1 不受影響：${a2}`);

  // 看改前 B、差異 D 再切回
  await page.mouse.click(5, 5);
  ok((await viewMode()).trim() === '改後', '分段停在「改後」');
  await page.keyboard.press('b');
  await idle();
  ok((await viewMode()).trim() === '改前', 'B → 「改前」');
  await page.keyboard.press('b');
  await page.keyboard.press('d');
  await idle();
  ok((await viewMode()).trim() === '差異', 'D → 「差異」');
  await page.keyboard.press('d');
  await idle();
  ok((await viewMode()).trim() === '改後', '再按 D 回「改後」');
  ok((await changed()) === a2, '看改前、差異後切回，數字不變');
  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
