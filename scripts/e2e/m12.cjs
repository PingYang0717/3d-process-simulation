// plan v12 §7、§8 驗收（m12 §0～§7）：
// §0 改後不標色：改後模式操作一輪（套用、復原、切 split、換隱藏）沒有任何 diff:true／showDiff:true 的請求；3D 畫面沒有「拿掉的紅」，
//    Poly-Si 最亮的面不超過調色盤色、色相差 < 8°；
// §1 差異模式：按 D 到差異層換上的時間、改到的 chunk 數（圓頭 ≤ 6）；
// §2 實驗頁新使用者路徑（3×3：空狀態 → 選結構 → 加變數 → 點預設 chips → 組合表 → 產生）：試算不凍住、進度 k／N、停在實驗頁、
//    縮圖同一軸且有原始輪廓黑線、點卡片不送 Worker、勾 3 張疊圖 3 條線、在 3D 看 → 編輯頁；
// §3 圓頭半徑 −5 紅字、產生鈕反灰；水平等於標稱標「對照組」；
// §4 ×2 產生 20 個 split：heap 增量、只有 1 個 live、切 parked split 到網格換上的時間；200 個 split：DOM 卡片 ≤ 40、滑鼠移動 60 次整頁 render 0 次；
// §5 parked split 匯出 ≡ live 匯出（逐位元組）；
// §7 窄螢幕（1000 px）設計區變抽屜。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m12.cjs [http://localhost:5173]`；SKIP_X2=1 略過 ×2。
const { chromium } = require('playwright');

const url = process.argv[2] || 'http://localhost:5173';
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};
const info = (msg) => console.log('· ' + msg);

