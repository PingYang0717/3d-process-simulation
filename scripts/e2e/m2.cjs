// M2 驗收（plan v7 §13 M2 驗收腳本，範例 ×1）。
// plan v10：進 2D 剖面＝按兩下 E（瀏覽 → 3D 把手 → 2D 剖面）；「補平成方頭」→ 右欄「方頭／圓頭」切到「方頭」再按「套用方頭」。
// 先 `npm run dev`，再 `node scripts/e2e/m2.cjs [url] [截圖資料夾]`
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
    await page.waitForTimeout(150);
  };
  const lastText = () => ed(() => window.__ed.last?.text ?? '');
  const diffCount = async () => {
    await page.waitForTimeout(400);
    return ed(() => window.__ed.diff.count);
  };
  const select = async (name) => {
    await page.locator('.item-name', { hasText: new RegExp(`^${name}$`) }).click();
    await page.waitForTimeout(100);
  };
  /** 體素座標（切面 u, v，格子角）→ 螢幕座標。 */
  const screenOf = async (u, v) => {
    const b = await page.locator('.sedit-img').boundingBox();
    const [W, H] = await ed(() => [window.__ed.vol.X, window.__ed.vol.Y]);
    return [b.x + (u / W) * b.width, b.y + (v / H) * b.height];
  };
  /** 右欄「方頭／圓頭」：切到「方頭」、按「套用方頭」（預設往上）。 */
  const level = async () => {
    const seg = page.locator('.inspector .ant-segmented-item', { hasText: /^方頭$/ });
    await seg.scrollIntoViewIfNeeded();
    await seg.click();
    const btn = page.locator('.inspector .op-card button.ant-btn-primary', { hasText: '套用方頭' });
    await btn.click();
  };
  const drag = async (from, to) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / 8, from[1] + ((to[1] - from[1]) * k) / 8);
    await page.mouse.up();
  };

  // 1. Si fin 1 → 方頭（整根）
  await select('Si fin 1');
  await page.keyboard.press('e');
  await page.waitForFunction(() => window.__ed.focus?.view === '3d');
  await page.keyboard.press('e');
  await page.locator('.main-slice').waitFor();
  const fin = await ed(() => window.__ed.selComps[0].bbox);
  await level();
  await idle();
  const t1 = await lastText();
  ok(/(補平|方頭)到 y = /.test(t1) && !/擋住/.test(t1), `方頭（整根）：${t1}`);
  const n1 = await diffCount();
  ok(n1 > 0, `改動 ${n1} 格`);

  // 2. 範圍自訂 z 40～52 → 先復原再做一段方頭：只有那一段改
  await page.keyboard.press('Control+z');
  await idle();
  await ed(() => {
    window.__ed.setScopeMode('custom');
    window.__ed.setCustom(40, 52);
  });
  await page.waitForTimeout(100);
  await level();
  await idle();
  const zs = await ed(() => {
    const e = window.__ed;
    const o = e.orig.vol.data;
    const d = e.vol.data;
    const out = new Set();
    for (let i = 0; i < d.length; i++) if (d[i] !== o[i]) out.add(Math.floor(i / (e.vol.X * e.vol.Y)));
    return [...out];
  });
  ok(zs.length > 0 && zs.every((z) => z >= 40 && z <= 52), `自訂 z 40～52 方頭：只改 z ${Math.min(...zs)}～${Math.max(...zs)}`);
  await page.keyboard.press('Control+z');
  await idle();
  await ed(() => window.__ed.setScopeMode('whole'));
  // 回到整根方頭（之後的頂邊才是橫跨整根的直邊）
  await level();
  await idle();
  const base = await diffCount();

  // 3. 推 fin 1 頂邊往外 3 → push
  await ed(() => window.__ed.setCursor([window.__ed.cursor[0], window.__ed.cursor[1], 64]));
  await page.waitForTimeout(300);
  const midU = (fin.x0 + fin.x1 + 1) / 2;
  const top = await screenOf(midU, fin.y0);
  const top3 = await screenOf(midU, fin.y0 - 3);
  await drag(top, [top3[0], top3[1] - 0.3 * (top3[1] - top[1]) / 3]);
  await idle();
  const ops3 = await ed(() => window.__ed.active.ops.map((o) => o.kind));
  ok(ops3.at(-1) === 'push', `頂邊往外 3 → ${ops3.at(-1)}（${await lastText()}）`);
  const pushN = await ed(() => window.__ed.active.ops.at(-1).n);
  ok(pushN === 3, `push n = ${pushN}`);
  if (shots) await page.screenshot({ path: `${shots}/m2-push.png` });
  await page.keyboard.press('Control+z');
  await idle();

  // 4. 削頂邊往內 2（follow 開）→ 閘極底下 HfO₂、TiN 緊貼新的頂面
  await ed(() => window.__ed.setCursor([window.__ed.cursor[0], window.__ed.cursor[1], 26]));
  await page.waitForTimeout(300);
  const a = await screenOf(midU, fin.y0);
  const b = await screenOf(midU, fin.y0 + 2);
  await drag(a, [b[0], b[1] + 2]);
  await idle();
  const col = await ed(([x, y0]) => {
    const e = window.__ed;
    const at = (y) => e.vol.data[(26 * e.vol.Y + y) * e.vol.X + x];
    return [at(y0 + 2), at(y0 + 1), at(y0)];
  }, [Math.floor(midU), fin.y0]);
  ok(col[0] === 3 && col[1] === 4 && [4, 5].includes(col[2]), `削頂 2：新頂面上方依序 ${col.join('、')}（Si fin、HfO₂、HfO₂／TiN），沒有空氣夾層`);
  await page.keyboard.press('Control+z');
  await idle();

  // 5. 搬 fin 1 往右 2（follow 開）→ translate、殼跟著
  const c = await screenOf(midU, fin.y0 + 20);
  const c2 = await screenOf(midU + 2, fin.y0 + 20);
  await drag(c, [c2[0] + 2, c2[1]]);
  await idle();
  const op5 = await ed(() => window.__ed.active.ops.at(-1));
  ok(op5.kind === 'translate' && op5.d[0] === 2 && op5.follow === true, `區域拖動 → translate d = [${op5.d}]，帶殼`);
  const shell = await ed(([x0, y]) => {
    const e = window.__ed;
    return e.vol.data[(26 * e.vol.Y + y) * e.vol.X + x0 + 1];
  }, [fin.x0, fin.y0 + 4]);
  ok(shell === 4, '閘極底下 fin 左側的 HfO₂ 跟著往右');
  await page.keyboard.press('Control+z');
  await idle();

  // 6. z = 7 選 Poly-Si 1 → 位置列「這一片沒有 Poly-Si 1 · 跳到最近的一片（z = 14）」
  await ed(() => window.__ed.setCursor([window.__ed.cursor[0], window.__ed.cursor[1], 7]));
  await select('Poly-Si 1');
  await page.waitForTimeout(300);
  const pb = await page.locator('.position-bar').innerText();
  ok(/這一片沒有 Poly-Si 1/.test(pb) && /z = 14/.test(pb), `位置列：${pb.replace(/\s+/g, ' ').match(/這一片沒有[^）]*）/)?.[0]}`);
  await page.locator('.position-bar').getByText(/跳到最近的一片/).click();
  await page.waitForTimeout(200);
  ok((await page.locator('.position-bar input').first().inputValue()) === '14', '點一下跳到 z = 14');

  // 7. Worker 忙時連按三次 → 三步都套用、順序正確
  await select('Si fin 2');
  const before = await ed(() => window.__ed.active.ops.length);
  await ed(() => {
    const e = window.__ed;
    e.push([0, -1, 0], 1);
    e.push([1, 0, 0], 1);
    e.push([-1, 0, 0], 1);
  });
  await idle();
  const ops7 = await ed((n) => window.__ed.active.ops.slice(n).map((o) => `${o.kind}${o.dir}`), before);
  ok(ops7.length === 3 && ops7[0] === 'push0,-1,0' && ops7[1] === 'push1,0,0' && ops7[2] === 'push-1,0,0', `排隊三步依序套用：${ops7.join(' → ')}`);

  // 拖右邊往外 → profile（或 push）。
  // plan v10 §4.2：節點熱區 8 → 6 px、節點與邊比距離；原本在 y0+2（圓頭附近）按下會抓到頂邊（ns-resize），
  // 橫拖變成 0 格、什麼都沒做——舊的檢查只看最後一步的 kind，會把上一步誤當成這一步。改在 y0+10 抓右邊，並檢查多了一步。
  await select('Si fin 3');
  await page.waitForTimeout(300);
  const f3 = await ed(() => window.__ed.selComps[0].bbox);
  const len8 = await ed(() => window.__ed.active.ops.length);
  const corner = await screenOf(f3.x1 + 1, f3.y0 + 10);
  await page.mouse.move(corner[0], corner[1]);
  await page.waitForTimeout(100);
  const n0 = await screenOf(f3.x1 + 1, f3.y0 + 10);
  const nodeHit = await ed(() => !!document.querySelector('.sedit'));
  void nodeHit;
  const n1p = await screenOf(f3.x1 + 3, f3.y0 + 10);
  await drag(n0, [n1p[0] + 2, n1p[1]]);
  await idle();
  const op8 = await ed(() => window.__ed.active.ops.at(-1));
  const len8b = await ed(() => window.__ed.active.ops.length);
  ok(len8b === len8 + 1 && op8.keys.length === 1 && ['profile', 'push'].includes(op8.kind), `右邊往外拖 → ${op8.kind}（${await lastText()}）`);

  ok(errors.length === 0, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  void base;
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
