// M17（plan v17 §3、§4、§7）：簡化版的整條路徑。
// G1：Poly-Si 2 加高 2 格（SiN 跟著）→ Si fin 1 往左搬 3 格 → 換材質 → 復原最後一步 → 匯出（解回來和畫面上的體素相同）。
// 七條規則：沒有捲軸、沒選取時面板反灰、按鈕上有鍵帽、做不到時按鈕反灰並寫原因、做完說清楚每個鄰居（都寫出幾格）。
// 另外：版面（三張切面一排、3D 在上）、鍵盤每個鍵、Shift 多選同材質、材質列＝顯示／隱藏、「改了哪些」跟著復原／重做增減。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m17.cjs [http://localhost:5173] [截圖資料夾]`
const { chromium } = require('playwright');
const fs = require('fs');

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
  await page.getByRole('button', { name: /簡單範例/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
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
  ok((await page.locator('.panel .who').innerText()).includes('跟著移動：SiN'), '事先寫出誰會跟著（SiN）');
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
  ok(/Si fin 1 往左搬 3 格/.test(note) && /跟著移動 3 格/.test(note) && /變薄、另一側變厚 3 格/.test(note), `G1-2 做完的說明：${note}`);

  // ---- G1-3：換材質 ----
  await page.getByRole('radio', { name: '換材質' }).click();
  await page.locator('.panel .mats button', { hasText: 'SiGe epi' }).click();
  await waitSteps(3);
  note = await foot();
  ok(/Si fin 1 換成 SiGe epi（現在叫 SiGe epi \d）/.test(note), `G1-3 換材質、名字跟著重新編號：${note}`);
  ok((await page.getByTestId('step-list').locator('.ch').count()) === 3, '「改了哪些」一步一筆（3 筆）');

  // ---- G1-4：復原最後一步、匯出 ----
  await page.locator('.insp-foot a', { hasText: '復原' }).click();
  await page.waitForFunction(() => window.__ed.hist.length === 2);
  ok((await page.getByTestId('step-list').locator('.ch').count()) === 2, '復原後清單少一筆');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.getByRole('button', { name: '匯出' }).click()]);
  const bytes = fs.readFileSync(await dl.path());
  const same = await page.evaluate(async (b64) => {
    const { decodeVti } = await import('/src/volume/vti.ts');
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const { vol } = await decodeVti(bin.buffer);
    const cur = window.__ed.cur.vol;
    if (vol.X !== cur.X || vol.Y !== cur.Y || vol.Z !== cur.Z) return 'dims';
    let bad = 0;
    for (let i = 0; i < cur.data.length; i++) if (vol.data[i] !== cur.data[i]) bad++;
    return bad;
  }, bytes.toString('base64'));
  ok(same === 0, `匯出的 .vti 解回來和畫面上的體素相同（${bytes.length.toLocaleString()} 位元組，不同 ${same} 格）`);

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
  await page.getByRole('radio', { name: '留在原地' }).click();
  await page.locator('.panel .faces button', { hasText: '上' }).click();
  await page.locator('.panel .step input').fill('1');
  // 內建範例的 HfO₂ 是 2 格：留在原地可以推 1 格，之後 HfO₂ 只剩 1 格就擋下
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.out && window.__ed.probe.out.n === 1, null, { timeout: 30000 });
  ok((await page.locator('.panel .who').innerText()).includes('最多可外推 1 格（到 HfO₂'), '事先寫出最多可外推 1 格與原因');
  const s0 = await steps();
  await page.getByTestId('grow').click();
  await waitSteps(s0 + 1);
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.out && window.__ed.probe.out.n === 0, null, { timeout: 30000 });
  ok(await page.getByTestId('grow').isDisabled(), '留在原地推 fin 上面：外推鈕反灰');
  const who = await page.locator('.panel .who').innerText();
  ok(/不能外推：HfO₂ \d+ 只剩 1 格（先把 HfO₂ \d+ 往外推，或改用跟著移動）/.test(who), `寫出原因與解法：${who}`);
  await page.getByRole('radio', { name: '跟著移動' }).click();
  await page.waitForFunction(() => window.__ed.probe && window.__ed.probe.out && window.__ed.probe.out.n > 0, null, { timeout: 30000 });
  ok((await page.locator('.panel .who').innerText()).includes('最多可外推'), '跟著移動時寫出最多可外推幾格');

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
