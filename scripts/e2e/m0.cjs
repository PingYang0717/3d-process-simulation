// M0 驗收（plan v7 §13）：載入範例 → 主畫面 3D；選 fin 1 按 E → XY 正面；Esc 回 3D 選取還在；
// 選 Poly-Si 1 按 E → YZ 側面；3D 雕刻關著時拖已選結構只轉視角（不產生改動）。
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
  await page.getByRole('button', { name: /用範例試試看/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor();
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  ok((await page.locator('.canvas-area.editing').count()) === 0, '載入後主畫面是 3D');
  ok(await page.getByRole('button', { name: /2D 編輯/ }).isDisabled(), '沒選取時「2D 編輯」是灰的');
  ok((await page.locator('.sculpt-tag').innerText()).includes('關'), '3D 雕刻預設關');

  // 選 Si fin 1（左欄清單）
  await page.locator('.item-name', { hasText: /^Si fin 1$/ }).click();
  await page.keyboard.press('e');
  await page.locator('.main-slice').waitFor();
  ok((await page.locator('.canvas-area.editing.focus-z').count()) === 1, 'fin 1 按 E → XY 正面（法線 z）');
  const pb = await page.locator('.position-bar').innerText();
  ok(/整個結構 \(z \d+～\d+\)/.test(pb), `位置列顯示範圍：${pb.replace(/\s+/g, ' ').slice(0, 80)}`);
  if (shots) await page.screenshot({ path: `${shots}/m0-edit-fin.png` });

  // 縮放：滾輪放大、適合視窗
  const img = page.locator('.sedit-img');
  const w0 = (await img.boundingBox()).width;
  const box = await page.locator('.sedit').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(100);
  const w1 = (await img.boundingBox()).width;
  ok(w1 > w0 * 1.3, `滾輪朝游標放大（寬 ${w0.toFixed(0)} → ${w1.toFixed(0)}）`);
  // Ctrl＋滾輪＝換片
  const zBefore = await page.locator('.position-bar input').first().inputValue();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(100);
  const zAfter = await page.locator('.position-bar input').first().inputValue();
  ok(Number(zAfter) === Number(zBefore) + 1, `Ctrl＋滾輪換片（z ${zBefore} → ${zAfter}）`);
  await page.keyboard.press('.');
  ok(Number(await page.locator('.position-bar input').first().inputValue()) === Number(zAfter) + 1, '. 鍵下一片');
  // 右鍵拖＝平移
  const before = await img.boundingBox();
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + 260, box.y + 230, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const after = await img.boundingBox();
  ok(Math.abs(after.x - before.x - 60) < 2 && Math.abs(after.y - before.y - 30) < 2, '右鍵拖平移');

  // 範圍：此片
  await page.locator('.position-bar .ant-segmented-item', { hasText: '此片' }).click();
  ok((await page.locator('.insp-body').innerText()).includes('此片'), '右欄範圍與位置列同一個狀態');
  await page.locator('.position-bar .ant-segmented-item', { hasText: '整個結構' }).click();

  // Esc 回 3D，選取還在
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  ok((await page.locator('.canvas-area.editing').count()) === 0, 'Esc 回 3D');
  ok((await page.locator('.insp-body').innerText()).includes('Si fin 1'), '回 3D 後選取還在');

  // 選 Poly-Si 1 → E → YZ 側面
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await page.keyboard.press('e');
  await page.locator('.main-slice').waitFor();
  ok((await page.locator('.canvas-area.editing.focus-x').count()) === 1, 'Poly-Si 1 按 E → YZ 側面（法線 x）');
  if (shots) await page.screenshot({ path: `${shots}/m0-edit-poly.png` });
  // 自訂範圍（沿 x）→ 右欄「往上長 1 格」→ 訊息帶 x 範圍、只改那一段
  await page.locator('.position-bar .ant-segmented-item', { hasText: '自訂' }).click();
  await page.locator('.position-bar .ant-slider').waitFor();
  const lo = Number(await page.locator('.insp-body .scope-ctl .ant-input-number input').nth(0).inputValue());
  const hi = Number(await page.locator('.insp-body .scope-ctl .ant-input-number input').nth(1).inputValue());
  ok(lo > 8 && hi < 151 && lo < hi, `自訂範圍從結構中間三分之一開始（x ${lo}～${hi}）`);
  await page.getByRole('button', { name: /往上長 1 格/ }).click();
  await page.waitForSelector('.busy-bar', { state: 'detached', timeout: 60000 });
  await page.locator('.ant-message').getByText(`已套用到 x ${lo}～${hi}`).first().waitFor({ timeout: 10000 });
  ok(true, `套用訊息帶範圍「x ${lo}～${hi}」`);
  await page.waitForFunction(() => /已改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  const changed = Number((await page.locator('.insp-foot').innerText()).replace(/[^0-9]/g, ''));
  ok(changed === 2304, `只改到範圍裡的那一段（${changed} voxels）`);
  if (shots) await page.screenshot({ path: `${shots}/m0-custom.png` });
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => /尚未改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  ok(true, 'Ctrl+Z 回到原始（改動 0）');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => /已改動 2,304/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  ok(true, 'Ctrl+Y 重做（改動回到 2,304）');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => /尚未改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  await page.locator('.position-bar .ant-segmented-item', { hasText: '整個結構' }).click();
  await page.keyboard.press('Escape');

  // 3D 雕刻關：在已選結構上左鍵拖不改體素
  await page.waitForTimeout(200);
  const c3 = await page.locator('.pane-3d .canvas-wrap').boundingBox();
  const foot = () => page.locator('.insp-foot').innerText();
  const f0 = await foot();
  for (const [dx, dy] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]]) {
    const x = c3.x + c3.width / 2 + dx;
    const y = c3.y + c3.height / 2 + dy;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  ok((await foot()) === f0, '3D 雕刻關著時拖拉不改體素');
  if (shots) await page.screenshot({ path: `${shots}/m0-3d.png` });

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