(async () => {
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForFunction(() => window.__ed);
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector('.busy-bar') && !window.__ed.busy, null, { timeout: 300000 }).catch(() => {});
    await page.waitForTimeout(500);
  };
  const load = async (s) => {
    await page.evaluate((s) => window.__ed.demo(s), s);
    await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 3'), null, { timeout: 120000 });
    await idle();
  };
  const select = (label) =>
    page.evaluate((label) => {
      const ed = window.__ed;
      ed.selectKeys([ed.comps.find((c) => c.label === label).key]);
    }, label);
  /** 3D 畫面的像素（截圖 → 瀏覽器裡解碼）。 */
  const pixels3d = async () => {
    const png = (await page.locator('.pane-3d .canvas-wrap canvas').first().screenshot()).toString('base64');
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return { data: Array.from(g.getImageData(0, 0, c.width, c.height).data), w: c.width };
    }, png);
  };
  const hue = (r, g, b) => {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx === mn) return 0;
    const d = mx - mn;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  // ---- §0 改後不標色 ----
  await load(1);
  await page.evaluate(() => (window.__calls = []));
  await select('Poly-Si 3');
  await page.evaluate(() => window.__ed.push([0, -1, 0], 3));
  await idle();
  await page.keyboard.press('Control+z');
  await idle();
  await page.keyboard.press('Control+y');
  await idle();
  await page.evaluate(() => window.__ed.addSplit());
  await idle();
  await page.evaluate(() => window.__ed.setActiveId(window.__ed.splits[0].id));
  await idle();
  await page.evaluate(() => window.__ed.toggleHidden(window.__ed.materials.find((m) => m.name.startsWith('SiN')).id));
  await idle();
  await page.evaluate(() => window.__ed.toggleHidden(window.__ed.materials.find((m) => m.name.startsWith('SiN')).id));
  await idle();
  const marked = await page.evaluate(() => window.__calls.filter((c) => c.diff === true || c.showDiff === true || c.filter === 'diff').length);
  ok(marked === 0, `§0 改後模式操作一輪（套用、復原、重做、切 split、換隱藏）：帶 diff 標記的請求 ${marked} 個`);
  await page.evaluate(() => window.__ed.clearSel());
  await page.keyboard.press('2');
  await page.waitForTimeout(1200);
  const { data: px, w: pw } = await pixels3d();
  const poly = await page.evaluate(() => window.__ed.materials.find((m) => m.name === 'Poly-Si').color);
  const pr = [1, 3, 5].map((k) => parseInt(poly.slice(k, k + 2), 16));
  let red = 0;
  let over = 0;
  let near = 0;
  let worstHue = 0;
  for (let i = 0; i < px.length; i += 4) {
    const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
    if (Math.abs(r - 255) <= 12 && Math.abs(g - 77) <= 12 && Math.abs(b - 79) <= 12) red++;
    // Poly-Si 色相附近、夠飽和的像素（面）
    const h = hue(r, g, b);
    const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / Math.max(1, Math.max(r, g, b));
    // 只看面的內部（4 鄰居同色）：反鋸齒的邊會和背景混色
    const flat = [-4, 4, -4 * pw, 4 * pw].every((o) => px[i + o] === r && px[i + o + 1] === g && px[i + o + 2] === b);
    if (flat && Math.abs(h - hue(...pr)) < 15 && sat > 0.4) {
      near++;
      worstHue = Math.max(worstHue, Math.abs(h - hue(...pr)));
      if (r > pr[0] + 3 || g > pr[1] + 3 || b > pr[2] + 3) over++;
    }
  }
  ok(red === 0, `§0 改後 3D 畫面沒有「拿掉的紅」±12 的像素（${red}）`);
  ok(near > 0 && over === 0, `§0 Poly-Si 的面（內部 ${near} px）沒有一個比調色盤色亮（超過 ${over}）`);
  ok(worstHue < 8, `§0 和調色盤色的色相差 ${worstHue.toFixed(1)}° < 8°`);

  // ---- §1 差異模式（×1） ----
  await page.keyboard.press('d');
  await page.waitForFunction(() => window.__diffAt, null, { timeout: 30000 });
  const d1 = await page.evaluate(() => window.__diffAt);
  ok(d1.chunks > 0 && d1.chunks <= 12, `§1 ×1 差異層只畫改到的 chunk（${d1.chunks} 個）· ${d1.ms.toFixed(0)} ms`);
  await page.keyboard.press('d');

  // ---- §2 實驗頁：新使用者路徑 ----
  await load(1);
  await page.evaluate(() => window.__ed.clearSel());
  await page.keyboard.press('Control+2');
  await page.locator('.lab').waitFor();
  ok((await page.locator('.lab-empty').count()) === 1, '§2 空狀態：結果區說明怎麼開始');
  ok((await page.locator('.lab-steps li.now').innerText()).includes('選結構'), '§2 步驟列停在 ① 選結構');
  await page.locator('.struct-pick .ant-select').click();
  await page.keyboard.type('Poly-Si 2');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const panel = page.locator('.design-panel');
  await panel.getByRole('button', { name: /加一個變數/ }).click();
  await panel.locator('.factor-new').getByRole('button', { name: /加入變數/ }).click();
  await panel.locator('.factor-card').first().getByRole('button', { name: /±1 nm/ }).click();
  await panel.getByRole('button', { name: /加一個變數/ }).click();
  await panel.locator('.factor-new .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('整塊移動', { exact: true }).click();
  await panel.locator('.factor-new .ant-segmented').first().getByText('z', { exact: true }).click();
  await panel.locator('.factor-new').getByRole('button', { name: /加入變數/ }).click();
  // 試算期間：整頁還在動、沒有長任務
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ type: 'longtask', buffered: false });
  });
  await panel.locator('.factor-card').nth(1).getByRole('button', { name: /±1 nm/ }).click();
  const rowsN = await panel.locator('.combo-body .combo-row').count();
  ok(rowsN === 9, `§2 組合表 ${rowsN} 列（3×3）`);
  ok((await panel.locator('.combo-row.control').count()) === 1, '§2 標稱×標稱那一列標「對照組」');
  await page.waitForFunction(() => document.querySelectorAll('.combo-body .anticon-loading').length === 0, null, { timeout: 60000 });
  const longs = await page.evaluate(() => window.__long);
  info(`§2 試算期間長任務：${longs.length} 個，最長 ${Math.max(0, ...longs).toFixed(0)} ms（軟體 WebGL 的容器，僅供參考）`);
  const prog = [];
  const poll = setInterval(() => page.evaluate(() => window.__ed.genProgress && `${window.__ed.genProgress.done + 1}/${window.__ed.genProgress.total}`).then((p) => p && prog.push(p)).catch(() => {}), 50);
  await panel.getByRole('button', { name: /產生 9 個 split/ }).click();
  await page.waitForFunction(() => window.__ed.splits.length === 9 && !window.__ed.busy, null, { timeout: 120000 });
  clearInterval(poll);
  ok(prog.length > 0, `§2 產生時有進度 k／N（看到 ${[...new Set(prog)].slice(0, 4).join('、')}…）`);
  ok((await page.evaluate(() => window.__ed.page)) === 'lab', '§2 產生後停在實驗頁');
  await page.waitForTimeout(2500);
  const axes = await page.locator('.sc-axis').allInnerTexts();
  ok(axes.length === 9 && new Set(axes.map((t) => t.split(' ')[0])).size === 1, `§2 9 張卡都有縮圖、同一個軸（${axes[0]}）`);
  const ink = await page.evaluate(() => {
    let n = 0;
    for (const c of document.querySelectorAll('.sc-thumb canvas')) {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] === 17 && d[i + 1] === 17 && d[i + 2] === 17) n++;
    }
    return n;
  });
  ok(ink > 0, `§2 縮圖疊了原始輪廓（黑線 ${ink} px）`);
  const c0 = await page.evaluate(() => window.__calls.length);
  await page.locator('.split-card').nth(2).click();
  await page.waitForTimeout(300);
  ok((await page.evaluate(() => window.__calls.length)) === c0, '§2 點卡片只高亮：沒有任何 Worker 請求（沒有 restore）');
  for (const k of [1, 2, 3]) await page.locator('.split-card').nth(k).locator('.ant-checkbox-input').check();
  await page.locator('.lab-toolbar').getByRole('button', { name: /比較勾選的/ }).click();
  await page.locator('.compare .ant-segmented').first().getByText('疊圖').click();
  await page.locator('.overlay-view').waitFor();
  ok((await page.locator('.overlay-legend .legend-row').count()) === 4, '§2 勾 3 張 → 疊圖 3 條線＋基準');
  await page.getByRole('button', { name: /回到結果/ }).click();
  const want = await page.locator('.split-card').nth(5).getAttribute('data-id');
  await page.locator('.split-card').nth(5).getByRole('button', { name: /在 3D 看/ }).click();
  await page.locator('.pane-3d').waitFor({ timeout: 30000 });
  await idle();
  ok((await page.evaluate(() => [window.__ed.page, window.__ed.activeId].join('|'))) === `edit|${want}`, '§2 在 3D 看 → 編輯頁、設為目前');

  // ---- §3 驗證 ----
  await page.keyboard.press('Control+2');
  await select('Poly-Si 3');
  await panel.getByRole('button', { name: /範本/ }).click();
  await page.getByText('清空設計').click();
  await panel.getByRole('button', { name: /加一個變數/ }).click();
  await panel.locator('.factor-new .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('圓頭半徑', { exact: true }).click();
  await panel.locator('.factor-new').getByRole('button', { name: /加入變數/ }).click();
  const seeded = await panel.locator('.factor-card .level-chip').allInnerTexts();
  ok(seeded.length === 3, `§3 圓頭標稱 0：預設 chips 2、4、6 格（${seeded.join('、')}）`);
  const card = panel.locator('.factor-card').first();
  await card.getByRole('button', { name: /自訂/ }).click();
  await card.getByLabel('自訂水平').fill('-5');
  await card.getByLabel('自訂水平').press('Enter');
  const msg = await card.locator('.ant-typography-danger').innerText();
  ok(msg.includes('半徑不能小於 0'), `§3 −5 → 紅字「${msg}」`);
  ok(await panel.getByRole('button', { name: /組合無效/ }).isDisabled(), '§3 產生鈕反灰（有 1 個組合無效）');

  // ---- §5 parked 匯出 ≡ live 匯出 ----
  const req5 = { format: 'vti1', spacing: [1, 1, 1], origin: [0, 0, 0], arrayName: 'material' };
  const pid = await page.evaluate(() => window.__ed.splits.find((x) => x.state === 'parked').id);
  const a5 = await page.evaluate(async ([id, req]) => Array.from(await window.__ed.exportBytes(window.__ed.splits.find((x) => x.id === id), req)), [pid, req5]);
  await page.evaluate((id) => window.__ed.setActiveId(id), pid);
  await page.waitForFunction((id) => window.__ed.splits.find((x) => x.id === id).state === 'live' && window.__ed.activeId === id, pid, { timeout: 60000 });
  const b5 = await page.evaluate(async ([id, req]) => Array.from(await window.__ed.exportBytes(window.__ed.splits.find((x) => x.id === id), req)), [pid, req5]);
  const same = a5.length === b5.length && a5.every((v, i) => v === b5[i]) && a5.length;
  ok(!!same, `§5 parked 匯出和 restore 成 live 後匯出逐位元組相同（${same} bytes）`);

  // ---- §4 200 個 split：視窗化、滑鼠移動不 render ----
  await page.evaluate(async () => {
    const ed = window.__ed;
    const key = ed.orig.L.comps.find((c) => c.label === 'Poly-Si 1').key;
    const a = { id: 'dx', name: 'dx', keys: [key], op: 'translate', param: 'd', template: { axis: 0 }, unit: 'vx', nominal: 0, mode: 'relative' };
    const b = { id: 'dz', name: 'dz', keys: [key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
    await ed.addDesign({ factors: [a, b], levels: { dx: Array.from({ length: 20 }, (_, i) => i - 10), dz: Array.from({ length: 10 }, (_, i) => i - 5) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
  });
  await idle();
  const n200 = await page.evaluate(() => window.__ed.splits.length);
  ok(n200 >= 200, `§4 產生 200 個 split（共 ${n200}）`);
  await page.waitForTimeout(1500);
  const dom = await page.locator('.split-card').count();
  ok(dom <= 40, `§4 DOM 裡只有 ${dom} 張卡（視窗化，≤ 40）`);
  const r0 = await page.evaluate(() => [window.__renders, window.__cardRenders]);
  for (let i = 0; i < 60; i++) await page.mouse.move(600 + (i % 20) * 30, 300 + (i % 9) * 40);
  const r1 = await page.evaluate(() => [window.__renders, window.__cardRenders]);
  ok(r1[0] - r0[0] === 0 && r1[1] - r0[1] === 0, `§4 滑鼠在實驗頁移動 60 次：整頁 render ${r1[0] - r0[0]} 次、卡片 render ${r1[1] - r0[1]} 次`);
  await page.evaluate(() => (window.__long = []));
  for (let k = 0; k < 10; k++) {
    await page.locator('.lab-grid').evaluate((el) => (el.scrollTop += 600));
    await page.waitForTimeout(120);
  }
  const lt = await page.evaluate(() => window.__long);
  info(`§4 捲動 10 頁：長任務 ${lt.length} 個，最長 ${Math.max(0, ...lt).toFixed(0)} ms；DOM 卡片 ${await page.locator('.split-card').count()} 張`);
  ok((await page.locator('.split-card').count()) <= 40, '§4 捲動後 DOM 卡片仍 ≤ 40');

  // ---- §7 窄螢幕 ----
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.waitForTimeout(500);
  ok((await page.locator('.lab-design').count()) === 0 && (await page.locator('.lab-toolbar').getByRole('button', { name: /^設\s*計$/ }).count()) === 1, '§7 1000 px：設計區變抽屜（工具列多「設計」）');
  await page.setViewportSize({ width: 1600, height: 960 });

  // ---- §4 ×2：記憶體與切換 ----
  if (!process.env.SKIP_X2) {
    await page.keyboard.press('Control+1');
    await load(2);
    const heap = () => page.evaluate(() => (window.gc?.(), performance.memory.usedJSHeapSize));
    const h0 = await heap();
    let peak = 0;
    const poll2 = setInterval(() => page.evaluate(() => performance.memory.usedJSHeapSize).then((h) => (peak = Math.max(peak, h))).catch(() => {}), 100);
    const t = await page.evaluate(async () => {
      const ed = window.__ed;
      const key = ed.comps.find((c) => c.label === 'Poly-Si 2').key;
      const f = { id: 'r', name: 'r', keys: [key], op: 'translate', param: 'd', template: { axis: 2 }, unit: 'vx', nominal: 0, mode: 'relative' };
      const t0 = performance.now();
      const ids = await ed.addDesign({ factors: [f], levels: { r: Array.from({ length: 20 }, (_, i) => (i % 2 ? 1 : -1) * (1 + (i >> 1))) }, combine: 'full', from: 'base', nameTemplate: '{id}={value}' });
      return { ms: performance.now() - t0, n: ids.length, states: ed.splits.map((s) => s.state[0]).join('') };
    });
    clearInterval(poll2);
    await idle();
    const h1 = await heap();
    const live = (await page.evaluate(() => window.__ed.splits.filter((s) => s.state === 'live' && s.buf).length));
    ok(t.n === 20 && live === 1, `§4 ×2 產生 20 個 split ${(t.ms / 1000).toFixed(1)} s：live ${live} 個（其他只留補丁）`);
    info(`§4 ×2 主執行緒 heap：產生期間最高 +${((peak - h0) / 1e6).toFixed(0)} MB、結束（含第一個 restore 成 live 的帳簿）+${((h1 - h0) / 1e6).toFixed(0)} MB`);
    ok(h1 - h0 < 250e6, `§4 ×2 heap 增量 ${((h1 - h0) / 1e6).toFixed(0)} MB < 250 MB（1 本 live 帳簿＋20 個補丁）`);
    const sw = await page.evaluate(async () => {
      const ed = window.__ed;
      const target = ed.splits.find((s) => s.state === 'parked' && s.stats.changed > 0);
      const t0 = performance.now();
      await ed.setActiveId(target.id);
      await new Promise((r) => {
        const f = () => ((window.__meshAt?.t ?? 0) > t0 ? r() : setTimeout(f, 20));
        f();
      });
      return window.__meshAt.t - t0;
    });
    ok(sw < 1500, `§4 ×2 切到 parked split 到 3D 換上網格 ${sw.toFixed(0)} ms < 1500`);
    await page.evaluate(() => (window.__diffAt = null, document.activeElement?.blur?.()));
    info(`§1 ×2 狀態：page ${await page.evaluate(() => window.__ed.page)}、diff ${await page.evaluate(() => window.__ed.diff.count)}、focus ${await page.evaluate(() => document.activeElement?.tagName)}`);
    await page.keyboard.press('d');
    await page.waitForFunction(() => window.__diffAt && window.__ed.diff.count, null, { timeout: 30000 });
    await page.waitForTimeout(2000);
    const d2 = await page.evaluate(() => window.__diffAt);
    ok(d2.ms < 1000, `§1 ×2 按 D 到差異層換上 ${d2.ms.toFixed(0)} ms（${d2.chunks} 個 chunk）`);
  }

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
