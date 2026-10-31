// M0 驗收（plan v7 §13，plan v10 改版後的介面）：載入範例 → 主畫面 3D；選 fin 1 進 2D 剖面 → XY 正面；Esc 回 3D 選取還在；
// 選 Poly-Si 1 進 2D 剖面 → YZ 側面；不在聚焦編輯時拖已選結構只轉視角（不產生改動）。
// v10：「2D 編輯 (E)」按鈕沒了，E 循環 瀏覽 → 3D 把手 → 2D 剖面（按兩下 E 進 2D）；「3D 雕刻」開關沒了（不在聚焦模式就沒有編輯）；
// 範圍控制從位置列搬到卡片下方「套用到：… ▾」；「往上長 1 格」按鈕換成右欄「長／縮」卡片（格數 1、預設往上）＋「套用」。
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
  const focus = () => page.evaluate(() => window.__ed.focus);
  /** 按兩下 E：瀏覽 → 3D 把手 → 2D 剖面（plan v10 D9）。 */
  const to2D = async () => {
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__ed.focus?.view === '3d', null, { timeout: 5000 });
    await page.keyboard.press('e');
    await page.locator('.main-slice').waitFor();
  };
  /** 右欄「長／縮」卡片；範圍在卡片下方「套用到：… ▾」。 */
  const card = () => page.locator('.inspector .op-card').first();
  const openScope = async () => {
    await card().locator('.scope-line').click();
    const pop = page.locator('.ant-popover:visible').filter({ has: page.locator('.scope-ctl') });
    await pop.waitFor();
    return pop;
  };
  const closeScope = async () => {
    await card().locator('.scope-line').click();
    await page.locator('.ant-popover:visible .scope-ctl').waitFor({ state: 'hidden' });
  };

  ok((await page.locator('.canvas-area.editing').count()) === 0, '載入後主畫面是 3D');
  // 原「沒選取時『2D 編輯』是灰的」→ v10：沒選取時沒有編輯工具列，按 E 也不會進聚焦編輯
  ok((await page.locator('.edit-toolbar').count()) === 0, '沒選取時沒有編輯工具列（2D 剖面頁籤不在）');
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  ok((await focus()) === null, '沒選取時按 E 不會進聚焦編輯');
  // 原「3D 雕刻預設關」→ v10：開場不在聚焦模式（不在聚焦模式就沒有任何 3D 編輯）
  ok((await focus()) === null && (await page.locator('.sculpt-tag').count()) === 0, '開場不在聚焦編輯（3D 雕刻開關已刪除）');

  // 選 Si fin 1（左欄清單）
  await page.locator('.item-name', { hasText: /^Si fin 1$/ }).click();
  await page.locator('.edit-toolbar').waitFor();
  await to2D();
  ok((await page.locator('.canvas-area.editing.focus-z').count()) === 1, 'fin 1 按 E E → 2D 剖面 XY 正面（法線 z）');
  const pb = await page.locator('.position-bar').innerText();
  ok(/整個結構（z \d+～\d+）/.test(pb), `位置列顯示範圍：${pb.replace(/\s+/g, ' ').slice(0, 80)}`);
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
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r())));
  const after = await img.boundingBox();
  ok(Math.abs(after.x - before.x - 60) < 2 && Math.abs(after.y - before.y - 30) < 2, `右鍵拖平移（${(after.x - before.x).toFixed(1)}, ${(after.y - before.y).toFixed(1)}）`);

  // 範圍：此片（v10 在卡片下方「套用到」改，位置列只顯示；兩邊是同一個狀態）
  let pop = await openScope();
  await pop.locator('.ant-segmented-item', { hasText: '此片' }).click();
  await closeScope();
  ok(/此片/.test(await page.locator('.position-bar').innerText()) && /此片/.test(await card().locator('.scope-line').innerText()), '卡片「套用到」與位置列同一個範圍狀態（此片）');
  pop = await openScope();
  await pop.locator('.ant-segmented-item', { hasText: '整個結構' }).click();
  await closeScope();

  // Esc 回 3D，選取還在（卡片作用中時第一下 Esc 先收卡片預覽）
  await page.mouse.click(5, 5);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok((await page.locator('.canvas-area.editing').count()) === 0 && (await focus()) === null, 'Esc 回 3D（離開聚焦編輯）');
  ok((await page.locator('.insp-body').first().innerText()).includes('Si fin 1'), '回 3D 後選取還在');

  // 選 Poly-Si 1 → E E → YZ 側面
  await page.locator('.item-name', { hasText: /^Poly-Si 1$/ }).click();
  await page.waitForTimeout(200);
  await to2D();
  ok((await page.locator('.canvas-area.editing.focus-x').count()) === 1, 'Poly-Si 1 按 E E → 2D 剖面 YZ 側面（法線 x）');
  if (shots) await page.screenshot({ path: `${shots}/m0-edit-poly.png` });
  // 自訂範圍（沿 x）→ 右欄「長／縮」卡片往上 1 格、套用 → 訊息帶 x 範圍、只改那一段
  pop = await openScope();
  await pop.locator('.ant-segmented-item', { hasText: '自訂' }).click();
  await pop.locator('.ant-slider').waitFor();
  const lo = Number(await pop.locator('.scope-ctl .ant-input-number input').nth(0).inputValue());
  const hi = Number(await pop.locator('.scope-ctl .ant-input-number input').nth(1).inputValue());
  ok(lo > 8 && hi < 151 && lo < hi, `自訂範圍從結構中間三分之一開始（x ${lo}～${hi}）`);
  await closeScope();
  ok((await card().locator('.scope-line').innerText()).includes(`x ${lo}～${hi}`), '卡片「套用到」顯示自訂範圍');
  await card().getByLabel('格數').fill('1');
  await card().locator('button.ant-btn-primary').click();
  await page.locator('.ant-message').getByText(`已套用到 x ${lo}～${hi}`).first().waitFor({ timeout: 10000 });
  ok(true, `套用訊息帶範圍「x ${lo}～${hi}」`);
  const op0 = await page.evaluate(() => window.__ed.active.ops.at(-1));
  ok(op0.kind === 'push' && op0.n === 1 && op0.dir.join() === '0,-1,0', `長／縮卡片預設往上 1 格（${op0.kind} dir ${op0.dir} n ${op0.n}）`);
  await page.waitForFunction(() => /已改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  const changed = Number((await page.locator('.insp-foot').innerText()).replace(/[^0-9]/g, ''));
  ok(changed === 2304, `只改到範圍裡的那一段（${changed} voxels）`);
  if (shots) await page.screenshot({ path: `${shots}/m0-custom.png` });
  await page.mouse.click(5, 5);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => /尚未改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  ok(true, 'Ctrl+Z 回到原始（改動 0）');
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => /已改動 2,304/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  ok(true, 'Ctrl+Y 重做（改動回到 2,304）');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => /尚未改動/.test(document.querySelector('.insp-foot')?.textContent ?? ''), null, { timeout: 30000 });
  pop = await openScope();
  await pop.locator('.ant-segmented-item', { hasText: '整個結構' }).click();
  await closeScope();
  await page.mouse.click(5, 5);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok((await focus()) === null && (await page.evaluate(() => window.__ed.sel.size)) === 1, 'Esc 離開聚焦，選取留著');

  // 原「3D 雕刻關：在已選結構上左鍵拖不改體素」→ v10：不在聚焦模式時，在已選結構上左鍵拖只轉視角
  const c3 = await page.locator('.pane-3d .canvas-wrap').boundingBox();
  const foot = () => page.locator('.insp-foot').innerText();
  const f0 = await foot();
  const h0 = await page.evaluate(() => window.__ed.hist.length);
  for (const [dx, dy] of [[0, 0], [40, 0], [-40, 0], [0, 40], [0, -40]]) {
    const x = c3.x + c3.width / 2 + dx;
    const y = c3.y + c3.height / 2 + dy;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 6 });
    await page.mouse.up();
  }
  await page.waitForTimeout(500);
  ok((await foot()) === f0 && (await page.evaluate(() => window.__ed.hist.length)) === h0 && (await focus()) === null, '不在聚焦編輯時拖已選結構不改體素（只轉視角）');
  if (shots) await page.screenshot({ path: `${shots}/m0-3d.png` });

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
