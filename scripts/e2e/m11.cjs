// plan v11 §7 驗收（m11 §0～§4）：
// §0 合成的 PointData 比例陣列＋FieldData .vti：上傳面板列出偵測結果、確認後左欄是 FieldData 的名字；
// §1 「實驗」頁籤：Poly-Si 2 往上 push（相對 1／2／3 nm）× translate z（−1／+1 nm）全因子 6 個；名字、矩陣表 6 列 2 欄；
// §2 疊圖 6 條線＋基準、自動放大；基準切到 split 2 時 split 3 的差異格數＝兩者 diff；CSV 行數＝split 數＋1；
// §3 cd +2 後 W 24 → 26；Poly-Si 2 往下 5 預設被擋、STI 不變；
// §4 預設沒有筆刷頁籤、沒有自由形變；fin 的換材質清單 TiN 不在「合理」裡。
// 用法：先 `npm run dev`，再 `node scripts/e2e/m11.cjs [http://localhost:5173]`
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const url = process.argv[2] || 'http://localhost:5173';
const ok = (cond, msg) => {
  if (!cond) throw new Error('✗ ' + msg);
  console.log('✓ ' + msg);
};

/** 4×3×2 點、三個比例陣列（ascii）＋FieldData 材質表。 */
function fractionVti() {
  const N = 24;
  const fr = [[], [], []];
  for (let i = 0; i < N; i++) {
    const v = i % 3 === 0 ? [0.7, 0.2, 0.1] : i % 3 === 1 ? [0.1, 0.25, 0.65] : [0, 1, 0];
    v.forEach((x, k) => fr[k].push(x));
  }
  const name = Array.from(Buffer.from('Si\0SiO2\0TiN\0')).join(' ');
  return `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32">
  <ImageData WholeExtent="0 3 0 2 0 1" Origin="0 0 0" Spacing="0.5 0.5 0.5">
    <FieldData>
      <DataArray type="Int32" Name="MaterialCode" NumberOfTuples="3" format="ascii">1 2 3</DataArray>
      <DataArray type="String" Name="MaterialName" NumberOfTuples="3" format="ascii">${name}</DataArray>
      <DataArray type="UInt8" Name="MaterialColor" NumberOfComponents="3" NumberOfTuples="3" format="ascii">200 200 190 150 210 230 140 150 170</DataArray>
    </FieldData>
    <Piece Extent="0 3 0 2 0 1">
      <PointData>
${fr.map((v, k) => `        <DataArray type="Float32" Name="material_${k + 1}" format="ascii">${v.join(' ')}</DataArray>`).join('\n')}
      </PointData>
    </Piece>
  </ImageData>
</VTKFile>
`;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const idle = async () => {
    await page.waitForFunction(() => !document.querySelector('.busy-bar, .mesh-busy'), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(400);
  };

  // ---- §0 檔案格式 ----
  const file = path.join(os.tmpdir(), 'm11-fraction.vti');
  fs.writeFileSync(file, fractionVti());
  await page.locator('input[type=file]').first().setInputFiles(file);
  await page.getByRole('dialog', { name: '確認偵測結果' }).waitFor();
  const summary = await page.locator('.load-confirm').innerText();
  ok(/比例陣列 3 個/.test(summary) && /FieldData 材質表 3 筆/.test(summary), `§0 上傳面板列出偵測結果：${summary.split('\n')[0]}`);
  await page.locator('.load-confirm').getByRole('button', { name: /載\s*入/ }).click();
  await page.locator('.pane-3d canvas').first().waitFor({ timeout: 60000 });
  await idle();
  const mats = await page.evaluate(() => window.__ed.materials.map((m) => m.name));
  ok(mats.includes('Si') && mats.includes('SiO2') && mats.includes('TiN'), `§0 左欄是 FieldData 的名字（${mats.join('、')}）`);
  ok(await page.evaluate(() => window.__ed.meta.fractions?.length === 3 && !!window.__ed.meta.raw), '§0 留著原檔與比例陣列（匯出照原格式）');

  // ---- §1 實驗頁籤 ----
  await page.evaluate(() => window.__ed.demo(1));
  await page.waitForFunction(() => window.__ed.comps.some((c) => c.label === 'Poly-Si 2'), null, { timeout: 60000 });
  await idle();
  await page.evaluate(() => {
    const ed = window.__ed;
    ed.selectKeys([ed.comps.find((c) => c.label === 'Poly-Si 2').key]);
  });
  await page.getByRole('tab', { name: '實驗' }).click();
  const tab = page.locator('.experiment-tab');
  // 變數 1：長／縮一面（上），相對 1／2／3 nm
  await tab.getByRole('button', { name: /新增變數/ }).click();
  await tab.locator('.factor-new .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('長／縮一面', { exact: true }).click();
  await tab.getByRole('button', { name: '加入變數' }).click();
  await tab.getByLabel('水平').nth(0).fill('1, 2, 3');
  // 變數 2：整塊移動 z，−1／+1
  await tab.getByRole('button', { name: /新增變數/ }).click();
  await tab.locator('.factor-new .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible').getByText('整塊移動', { exact: true }).click();
  await tab.locator('.factor-new .ant-segmented').first().getByText('z', { exact: true }).click();
  await tab.getByRole('button', { name: '加入變數' }).click();
  await tab.getByLabel('水平').nth(1).fill('-1, 1');
  const btn = tab.getByRole('button', { name: /產生 6 個 split/ });
  ok((await btn.count()) === 1, '§1 全因子 3 × 2 = 6 個 split');
  await btn.click();
  await page.waitForFunction(() => window.__ed.splits.length === 6, null, { timeout: 120000 });
  await idle();
  const names = await page.evaluate(() => window.__ed.splits.map((s) => s.name));
  ok(names.includes('PolySi2_top=+1nm_PolySi2_z=-1nm'), `§1 名字照樣板（${names[0]}…）`);
  ok(await page.evaluate(() => window.__ed.splits.every((s) => s.levels && Object.keys(s.levels).length === 2 && s.designId)), '§1 每個 split 帶 levels／designId');
  await page.getByRole('tab', { name: /矩陣/ }).click();
  const rows = await page.locator('.dim-table tbody tr.ant-table-row').count();
  const factorCols = await page.locator('.dim-table thead th .factor-dot').count();
  ok(rows === 6 && factorCols === 2, `§1 矩陣表 ${rows} 列、${factorCols} 個變數欄`);

  // ---- §2 比較 ----
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '匯出 CSV' }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
  ok(csv.length === 7, `§2 CSV 行數 ${csv.length}＝split 數＋1`);
  await page.getByRole('button', { name: '並排看' }).first().click();
  await page.locator('.compare').waitFor();
  await page.locator('.compare .ant-segmented').first().getByText('疊圖').click();
  await page.locator('.overlay-view').waitFor();
  const legend = await page.locator('.overlay-legend .legend-row').count();
  const paths = await page.locator('.overlay-stage svg path').count();
  ok(legend === 7 && paths === 7, `§2 疊圖 6 條線＋基準（圖例 ${legend} 列、${paths} 條路徑）`);
  const vb = await page.locator('.overlay-stage .slice-img > div').getAttribute('style');
  ok(/width: (?!100%)/.test(vb ?? ''), '§2 自動放大到差異外框');
  await page.locator('.overlay-legend .legend-swatch').nth(1).click();
  ok((await page.locator('.overlay-stage svg path').count()) === 6, '§2 點圖例色塊隱藏一條');
  const pair = await page.evaluate(() => {
    const ed = window.__ed;
    const [, b, c] = ed.splits;
    ed.setCompareBase(b.id);
    // plan v12：並排是切面級（parked split 不還原），比這一片
    const z = ed.cursor[2];
    const sb = window.__slab(ed, b.id, 'z', z);
    const sc = window.__slab(ed, c.id, 'z', z);
    let n = 0;
    for (let i = 0; i < sc.vol.data.length; i++) if (sc.vol.data[i] !== sb.vol.data[i]) n++;
    return { n, name: c.name };
  });
  await page.locator('.compare .ant-segmented').first().getByText('並排').click();
  await page.waitForTimeout(500);
  const cardText = await page.locator('.cmp-card').filter({ hasText: pair.name }).locator('.pane-head').innerText();
  ok(cardText.includes(`這片 ${pair.n.toLocaleString()} 格不同`), `§2 基準切到 split 2 時 split 3 這一片的差異＝${pair.n}`);
  await page.evaluate(() => window.__ed.setCompareBase('base'));
  // 關掉並排（Split 列上的切換鈕）
  await page.locator('.compare').waitFor();
  await page.locator('button:has(.anticon-appstore)').first().click();
  await page.locator('.compare').waitFor({ state: 'detached' });

  // ---- §3 新操作 ----
  const cd = await page.evaluate(async () => {
    const ed = window.__ed;
    ed.setActiveId('base');
    const k = ed.orig.L.comps.find((c) => c.label === 'Poly-Si 2').key;
    ed.selectKeys([k]);
    return k;
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__ed.commit(window.__ed.cdOp(2, 2, 'center')));
  await page.waitForFunction(() => window.__ed.hist.length === 1, null, { timeout: 60000 });
  await idle();
  const w = await page.evaluate((k) => {
    const c = window.__ed.L.comps.find((x) => x.key === k);
    return c.bbox.z1 - c.bbox.z0 + 1;
  }, cd);
  ok(w === 26, `§3 cd +2 後 W 24 → ${w}`);
  const sti0 = await page.evaluate(() => window.__ed.orig.vol.data.reduce((s, v) => s + (v === 2 ? 1 : 0), 0));
  await page.evaluate(() => window.__ed.push([0, 1, 0], 5));
  await page.waitForFunction(() => window.__ed.hist.length === 2 || (window.__ed.report && window.__ed.report.op.kind === 'push'), null, { timeout: 60000 });
  await idle();
  const after = await page.evaluate(() => ({ blocked: window.__ed.report.total.blocked, sti: window.__ed.vol.data.reduce((s, v) => s + (v === 2 ? 1 : 0), 0), policy: window.__ed.report.op.policy }));
  ok(after.policy === 'block' && after.blocked > 0 && after.sti === sti0, `§3 Poly-Si 2 往下 5 預設被擋（${after.blocked} 格）、STI 不變`);

  // ---- §4 收斂 ----
  ok(!(await page.evaluate(() => window.__ed.freeform)), '§4 自由形變預設關');
  const tabs = await page.locator('.edit-toolbar .ant-segmented').first().innerText();
  ok(!tabs.includes('筆刷'), '§4 預設沒有筆刷頁籤');
  await page.evaluate(() => {
    const ed = window.__ed;
    ed.selectKeys([ed.L.comps.find((c) => c.label === 'Si fin 1').key]);
  });
  await page.waitForTimeout(300);
  await page.locator('.edit-toolbar').getByRole('button', { name: /材質/ }).click();
  await page.locator('.ant-popover:visible .ant-select').first().click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().waitFor({ timeout: 5000 }).catch(() => {});
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  const opts = await page.locator('.ant-select-dropdown:visible .ant-select-item-option').allInnerTexts();
  ok(opts.some((t) => t.includes('VOID')) && !opts.some((t) => t.includes('TiN')), `§4 fin 的換材質只列合理目標（${opts.join('、')}），TiN 在「全部…」`);

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join(' | ') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
