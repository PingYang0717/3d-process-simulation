// M3 驗收（plan v7 §13 M3）：第一次用的人照提示三步內「三根 fin 一起補方頭」；不用滑鼠用右欄數值做到同一件事、得到相同 Op；
// 對應到長得一樣的結構；切面右鍵選單。先 `npm run dev`，再 `node scripts/e2e/m3.cjs [url] [截圖資料夾]`
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
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  const ed = (fn, arg) => page.evaluate(fn, arg);
  const idle = async () => {
    await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 60000 });
    await page.waitForTimeout(200);
  };
  const screenOf = async (u, v) => {
    const b = await page.locator('.sedit-img').boundingBox();
    const [W, H] = await ed(() => [window.__ed.vol.X, window.__ed.vol.Y]);
    return [b.x + (u / W) * b.width, b.y + (v / H) * b.height];
  };
  const drag = async (from, to) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / 8, from[1] + ((to[1] - from[1]) * k) / 8);
    await page.mouse.up();
  };

  // 三步：點「Si fin」（三根）→ E → 浮動工具列「方頭（整根）」
  await page.locator('.group-name', { hasText: 'Si fin' }).first().click();
  await page.keyboard.press('e');
  await page.locator('.main-slice').waitFor();
  await page.locator('.sedit-first').waitFor({ timeout: 5000 });
  ok(await page.locator('.sedit-first').isVisible(), '第一次用：左下角顯示「靠近點可以拖 · 靠近邊可以推 · 在裡面可以搬」');
  const btn = page.locator('.float-tb').getByText(/方頭（整根）/);
  await btn.waitFor({ timeout: 5000 });
  ok(await btn.isVisible(), '浮動工具列貼在選取旁，按鈕寫「方頭（整根）」');
  await btn.click();
  await idle();
  const op1 = await ed(() => window.__ed.active.ops.at(-1));
  const t1 = await ed(() => window.__ed.last.text);
  ok(op1.kind === 'level' && op1.keys.length === 3, `三根 fin 一起補方頭：${t1}`);
  ok(/已套用到整個結構（z 0～127）/.test(t1), '訊息帶「已套用到…（z 0～127）」');
  if (shots) await page.screenshot({ path: `${shots}/m3-level.png` });
  await page.keyboard.press('Control+z');
  await idle();

  // 拖節點 vs 右欄數值：同一個 Op（只選 fin 3，對應不影響）
  await page.locator('.item-name', { hasText: /^Si fin 3$/ }).click();
  await page.waitForTimeout(300);
  const f3 = await ed(() => window.__ed.selComps[0].bbox);
  const z = await ed(() => window.__ed.cursor[2]);
  void z;
  // 拖右邊（直邊，但上面有斜角，不是橫跨整根 → profile）往右 2
  const midV = Math.round((f3.y0 + f3.y1) / 2) + 6;
  const p0 = await screenOf(f3.x1 + 1, midV);
  const p1 = await screenOf(f3.x1 + 3, midV);
  await drag(p0, [p1[0] + 1, p1[1]]);
  await idle();
  const opA = await ed(() => JSON.stringify(window.__ed.active?.ops.at(-1) ?? null));
  ok(JSON.parse(opA)?.kind === 'profile', `拖右邊往右 2 → ${JSON.parse(opA)?.kind}（${await ed(() => window.__ed.last?.text)}）`);
  await page.keyboard.press('Control+z');
  await idle();
  // 點一下選邊 → 右欄「往外推」2 → Enter
  await page.mouse.click(p0[0], p0[1]);
  await page.waitForTimeout(200);
  ok(await page.locator('.insp-body').getByText('選到的邊').isVisible(), '點邊 → 右欄出現「選到的邊」');
  const nIn = page.locator('.insp-body .field').filter({ hasText: /往外推/ }).locator('input');
  await nIn.fill('2');
  await nIn.press('Enter');
  await idle();
  const opB = await ed(() => JSON.stringify(window.__ed.active.ops.at(-1)));
  ok(opA === opB, '右欄數值和拖拉產生完全相同的 Op');
  // 焦點還在輸入框裡時 Ctrl+Z 是輸入框自己的復原：先離開輸入框
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Control+z');
  await idle();
  await page.keyboard.press('Escape');

  // 對應：選三根，拖 fin 1 的節點 → 三根一起
  await page.locator('.group-name', { hasText: 'Si fin' }).first().click();
  await page.waitForTimeout(300);
  const f1 = await ed(() => window.__ed.selComps.map((c) => c.bbox).sort((a, b) => a.x0 - b.x0)[0]);
  const n1 = await ed(([z, x0, x1]) => {
    const e = window.__ed;
    for (let v = 0; v < e.vol.Y; v++)
      for (let u = x1; u >= x0; u--) if (e.vol.data[(z * e.vol.Y + v) * e.vol.X + u] === 3) return [u + 1, v];
    return null;
  }, [z, f1.x0, f1.x1]);
  const q0 = await screenOf(n1[0], n1[1]);
  const q1 = await screenOf(n1[0] + 2, n1[1]);
  await drag(q0, [q1[0] + 1, q1[1]]);
  await idle();
  const opC = await ed(() => window.__ed.active.ops.at(-1));
  ok(opC.kind === 'profile' && opC.keys.length === 3, `對應開著：拖一根的節點，三根一起改（${await ed(() => window.__ed.last.text)}）`);
  ok(!(await page.locator('.sedit-first').isVisible().catch(() => false)), '成功拖過一次之後提示不再顯示');
  await page.keyboard.press('Control+z');
  await idle();

  // 切面右鍵選單
  const c = await screenOf(f3.x0 + 3, f3.y0 + 20);
  await page.mouse.click(c[0], c[1], { button: 'right' });
  await page.waitForTimeout(200);
  ok(await page.locator('.ctxmenu').isVisible(), '主切面右鍵：選單');
  await page.keyboard.press('Escape');
  if (shots) await page.screenshot({ path: `${shots}/m3-end.png` });

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
