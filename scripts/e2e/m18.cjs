// M18（plan v18 §5）：開啟直接是主畫面（自動載入簡單範例）；切面放大成主畫面、滾輪縮放、拖拉平移、Esc 還原；範例載入失敗時可以重試。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m18.cjs [http://localhost:5173] [截圖資料夾]`
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const shots = process.argv[3] || null;
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

async function run(browser, W, H, withUpload) {
  console.log(`---- ${W}×${H} ----`);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // ---- 1. 不經任何點擊就是主畫面 ----
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__ed && !window.__ed.busy && window.__ed.meta.name === '簡單範例', null, { timeout: 60000 });
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });
  ok((await page.locator('.slice-pane').count()) === 3, '開啟就有 3D 與三張切面（沒有點任何東西）');
  ok((await page.locator('.group').count()) >= 7, '左欄有結構');
  ok((await page.locator('.topbar').innerText()).includes('簡單範例'), '頂端列寫「簡單範例」');
  ok(!(await page.getByText('開始編輯 3D 模型').count()) && !(await page.locator('.welcome').count()), '沒有歡迎頁');
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.slice-img canvas.sedit-pv')).position === 'absolute'), '小切面的即時預覽層疊在底圖上');

  const rects = () =>
    page.evaluate(() => {
      const b = (el) => {
        const r = el.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height];
      };
      return { p3: b(document.querySelector('.pane-3d')), sl: [...document.querySelectorAll('.slice-pane')].map(b) };
    });
  const before = await rects();
  await page.evaluate(() => (window.__canvas3d = document.querySelector('.pane-3d canvas')));

  // ---- 3. 沒選結構也能放大；3D 不重建 ----
  ok((await page.evaluate(() => window.__ed.sel.size)) === 0, '（還沒選任何結構）');
  await page.locator('.slice-pane[data-axis=z] .slice-zoom').click();
  await page.locator('.slice-pane.big .sedit-img').waitFor();
  const lay = await rects();
  const bigW = await page.evaluate(() => document.querySelector('.slice-pane.big').getBoundingClientRect().width);
  ok(bigW > lay.p3[2], `XY 變成主畫面（${Math.round(bigW)} px > 3D 小窗 ${Math.round(lay.p3[2])} px）`);
  ok(await page.evaluate(() => window.__canvas3d === document.querySelector('.pane-3d canvas') && window.__canvas3d.isConnected), '3D 的 canvas 是同一個（沒有重建）');
  ok((await page.locator('.slice-pane:not(.big)').count()) === 2, '另外兩張切面還在');
  ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth), '放大後沒有捲軸');
  ok(await page.evaluate(() => [...document.querySelectorAll('.pane')].every((p) => p.getBoundingClientRect().bottom <= innerHeight + 1 && p.getBoundingClientRect().right <= innerWidth + 1)), '每一格都在畫面裡');
  if (shots) await page.screenshot({ path: `${shots}/m18-big-${W}.png` });

  // ---- 4. 滾輪縮放、拖拉平移、適合、Ctrl＋滾輪換片 ----
  // 先等兩幀：拖拉、縮放後 React 已經把新的位置畫上去
  const view = () =>
    page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const h = document.querySelector('.sedit').getBoundingClientRect();
      const r = document.querySelector('.sedit-img').getBoundingClientRect();
      return { host: [h.left, h.top, h.width, h.height], img: [r.left, r.top, r.width, r.height], zoom: parseFloat(document.querySelector('.sedit-zoom').textContent), z: window.__ed.cursor[2] };
    });
  const v0 = await view();
  ok(v0.img[0] >= v0.host[0] && v0.img[1] >= v0.host[1] && v0.img[0] + v0.img[2] <= v0.host[0] + v0.host[2] + 1 && v0.img[1] + v0.img[3] <= v0.host[1] + v0.host[3] + 1, `第一次放大＝整張放進視窗（${v0.zoom}×）`);
  // 滑鼠放在圖上 30%、40% 的地方
  const mx = v0.img[0] + v0.img[2] * 0.3;
  const my = v0.img[1] + v0.img[3] * 0.4;
  await page.mouse.move(mx, my);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
  await page.waitForFunction((z) => parseFloat(document.querySelector('.sedit-zoom').textContent) > z, v0.zoom);
  const v1 = await view();
  ok(v1.zoom > v0.zoom * 2, `滾輪放大：${v0.zoom}× → ${v1.zoom}×`);
  ok(near((mx - v1.img[0]) / v1.img[2], 0.3, 0.002) && near((my - v1.img[1]) / v1.img[3], 0.4, 0.002), '滑鼠下的體素不變');
  ok(v1.z === v0.z, '滾輪不換片');
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForFunction((z) => window.__ed.cursor[2] === z + 1, v0.z);
  const v2 = await view();
  ok(v2.zoom === v1.zoom, 'Ctrl＋滾輪換片（z ＋1），倍率不變');
  // 左鍵拖＝平移，不選取
  await page.mouse.down();
  await page.mouse.move(mx + 60, my + 35, { steps: 4 });
  await page.mouse.up();
  const v3 = await view();
  ok(near(v3.img[0] - v2.img[0], 60) && near(v3.img[1] - v2.img[1], 35), '左鍵拖＝平移');
  ok((await page.evaluate(() => window.__ed.sel.size)) === 0, '拖拉不會選到東西');
  // 右鍵拖也是平移
  await page.mouse.move(mx, my);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(mx - 40, my - 20, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  const v4 = await view();
  ok(near(v4.img[0] - v3.img[0], -40) && near(v4.img[1] - v3.img[1], -20), `右鍵拖＝平移（${v4.img[0] - v3.img[0]}, ${v4.img[1] - v3.img[1]}）`);
  if (shots) await page.screenshot({ path: `${shots}/m18-zoomed-${W}.png` });

  // ---- 8. 換方向再回來，縮放與位置還在 ----
  await page.locator('.slice-pane.big .pane-head .ant-segmented-item', { hasText: 'XZ 上視' }).first().click();
  await page.locator('.slice-pane.big[data-axis=y] .sedit-img').waitFor();
  ok((await page.locator('.slice-pane.big').count()) === 1 && (await page.locator('.slice-pane').count()) === 3, '切到 XZ：主畫面換成 XZ，仍是三張');
  await page.locator('.slice-pane[data-axis=z] .slice-zoom').click();
  await page.locator('.slice-pane.big[data-axis=z] .sedit-img').waitFor();
  const v5 = await view();
  ok(v5.zoom === v4.zoom && near(v5.img[0], v4.img[0]) && near(v5.img[1], v4.img[1]), '回到 XY：縮放與位置和離開時相同');
  await page.locator('.sedit-zoombar button', { hasText: '適合' }).click();
  const v6 = await view();
  ok(v6.zoom === v0.zoom && near(v6.img[0], v0.img[0]) && near(v6.img[1], v0.img[1]), '「適合」回到整張');

  // ---- 5. 點一下＝選結構 ----
  ok(await page.locator('.sedit-zoombar button', { hasText: '對準選取' }).isDisabled(), '沒選取時「對準選取」反灰');
  // 圖上 (u, v) = (80, 30)：中間那根閘極的 Poly-Si
  const at = (u, v, r) => [r.img[0] + ((u + 0.5) / 160) * r.img[2], r.img[1] + ((v + 0.5) / 96) * r.img[3]];
  const [px, py] = at(80, 30, v6);
  await page.mouse.click(px, py);
  await page.waitForFunction(() => window.__ed.sel.size === 1);
  const picked = await page.evaluate(() => ({ name: window.__ed.selName, cur: window.__ed.cursor.slice(0, 2) }));
  ok(picked.cur[0] === 80 && picked.cur[1] === 30, `點一下選到 ${picked.name}，十字移到 (80, 30)`);
  await page.locator('.sedit-zoombar button', { hasText: '對準選取' }).click();
  const v7 = await view();
  ok(v7.zoom !== v6.zoom, `「對準選取」（${v6.zoom}× → ${v7.zoom}×）`);

  // ---- 6. 放大時照樣能改，工具列在主切面上 ----
  await page.locator('.item', { has: page.locator('.item-name', { hasText: /^Poly-Si 2$/ }) }).first().click();
  await page.waitForFunction(() => window.__ed.sel.size === 1 && !!window.__ed.probe, null, { timeout: 30000 });
  const snap = () => page.evaluate(() => document.querySelector('.sedit-img canvas').toDataURL());
  const img0 = await snap();
  await page.getByRole('button', { name: /上面外推 1 格/ }).click();
  await page.waitForFunction(() => window.__ed.hist.length === 1 && !window.__ed.busy, null, { timeout: 60000 });
  const img1 = await snap();
  ok(img1 !== img0, '主切面上看得到外推的結果');
  const head = page.locator('.slice-pane.big .pane-head');
  ok((await head.locator('.ant-segmented.tb').count()) === 1 && (await page.locator('.pane-3d .pane-head .ant-segmented').count()) === 0, '「改後｜改前」在主切面的標題列（3D 小窗上沒有）');
  await head.locator('.ant-segmented.tb .ant-segmented-item', { hasText: '改前' }).click();
  await page.waitForFunction((a) => document.querySelector('.sedit-img canvas').toDataURL() !== a, img1, { timeout: 10000 });
  ok(true, '切到「改前」：主切面換成原始');
  await head.locator('.ant-segmented.tb .ant-segmented-item', { hasText: '改後' }).click();
  await page.waitForFunction((a) => document.querySelector('.sedit-img canvas').toDataURL() === a, img1, { timeout: 10000 });
  ok(true, '切回「改後」：主切面回到改過的樣子');
  await head.getByRole('button', { name: '復原' }).click();
  await page.waitForFunction(() => window.__ed.hist.length === 0 && !window.__ed.busy, null, { timeout: 60000 });
  ok(true, '主切面標題列的「復原」可以按');

  // ---- 7. Esc：先取消選取，再還原 ----
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__ed.sel.size === 0);
  ok((await page.locator('.slice-pane.big').count()) === 1, 'Esc 第一次：取消選取，切面還是放大的');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.slice-pane.big'));
  const after = await rects();
  const same = (a, b) => a.every((x, i) => near(x, b[i], 0.5));
  ok(same(after.p3, before.p3) && after.sl.every((s, i) => same(s, before.sl[i])), 'Esc 第二次：回到 3D 主畫面，3D 與三張切面的位置、大小和放大前相同');
  ok(await page.evaluate(() => window.__canvas3d === document.querySelector('.pane-3d canvas')), '回來後 3D 的 canvas 仍是同一個');
  // 小 3D 上的按鈕、主切面的「回 3D」也回得來
  await page.locator('.slice-pane[data-axis=x] .slice-zoom').click();
  await page.locator('.slice-pane.big[data-axis=x] .sedit-img').waitFor();
  await page.locator('.pane-3d .pane-expand').click();
  await page.waitForFunction(() => !document.querySelector('.slice-pane.big'));
  await page.locator('.slice-pane[data-axis=y] .slice-zoom').click();
  await page.locator('.slice-pane.big[data-axis=y] .sedit-img').waitFor();
  await page.getByRole('button', { name: /回 3D/ }).click();
  await page.waitForFunction(() => !document.querySelector('.slice-pane.big'));
  ok(true, '「回 3D」、小 3D 上的按鈕都回得來');

  // ---- 2. 上傳還在頂端列；換檔案後回到 3D 主畫面 ----
  if (withUpload) {
    await page.locator('.slice-pane[data-axis=z] .slice-zoom').click();
    await page.locator('.slice-pane.big .sedit-img').waitFor();
    await page.getByRole('button', { name: '上傳 .vti' }).click();
    await page.getByRole('button', { name: /複雜範例/ }).click();
    await page.waitForFunction(() => window.__ed.meta.name === '複雜範例' && !window.__ed.busy, null, { timeout: 120000 });
    ok((await page.locator('.topbar').innerText()).includes('複雜範例'), '頂端列「上傳 .vti」→ 複雜範例');
    await page.waitForFunction(() => !document.querySelector('.slice-pane.big'));
    ok(true, '載入新檔案後主畫面回到 3D');
  }
  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
  await page.close();
}

/** 範例載入失敗（Worker 的程式抓不到）：不留白畫面，有「重試」與「上傳 .vti」；重試後進主畫面。 */
async function runFail(browser) {
  console.log('---- 載入失敗 ----');
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  let block = true;
  await page.route(/worker/i, (r) => (block ? r.abort() : r.continue()));
  await page.goto(url);
  await page.locator('.boot[role=alert]').waitFor({ timeout: 30000 });
  ok((await page.locator('.boot').innerText()).includes('範例載入失敗'), 'Worker 起不來：畫面寫「範例載入失敗」');
  ok(await page.locator('.boot').getByRole('button', { name: /上傳 \.vti/ }).isEnabled(), '失敗時可以改用上傳');
  block = false;
  await page.locator('.boot').getByRole('button', { name: /重\s*試/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await page.waitForFunction(() => window.__ed && !window.__ed.busy && window.__ed.meta.name === '簡單範例', null, { timeout: 60000 });
  ok((await page.locator('.slice-pane').count()) === 3, '按「重試」後進主畫面');
  await page.close();
}

(async () => {
  const browser = await chromium.launch();
  await run(browser, 1600, 960, true);
  await run(browser, 1280, 720, false);
  await runFail(browser);
  await browser.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
