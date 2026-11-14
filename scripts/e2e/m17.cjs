// M17（plan v17 §3、§4、§7）：簡化版的整條路徑。
// G1：Poly-Si 2 加高 2 格（SiN 跟著）→ Si fin 1 往左搬 3 格 → 換材質 → 復原最後一步（plan v19 起沒有匯出）。
// 七條規則：沒有捲軸、沒選取時面板反灰、按鈕上有鍵帽、做不到時按鈕反灰並寫原因、做完說清楚每個鄰居（都寫出幾格）。
// 另外：版面（三張切面一排、3D 在上）、鍵盤每個鍵、Shift 多選同材質、材質列＝顯示／隱藏、「改了哪些」跟著復原／重做增減。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m17.cjs [http://localhost:5173] [截圖資料夾]`
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const shots = process.argv[3] || null;
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  await page.locator('.slices-bar').click(); // plan v19：2D 切面預設收起，先展開
  const steps = () => page.evaluate(() => window.__ed.hist.length);
  const waitSteps = (n) => page.waitForFunction((k) => window.__ed.hist.length === k && !window.__ed.busy, n, { timeout: 60000 });
  const idle = () => page.waitForFunction(() => !window.__ed.busy, null, { timeout: 60000 });
  const probeReady = () => page.waitForFunction(() => !!window.__ed.probe, null, { timeout: 30000 });
  const foot = () => page.locator('.insp-foot .foot-msg').innerText();
  const pick = async (label, mods) => {
    const name = page.locator('.item-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await page.locator('.item', { has: name }).first().click(mods ? { modifiers: mods } : undefined);
  };

  // ---- 版面與規則 1～3 ----
  const lay = await page.evaluate(() => {
    const b = (el) => el.getBoundingClientRect();
    const p3 = b(document.querySelector('.pane-3d'));
    const sl = [...document.querySelectorAll('.slice-pane')].map(b);
    return { scroll: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth, p3, sl, inner: [innerWidth, innerHeight] };
  });
  ok(!lay.scroll, '1280×720 沒有捲軸');
  ok(lay.sl.length === 3 && lay.sl.every((s) => Math.abs(s.top - lay.sl[0].top) < 1) && lay.sl.every((s) => s.bottom <= lay.inner[1]), '三張切面排成一排、都在畫面裡');
  ok(lay.sl[0].top > lay.p3.bottom - 1, '3D 在上、切面在下（和原版同位置）');
  ok(await page.locator('.panel.off').isVisible(), '沒選取時面板反灰');
  ok((await page.locator('.panel .empty').innerText()).includes('先在 3D、切面或左邊的清單點一個結構'), '沒選取時面板寫要先點結構');

  // ---- G1-1：Poly-Si 2 上面外推 2 格（SiN 跟著） ----
  await pick('Poly-Si 2');
  await page.waitForFunction(() => window.__handles && window.__handles().length === 6);
  ok(true, '選到就有六支箭頭');
  await page.locator('.panel .faces button', { hasText: '上' }).click();
  await page.locator('.panel .step input').fill('2');
  await probeReady();
  ok(/SiN[^\n]*\n?\s*跟著移動/.test(await page.locator('.panel .who').innerText()), '事先寫出誰會跟著（SiN）');
  ok((await page.locator('.panel .faces .kcap').count()) === 6 && (await page.getByTestId('grow').locator('.kcap').count()) === 1, '按鈕上有鍵帽');
  await page.getByTestId('grow').click();
  await waitSteps(1);
  let note = await foot();
  ok(/Poly-Si 2 上面外推 2 格（1\.0 nm）/.test(note) && /SiN 跟著移動 2 格/.test(note), `G1-1 做完的說明：${note}`);

  // ---- G1-2：Si fin 1 往左搬 3 格 ----
  await pick('Si fin 1');
  await page.getByRole('radio', { name: '整塊平移' }).click();
  await page.locator('.panel .step input').fill('3');
  await probeReady();
  await page.locator('.dpad button', { hasText: '左' }).click();
  await waitSteps(2);
  note = await foot();
  ok(/Si fin 1 往左搬 3 格/.test(note) && /跟著移動 3 格/.test(note), `G1-2 做完的說明：${note}`);

  // ---- G1-3：換材質 ----
  await page.getByRole('radio', { name: '換材質' }).click();
  await page.locator('.panel .mats button', { hasText: 'SiGe epi' }).click();
  await waitSteps(3);
  note = await foot();
  ok(/Si fin 1 換成 SiGe epi（現在叫 SiGe epi \d）/.test(note), `G1-3 換材質、名字跟著重新編號：${note}`);
  ok((await page.getByTestId('step-list').locator('.ch').count()) === 3, '「改了哪些」一步一筆（3 筆）');

  // ---- G1-4：復原最後一步（plan v19：沒有匯出） ----
  await page.locator('.insp-foot a', { hasText: '復原' }).click();
  await page.waitForFunction(() => window.__ed.hist.length === 2);
  ok((await page.getByTestId('step-list').locator('.ch').count()) === 2, '復原後清單少一筆');
  ok((await page.getByRole('button', { name: '匯出' }).count()) === 0, '沒有匯出按鈕');

  // ---- 重做／Ctrl+Z／Ctrl+Y ----
  await page.keyboard.press('Control+y');
  await page.waitForFunction(() => window.__ed.hist.length === 3);
  ok(true, 'Ctrl+Y 重做');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__ed.hist.length === 2);
  ok(true, 'Ctrl+Z 復原');

  // ---- 規則 6、7：做不到要事先看得出來 ----
  await page.getByRole('radio', { name: '推拉一面' }).click();
  await pick('Si fin 2');
  await page.locator('.panel .faces button', { hasText: '上' }).click();
  await page.locator('.panel .step input').fill('1');
  // plan v21／v22：右鍵固定。TiN 整個材質完全鎖定 → Si fin 2 上面推不動，寫出被誰擋、可以一鍵解除
  await page.locator('.group-head', { hasText: 'TiN' }).click({ button: 'right' });
  ok((await page.getByTestId('lock-menu').innerText()).includes('完全鎖定'), '右鍵出現固定選單');
  ok((await page.getByTestId('lock-menu').innerText()).includes('選取') === false, '選單裡沒有「選取」');
  await page.getByTestId('lock-full').click();
  ok(/已固定：TiN ×\d+（完全鎖定）/.test(await foot()), `固定後底下寫出來：${await foot()}`);
  ok((await page.getByTestId('lock-panel').innerText()).includes('TiN'), '右欄「固定的結構」列出 TiN');
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.out && window.__ed.probe.out.n === 0, null, { timeout: 30000 });
  ok(await page.getByTestId('grow').isDisabled(), '外層完全鎖定：外推鈕反灰');
  const who = await page.locator('.panel .who').innerText();
  ok(/不能外推：被完全鎖定的 TiN \d+ 擋住/.test(who) && who.includes('解除固定'), `寫出原因與解法：${who.replace(/\n/g, ' ')}`);
  ok((await steps()) === 2, '固定不算一步');
  // 改成可被壓薄（右欄的卡片）：又可以推了
  await page.getByTestId('lock-panel').locator('.seg button', { hasText: '可被壓薄' }).click();
  // TiN 本身就是 1.0 nm 厚：最少留 1.0 nm 還是推不動，調成 0.5 nm 才讓得出一格
  await page.getByTestId('lock-panel').locator('.keep button').first().click();
  ok((await page.getByTestId('lock-panel').innerText()).includes('0.5 nm'), '右欄可以調最少保留的厚度');
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.out && window.__ed.probe.out.n > 0, null, { timeout: 30000 });
  ok(/最多可外推 \d+/.test(await page.locator('.panel .who').innerText()), '改成可被壓薄：寫出最多可外推幾格');
  const s0 = await steps();
  await page.getByTestId('grow').click();
  await waitSteps(s0 + 1);
  ok(/TiN 變薄 1 格/.test(await foot()), `固定的 TiN 被壓薄：${await foot()}`);
  // 選到固定的結構：只剩一張卡片，沒有箭頭
  await page.locator('.group-head', { hasText: 'TiN' }).locator('.group-caret').click();
  await pick('TiN 1');
  ok((await page.getByTestId('lockbar').innerText()).includes('已固定'), '選到固定的結構：面板寫已固定');
  ok((await page.evaluate(() => window.__handles().length)) === 0, '固定的結構沒有箭頭');
  await page.getByTestId('unlock-all').click();
  ok((await page.getByTestId('lock-panel').innerText()).includes('還沒有固定的結構'), '全部解除');
  // 內縮到整個消失：先問
  await pick('SiN 1');
  await page.locator('.panel .faces button', { hasText: '上' }).click();
  await page.locator('.panel .step input').fill('20');
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.vanishAt > 0, null, { timeout: 30000 });
  const s1 = await steps();
  await page.getByTestId('shrink').click();
  ok((await page.getByTestId('vanish-ask').innerText()).includes('SiN 1 整個消失'), '內縮到消失：先問');
  await page.getByTestId('ask-safe').click();
  await waitSteps(s1 + 1);
  ok((await page.evaluate(() => window.__ed.comps.some((c) => c.label === 'SiN 1'))), '選「只縮到還保留」：SiN 1 還在');
  await page.locator('.insp-foot a', { hasText: '復原' }).click();
  await page.waitForFunction((k) => window.__ed.hist.length === k && !window.__ed.busy, s1);
  await pick('Si fin 2');
  await page.locator('.panel .step input').fill('1');
  await page.locator('.pane-3d .pane-head').click();

  // ---- 鍵盤 ----
  for (const [key, face] of [['ArrowDown', '下'], ['ArrowLeft', '左'], ['ArrowRight', '右'], ['PageDown', '前'], ['PageUp', '後'], ['ArrowUp', '上']]) {
    await page.keyboard.press(key);
    await page.waitForFunction((f) => window.__ed.face === f, face);
  }
  ok(true, '推拉時方向鍵／PgUp／PgDn 選面（模型的上下左右前後）');
  await page.locator('.panel .step input').fill('1');
  await page.locator('.pane-3d .pane-head').click();
  const n0 = await steps();
  await page.keyboard.press('+');
  await waitSteps(n0 + 1);
  await page.keyboard.press('-');
  await waitSteps(n0 + 2);
  ok(true, '＋／－ 外推／內縮一次');
  await page.getByRole('radio', { name: '整塊平移' }).click();
  await page.locator('.pane-3d .pane-head').click();
  await probeReady();
  await page.keyboard.press('ArrowRight');
  await waitSteps(n0 + 3);
  ok((await foot()).includes('往右搬 1 格'), '平移時方向鍵＝往那邊搬一次');
  await page.keyboard.press('Control+a');
  await page.waitForFunction(() => window.__ed.sel.size === 3);
  ok(true, 'Ctrl+A＝選全部同材質');
  await page.keyboard.press('f');
  await page.keyboard.press('h');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__ed.sel.size === 0);
  ok(true, 'F／H 不出錯、Esc 取消選取');

  // ---- 多選：只收相同材質 ----
  await pick('Poly-Si 1');
  await pick('SiN 1', ['Shift']);
  ok((await page.evaluate(() => window.__ed.sel.size)) === 1, 'Shift＋點不同材質不加入');
  await pick('Poly-Si 3', ['Shift']);
  ok((await page.evaluate(() => window.__ed.sel.size)) === 2, 'Shift＋點同材質加入');
  ok(await page.locator('.panel .all-same').isVisible(), '還沒全選時有「選全部 Poly-Si」');

  // ---- 材質列＝顯示／隱藏；隱藏目前選取的材質會取消選取 ----
  await page.locator('.group[data-mat="2"] .group-head').click();
  ok((await page.evaluate(() => [...window.__ed.hidden])).includes(2), '點材質列＝在 3D 隱藏');
  await page.locator('.group[data-mat="2"] .group-head').click();
  ok(!(await page.evaluate(() => [...window.__ed.hidden])).includes(2), '再點一次＝顯示');
  await page.locator('.group[data-mat="6"] .group-head').click();
  ok((await page.evaluate(() => window.__ed.sel.size)) === 0, '隱藏目前選取的材質會取消選取');
  await page.locator('.group[data-mat="6"] .group-head').click();

  // ---- 全部還原（可以復原） ----
  const before = await steps();
  await page.locator('.ch-head a', { hasText: '全部還原' }).click();
  await page.locator('.ant-popconfirm .ant-btn-primary').click();
  await page.waitForFunction(() => window.__ed.diffCount === 0);
  ok((await steps()) === before + 1, '全部還原是一步');
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.__ed.diffCount > 0);
  ok(true, '全部還原可以復原');
  await idle();
  if (shots) await page.screenshot({ path: `${shots}/m17-end.png` });
  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
