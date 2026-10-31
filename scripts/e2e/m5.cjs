// plan v8 驗收（§11 M6／M7 驗收腳本，範例 ×1）：持久幾何層、浮點 ghost、放開才吸附。
// plan v10：進 2D 剖面＝按兩下 E（瀏覽 → 3D 把手 → 2D 剖面）；Esc 離開聚焦回瀏覽；
// 「選到的節點」卡片改成預覽 → 套用（Enter）。
// 先 `npm run dev`，再 `node scripts/e2e/m5.cjs [url] [截圖資料夾]`
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
  // plan v11 §8：舊腳本照 v10 行為跑——進階開關（自由形變、筆刷）打開、推面蓋過去
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('se3d.v1.freeform', 'true'); localStorage.setItem('se3d.v1.brushOn', 'true'); localStorage.setItem('se3d.v1.pushPolicy', '"overwrite"'); });
  await page.reload();
  await page.getByRole('button', { name: /用範例試試看/ }).click();
  await page.waitForSelector('.mesh-busy', { state: 'detached', timeout: 60000 });

  const ed = (fn, arg) => page.evaluate(fn, arg);
  const idle = async () => {
    await page.waitForFunction(() => !window.__ed.busy && window.__ed.queued === 0, null, { timeout: 60000 });
    await page.waitForTimeout(250);
  };
  const select = async (name) => {
    await page.locator('.item-name', { hasText: new RegExp(`^${name}$`) }).click();
    await page.waitForTimeout(150);
  };
  /** 切面座標（格子角）→ 螢幕座標。 */
  const screenOf = async (u, v) => {
    const b = await page.locator('.sedit-img').boundingBox();
    const [W, H] = await ed(() => [window.__ed.vol.X, window.__ed.vol.Y]);
    return [b.x + (u / W) * b.width, b.y + (v / H) * b.height];
  };
  /**
   * 節點的抓取點：從節點本身開始，往外（右上）一點一點偏，直到游標變成角的游標（nwse／nesw-resize＝抓得到節點）。
   * v10 的 hitTest（src/slice/gestures.ts）節點與邊比「距離／半徑」，兩個半徑都是 6 px，而相鄰兩條邊的線段都通到節點，
   * 所以游標不是剛好落在節點上時，邊（距離 ≤ 到節點的距離）幾乎一定贏、抓到的是邊；只有在角的外側象限才抓得到節點。
   * 回傳 [x, y]；dv＝要算終點時一起往上移幾格（偏移量相同）。
   */
  const nodeScreen = async (u, v) => {
    const [x, y] = await screenOf(u, v);
    for (const [dx, dy] of [[0, 0], [2, -2], [1, -1], [3, -3], [2, -1], [1, -2], [4, -4], [3, -1], [1, -3]]) {
      await page.mouse.move(x + dx, y + dy);
      await page.waitForTimeout(30);
      const cur = await page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)).cursor, [x + dx, y + dy]);
      if (/nwse|nesw/.test(cur)) return { at: [x + dx, y + dy], d: [dx, dy] };
    }
    return { at: [x, y], d: [0, 0] };
  };
  /** 抓節點 (u, v) 拖到 (u + du, v + dv)：抓取點的偏移量保持不變。 */
  const dragNode = async (u, v, du, dv, steps) => {
    const { at, d } = await nodeScreen(u, v);
    const [tx, ty] = await screenOf(u + du, v + dv);
    await drag(at, [tx + d[0], ty + d[1]], steps);
  };
  const zoom = async () => {
    const b = await page.locator('.sedit-img').boundingBox();
    return b.width / (await ed(() => window.__ed.vol.X));
  };
  /** 主切面這一片的幾何層（和畫面同一份）：頂點、節點、驗證。 */
  const geom = () =>
    ed(() => {
      const e = window.__ed;
      const at = e.cursor[2];
      const keys = [...e.sel];
      const m = e.models.get(e.L, e.vol, 'z', at, keys, e.version, e.stepSeq).model;
      return { at, handles: [...m.handles], vertices: m.vertices, rings: m.rings.map((r) => ({ key: r.key, loop: r.loop })) };
    });
  /** 瀏覽 → 3D 把手 → 2D 剖面。 */
  const to2D = async () => {
    await page.keyboard.press('e');
    await page.waitForFunction(() => window.__ed.focus?.view === '3d');
    await page.keyboard.press('e');
    await page.locator('.main-slice').waitFor();
  };
  const drag = async (from, to, steps = 12) => {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (let k = 1; k <= steps; k++) {
      await page.mouse.move(from[0] + ((to[0] - from[0]) * k) / steps, from[1] + ((to[1] - from[1]) * k) / steps);
      await page.waitForTimeout(20);
    }
    await page.mouse.up();
  };

  // 1. Si fin 1 → 2D 編輯 → 拖右上節點往上 2 三次：每次節點還在、座標累加、節點數不變
  //   （往右上拖會把整條右邊連到底角一起斜過去、推進 fin 底部的 STI 而被擋住；那是 §4.3 的情境）
  await select('Si fin 1');
  await to2D();
  await page.waitForTimeout(400);
  // 浮動工具列在選取外框上方，fin 往上長之後會蓋到頂角：這個腳本只測拖拉，先藏起來
  await page.addStyleTag({ content: '.float-tb { display: none !important; }' });
  const g0 = await geom();
  const fin1 = g0.rings[0].key;
  const corner = g0.handles.filter((id) => g0.rings.some((r) => r.loop.includes(id))).reduce((a, b) => (g0.vertices[b].u - g0.vertices[b].v > g0.vertices[a].u - g0.vertices[a].v ? b : a));
  const c0 = [g0.vertices[corner].u, g0.vertices[corner].v];
  const n0 = g0.handles.length;
  ok(n0 >= 4, `進 2D 編輯：Si fin 1 有 ${n0} 個節點，右上角 ${corner} 在 (${c0})（縮放 ${(await zoom()).toFixed(1)}×）`);
  for (let k = 1; k <= 3; k++) {
    const g = await geom();
    const p = [g.vertices[corner].u, g.vertices[corner].v];
    await dragNode(p[0], p[1], 0, -2);
    await idle();
    const g2 = await geom();
    ok(
      g2.vertices[corner] && g2.vertices[corner].u === c0[0] && g2.vertices[corner].v === c0[1] - 2 * k && g2.handles.length === n0,
      `第 ${k} 次：同一個節點 ${corner} 在 (${g2.vertices[corner] && [g2.vertices[corner].u, g2.vertices[corner].v]})、節點數 ${g2.handles.length}`,
    );
  }
  const ops = await ed(() => window.__ed.active.ops.slice(-3));
  ok(ops.length === 3 && ops.every((o) => o.kind === 'profile'), `manifest 三個 profile Op（${ops.map((o) => o.text).join('／')}）`);
  ok(!('refExact' in ops[0]) && ops[1].refExact && ops[2].refExact, '第一次和 v7 一樣；之後幾何改過，參考片用絕對格子（refExact）');
  if (shots) await page.screenshot({ path: `${shots}/m5-1-three-drags.png` });

  // 2. 8× 以上：主輪廓是幾何線，下面疊著淡淡的階梯（voxel 真正的邊界）
  ok((await zoom()) >= 8 && (await page.locator('.sedit-img svg path[stroke-opacity="0.4"]').count()) === 1, '≥ 8×：階梯疊圖出現');
  // 輪廓線（幾何線）只連頂點：path 的點數＝頂點數
  const pts = await page.locator('.sedit-img svg path[stroke-width="1.5"]').first().getAttribute('d');
  const g3 = await geom();
  ok(pts.split('L').length === g3.rings[0].loop.length, `主輪廓是幾何線（${g3.rings[0].loop.length} 個頂點，不是整圈階梯）`);

  // 3. 32×：ghost 跟手（浮點、不跳格）；放開後的格子＝放開前第二層（淡綠／淡紅）的格子
  await page.locator('.sedit').hover();
  for (let k = 0; k < 6; k++) await page.mouse.wheel(0, -400);
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /對準選取/ }).click();
  await page.waitForTimeout(200);
  for (let k = 0; k < 6; k++) {
    const pc = await screenOf(g3.vertices[corner].u, g3.vertices[corner].v);
    await page.mouse.move(pc[0], pc[1]);
    await page.mouse.wheel(0, -400);
  }
  await page.waitForTimeout(300);
  const z32 = await zoom();
  const g4 = await geom();
  const p4 = [g4.vertices[corner].u, g4.vertices[corner].v];
  const from = (await nodeScreen(p4[0], p4[1])).at;
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  const ds = [];
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(from[0], from[1] - k * 0.3 * z32);
    await page.waitForTimeout(40);
    ds.push(await page.evaluate(() => document.querySelector('.sedit-img svg path[fill="rgba(250,84,28,0.08)"]')?.getAttribute('d') ?? ''));
  }
  const distinct = new Set(ds).size;
  const frac = ds.some((d) => /\d\.\d/.test(d));
  ok(distinct >= 8 && frac, `${z32.toFixed(0)}× 下往上拖 3 格（每步 0.3 格）：ghost 變了 ${distinct} 次、座標有小數（不跳格）`);
  const tip = await page.locator('.drag-tip').textContent();
  ok(/→ 取 \(0, −3\)/.test(tip), `提示：${tip}`);
  // 第二層：預覽 canvas 上有顏色的格子
  const layer = await page.evaluate(() => {
    const c = document.querySelector('canvas.sedit-pv');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) out.push(i / 4);
    return out;
  });
  const before = await ed(() => {
    const e = window.__ed;
    const z = e.cursor[2];
    return Array.from(e.vol.data.subarray(z * e.vol.X * e.vol.Y, (z + 1) * e.vol.X * e.vol.Y));
  });
  await page.mouse.up();
  await idle();
  const after = await ed(() => {
    const e = window.__ed;
    const z = e.cursor[2];
    return Array.from(e.vol.data.subarray(z * e.vol.X * e.vol.Y, (z + 1) * e.vol.X * e.vol.Y));
  });
  const changed = before.flatMap((m, i) => (m !== after[i] ? [i] : []));
  ok(changed.length > 0 && changed.join() === layer.join(), `放開後這一片改了 ${changed.length} 格，和放開前第二層顯示的格子逐格相同`);
  await page.getByRole('button', { name: /對準選取/ }).click();
  await page.waitForTimeout(200);

  // 4. Esc 回 3D、用右欄長高 1（別的路徑改了 voxel）→ E 回來：輪廓更新、大部分節點還在
  const before4 = (await geom()).handles;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await ed(() => window.__ed.push([0, -1, 0], 1));
  await idle();
  ok((await ed(() => window.__ed.focus)) === null, 'Esc 離開聚焦編輯（回瀏覽）');
  await to2D();
  await page.waitForTimeout(400);
  const g5 = await geom();
  const kept = before4.filter((id) => g5.handles.includes(id)).length;
  ok(kept >= Math.ceil(before4.length / 2), `3D 那邊長高 1 之後回來：${before4.length} 個節點留下 ${kept} 個（id 不變）`);

  // 5. 右欄打數字：點節點 → y − 2 → 和拖拉得到同一個 Op
  await page.keyboard.press('Control+z');
  await idle();
  const g6 = await geom();
  const p6 = [g6.vertices[corner].u, g6.vertices[corner].v];
  await dragNode(p6[0], p6[1], 0, -2);
  await idle();
  const opDrag = await ed(() => JSON.stringify(window.__ed.active.ops.at(-1)));
  await page.keyboard.press('Control+z');
  await idle();
  const pc = (await nodeScreen(p6[0], p6[1])).at;
  await page.mouse.click(pc[0], pc[1]);
  await page.waitForTimeout(200);
  ok(await page.locator('.insp-body').getByText('選到的節點').isVisible(), '點節點 → 右欄「選到的節點」');
  const yIn = page.locator('.insp-body .field').nth(1).locator('input');
  await yIn.fill(String(p6[1] - 2));
  await yIn.press('Enter');
  await idle();
  const opNum = await ed(() => JSON.stringify(window.__ed.active.ops.at(-1)));
  const strip = (s) => {
    const o = JSON.parse(s);
    delete o.report;
    return JSON.stringify(o);
  };
  ok(strip(opDrag) === strip(opNum), '右欄 y − 2 和拖拉產生完全相同的 Op');
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');

  // 6. Ctrl+Z 到底：幾何層回到建立時的狀態，節點回到原位
  for (let k = 0; k < 12; k++) {
    await page.keyboard.press('Control+z');
    await idle();
  }
  const g7 = await geom();
  ok(g7.vertices[corner] && g7.vertices[corner].u === c0[0] && g7.vertices[corner].v === c0[1], `Ctrl+Z 到底：節點 ${corner} 回到 (${c0})`);
  const verified = await ed(() => {
    const e = window.__ed;
    return e.diff.count;
  });
  ok(verified === 0, '回到原始（改動 0）');
  void fin1;

  ok(!errors.length, `沒有頁面錯誤${errors.length ? '：' + errors.join('\n') : ''}`);
  await browser.close();
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
