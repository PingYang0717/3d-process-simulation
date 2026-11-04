// 第二個內建範例：「比較像真的」FinFET 截面（plan：demoVolume 太理想化）。
// 尺寸、座標慣例和 demoVolume 相同：160s × 96s × 128s，y 往下變大（y 小＝空氣、y 大＝基板），
// fin 沿 z、gate 沿 x；1 voxel ≈ 0.5 nm。整個產生器是決定性的（自帶種子的 PRNG，不用 Math.random）。
//
// 做法：所有「與 z 無關」的形狀先算成 2D 光柵（fin 截面、fin 的 Chebyshev 距離場、epi 菱形），
// 再逐 z 切片組合，z 方向的變化（fin 的線邊緣粗糙度、gate 邊緣粗糙度／傾斜、缺陷）只是查表＋位移，
// 所以整體是 O(N)，沒有逐體素的鄰居搜尋。

import { type Volume, AIR, VOID } from './volume';

/** mulberry32：32 位元種子的小型 PRNG，回傳 [0, 1)。 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 夾在 ±amp 的隨機漫步（每一步 +1／−1／不動），當作線邊緣粗糙度；p = 每一步動的機率（兩個方向各一半）。 */
function roughWalk(n: number, amp: number, p: number, rand: () => number): Int8Array {
  const out = new Int8Array(n);
  let v = 0;
  for (let i = 0; i < n; i++) {
    const r = rand();
    if (r < p / 2) v++;
    else if (r < p) v--;
    if (v > amp) v = amp;
    if (v < -amp) v = -amp;
    out[i] = v;
  }
  return out;
}

/** fin 的截面參數（都以 voxel 為單位、已乘 scale）。 */
interface FinSpec {
  /** 中心 x */
  cx: number;
  /** fin 頂的 y（越小越高） */
  topY: number;
  /** 頂部寬、底部（STI 頂）寬：梯形側壁 */
  wTop: number;
  wBot: number;
  /** 頂部造型：圓頂／切角；necking＝靠近 STI 頂的地方縮腰 */
  top: 'round' | 'chamfer' | 'flat';
  neck: boolean;
}

/** 接觸窗：長條（merged epi 上）或圓柱；seam＝裡面留一條 VOID 縫；floor＝最深只蝕到這個 y（長條在兩根 fin 中間的谷不打穿）。 */
type Contact =
  | { kind: 'bar'; x0: number; x1: number; z0: number; z1: number; floor: number }
  | { kind: 'round'; cx: number; cz: number; r: number; seam?: boolean };

/** 材質編號（對應 volume.ts 的 MATERIALS）。 */
const SUB = 1;
const STI = 2;
const FIN = 3;
const HFO = 4;
const TIN = 5;
const POLY = 6;
const SIN = 7;
const EPI = 8;
const W = 9;
const ILD = 10;

/**
 * 複雜範例：3 根不同寬高的梯形 fin（一根圓頂、一根縮腰、都有 footing 與 ±1 voxel 的線邊緣粗糙度）、
 * STI 頂有 divot 與起伏、3 根不同 CD 的 gate（一根偏移、一根傾斜、邊緣粗糙）＋ SiN cap ＋ 兩側 SiN spacer、
 * gate 下 fin 外的 HfO₂／TiN 保形層（TiN 有厚薄變化與一處薄點）、gate 之間的 SiGe 菱形 epi（兩根 fin 併成一塊）、
 * 落在 epi 上的 W 接觸窗（一支裡有 VOID 縫）、填到 cap 頂的 ILD 氧化層；
 * 缺陷：poly 裡的 bamboo VOID 片、HfO₂ 針孔、STI 頂附近兩根 fin 之間的 Si 殘留橋、spacer 腳下的 poly stringer。
 * scale 把每一軸放大幾倍（和 demoVolume 一樣）。
 */
export function demoComplexVolume(scale = 1): Volume {
  const s = scale;
  const X = 160 * s;
  const Y = 96 * s;
  const Z = 128 * s;
  const data = new Uint8Array(X * Y * Z);
  const rand = mulberry32(0x5eed_c0de);

  // ---- 高度（y）配置：由上往下 ----
  const capTop = 12 * s; // ILD／cap／接觸窗的頂；上面是空氣
  const polyTop = 16 * s; // SiN cap 在 [capTop, polyTop)，poly 從這裡往下
  const stiTop = 60 * s; // STI 頂的標稱高度（實際有起伏與 divot）
  const subTop = 70 * s; // 基板頂（STI 底）
  const spT = 3 * s; // spacer 厚度
  const linerMax = 5 * s; // 距離場只算到這裡（TiN 最厚的地方 3s ＋ HfO₂ 2s）
  const gx0 = 8 * s; // gate 在 x 方向的範圍
  const gx1 = X - 8 * s;

  // ---- fin：三根不同 ----
  const fins: FinSpec[] = [
    { cx: 40 * s, topY: 28 * s, wTop: 10 * s, wBot: 14 * s, top: 'round', neck: false },
    { cx: 80 * s, topY: 32 * s, wTop: 8 * s, wBot: 12 * s, top: 'flat', neck: true },
    { cx: 120 * s, topY: 26 * s, wTop: 14 * s, wBot: 18 * s, top: 'chamfer', neck: false },
  ];
  const bh = 20 * s; // 每根 fin 的 2D 光柵只算 cx ± bh 這一帶
  const bw = 2 * bh + 1;
  const footRise = 4 * s; // footing 從 STI 頂上方 4s 開始變寬，到 STI 頂多 2s，往下埋在 STI 裡保持這個寬度

  /** fin 在 y 這一列的半寬（連續值；cell 中心 |x+0.5−cx| < 半寬 才算 fin）。 */
  const halfWidth = (f: FinSpec, y: number) => {
    if (y < f.topY) return 0;
    const yy = Math.min(y, stiTop);
    let hw = f.wTop / 2 + ((f.wBot - f.wTop) / 2) * ((yy - f.topY) / (stiTop - f.topY));
    if (f.top === 'round') {
      const r = f.wTop / 2;
      if (y < f.topY + r) hw = Math.min(hw, Math.sqrt(Math.max(0, r * r - (f.topY + r - (y + 0.5)) ** 2)));
    } else if (f.top === 'chamfer') hw -= Math.max(0, 2 * s - (y - f.topY));
    if (f.neck) {
      // 縮腰：STI 頂上方 3s～8s 之間，中心最多縮 2.5s
      const c = stiTop - 5.5 * s;
      const n = 2.5 * s * (1 - Math.abs(y + 0.5 - c) / (2.5 * s));
      if (n > 0) hw -= n;
    }
    // footing：靠近 STI 頂逐漸變寬（最多 +2s）
    if (y >= stiTop - footRise) hw += Math.min(2 * s, (y - (stiTop - footRise)) * (2 / footRise));
    return Math.max(hw, 1.5 * s);
  };

  // 每根 fin：截面光柵 finR[y·bw + u]（u = x − cx + bh）與到 fin 的 Chebyshev 距離 distR（0 = fin，255 = 超過 linerMax）
  const finR: Uint8Array[] = [];
  const distR: Uint8Array[] = [];
  const colTop: Int32Array[] = []; // 每個 u 欄 fin 最上面的 y（沒有 fin 的欄＝Y）
  const baseHalf: number[] = []; // STI 頂那一列的半寬（算 divot 用）
  for (const f of fins) {
    const r = new Uint8Array(bw * Y);
    const ct = new Int32Array(bw).fill(Y);
    for (let y = f.topY; y < subTop; y++) {
      const hw = halfWidth(f, y);
      for (let u = 0; u < bw; u++)
        if (Math.abs(u - bh + 0.5) < hw) {
          r[y * bw + u] = 1;
          if (y < ct[u]) ct[u] = y;
        }
    }
    finR.push(r);
    colTop.push(ct);
    baseHalf.push(Math.ceil(halfWidth(f, stiTop) - 0.5));
    // 距離場：逐層膨脹（8 鄰），每層 O(bw·Y)，共 linerMax 層
    const d = new Uint8Array(bw * Y).fill(255);
    for (let i = 0; i < r.length; i++) if (r[i]) d[i] = 0;
    for (let k = 1; k <= linerMax; k++)
      for (let y = 0; y < Y; y++)
        for (let u = 0; u < bw; u++) {
          const i = y * bw + u;
          if (d[i] !== 255) continue;
          let hit = false;
          for (let dy = -1; dy <= 1 && !hit; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= Y) continue;
            for (let du = -1; du <= 1; du++) {
              const uu = u + du;
              if (uu >= 0 && uu < bw && d[yy * bw + uu] === k - 1) {
                hit = true;
                break;
              }
            }
          }
          if (hit) d[i] = k;
        }
    distR.push(d);
  }
  // 線邊緣粗糙度：每根 fin 沿 z 的整體位移 ±s（慢慢漫步，不是逐格雜訊；步進機率除以 s，粗糙度的相關長度以 nm 計不變）
  const finShift = fins.map(() => roughWalk(Z, s, 0.24 / s, rand));

  // ---- STI 頂：沿 x 的緩慢起伏（±s） ----
  const wobble = new Int8Array(X);
  for (let x = 0; x < X; x++) wobble[x] = Math.round(s * Math.sin((2 * Math.PI * x) / (X / 1.3) + 0.7));

  // ---- gate：三根不同 CD；第二根整體 +2s 偏移、第三根往 −z 傾斜；兩個邊各自有 ±s 的粗糙度 ----
  const gates = [
    { z0: 14 * s, z1: 38 * s, tilt: 0 },
    { z0: 54 * s, z1: 72 * s, tilt: 0 },
    { z0: 90 * s, z1: 116 * s, tilt: -1.5 * s },
  ].map((g) => {
    const tiltArr = new Int8Array(Y);
    for (let y = 0; y < Y; y++) tiltArr[y] = Math.round((g.tilt * (Math.min(Math.max(y, capTop), stiTop) - capTop)) / (stiTop - capTop));
    return { ...g, tiltArr, ra: roughWalk(X, s, 0.2 / s, rand), rb: roughWalk(X, s, 0.2 / s, rand) };
  });

  // ---- S/D epi：gate／spacer 以外的 fin 先往下 recess 到 recessY，再從殘株長出菱形（頂在原 fin 頂上方 2s、底尖到 STI 頂下方 1s）；
  // fin 0、1 的菱形夠寬會併在一起（中間剩一個細頸）。光柵以 fin 中心為準，跟著 fin 的位移走。 ----
  const recessY = stiTop - 12 * s;
  const ebh = 24 * s;
  const ebw = 2 * ebh + 1;
  const epiHalf = [22 * s, 22 * s, 16 * s];
  // 併在一起的 fin 0、1 用同一個菱形（頂取較高的 fin 0），兩個全等的凸形聯集在細頸處才不會留 1 格的封閉小洞
  const epiTopY = [fins[0].topY - 2 * s, fins[0].topY - 2 * s, fins[2].topY - 2 * s];
  const epiR = fins.map((_, i) => {
    const r = new Uint8Array(ebw * Y);
    const yTop = epiTopY[i];
    const yBot = stiTop + s;
    const yc = (yTop + yBot) / 2;
    const hh = (yBot - yTop) / 2;
    for (let y = yTop; y < yBot; y++)
      for (let u = 0; u < ebw; u++) if (Math.abs(u - ebh + 0.5) / epiHalf[i] + Math.abs(y + 0.5 - yc) / hh <= 1) r[y * ebw + u] = 1;
    return r;
  });

  // ---- 接觸窗 ----
  const contacts: Contact[] = [
    // gate 0／1 之間：merged epi 上的長條；谷裡最多蝕到 fin 頂下方 6s
    { kind: 'bar', x0: fins[0].cx - 4 * s, x1: fins[1].cx + 4 * s, z0: 43 * s, z1: 49 * s, floor: epiTopY[0] + 8 * s },
    { kind: 'round', cx: fins[2].cx, cz: 46 * s, r: 3.5 * s },
    // gate 1／2 之間：三支圓柱，fin 0 的那支裡有 VOID 縫，fin 1 的那支往 +x 偏 2s
    { kind: 'round', cx: fins[0].cx, cz: 81 * s, r: 3.5 * s, seam: true },
    { kind: 'round', cx: fins[1].cx + 2 * s, cz: 81 * s, r: 3.5 * s },
    { kind: 'round', cx: fins[2].cx, cz: 81 * s, r: 3.5 * s },
  ];

  // ---- 逐 z 切片 ----
  const slice = new Uint8Array(X * Y);
  const topArr = new Int32Array(X); // 這一片每個 x 的 STI 頂（實際 y）
  const bamboo = new Set([gates[1].z0 + 4 * s, gates[1].z0 + 8 * s, gates[1].z0 + 12 * s]);
  for (let z = 0; z < Z; z++) {
    slice.fill(AIR);
    // 基板
    slice.fill(SUB, subTop * X, Y * X);
    // STI：標稱 + 起伏 + fin 旁的 divot（離 fin 底邊 1～3s 以內往下凹，貼著 fin 最深 2s）
    for (let x = 0; x < X; x++) {
      let divot = 0;
      let floor = 0; // fin 底部覆蓋的欄：STI 頂不高於那一欄的 fin 頂（footing 斜面上不留 STI 碎片）
      for (let f = 0; f < fins.length; f++) {
        const c = fins[f].cx + finShift[f][z];
        const l = c - baseHalf[f];
        const r = c + baseHalf[f];
        const g = x < l ? l - x : x >= r ? x - r + 1 : 0;
        if (g >= 1 && g <= 3 * s) divot = Math.max(divot, Math.round(2 * s * (1 - (g - 1) / (3 * s))));
        else if (g === 0) floor = Math.max(floor, colTop[f][x - c + bh]);
      }
      const top = Math.max(stiTop + wobble[x] + divot, floor);
      topArr[x] = top;
      for (let y = top; y < subTop; y++) slice[y * X + x] = STI;
    }
    // fin（整個截面照這一片的位移搬）
    for (let f = 0; f < fins.length; f++) {
      const r = finR[f];
      const off = fins[f].cx - bh + finShift[f][z];
      for (let y = fins[f].topY; y < subTop; y++)
        for (let u = 0; u < bw; u++)
          if (r[y * bw + u]) {
            const x = u + off;
            if (x >= 0 && x < X) slice[y * X + x] = FIN;
          }
    }
    // 這一片附近有哪幾根 gate（含 spacer、粗糙度、傾斜的餘裕）
    const near: number[] = [];
    for (let k = 0; k < gates.length; k++) {
      const g = gates[k];
      const m = spT + 2 * s + Math.abs(g.tilt) + 1;
      if (z >= g.z0 - m && z < g.z1 + m) near.push(k);
    }
    // 表面以上（capTop 以下）的每個空氣格：gate 裡 → cap／HfO₂／TiN／poly；spacer → SiN；S/D 區 → epi；其餘留給 ILD。
    // recessY 以上的 fin 格也走一遍：gate／spacer 裡保留，S/D 區裡被 recess 掉（換成 epi 或空氣）。
    for (let x = 0; x < X; x++)
      for (let y = capTop; y < subTop; y++) {
        const i = y * X + x;
        const isFin = slice[i] === FIN && y < recessY;
        if (slice[i] !== AIR && !isFin) continue;
        let gk = -1;
        let sp = false;
        for (const k of near) {
          const g = gates[k];
          const xc = x < gx0 ? gx0 : x >= gx1 ? gx1 - 1 : x;
          const t = g.tiltArr[y];
          const za = g.z0 + g.ra[xc] + t;
          const zb = g.z1 + g.rb[xc] + t;
          if (x >= gx0 && x < gx1 && z >= za && z < zb) {
            gk = k;
            break;
          }
          if (x >= gx0 - spT && x < gx1 + spT && z >= za - spT && z < zb + spT) sp = true;
        }
        if (gk >= 0) {
          if (isFin) continue;
          if (y < polyTop) {
            slice[i] = SIN;
            continue;
          }
          // 最近的 fin 與 Chebyshev 距離
          let d = 255;
          let nf = -1;
          for (let f = 0; f < fins.length; f++) {
            const u = x - fins[f].cx - finShift[f][z] + bh;
            if (u < 0 || u >= bw) continue;
            const v = distR[f][y * bw + u];
            if (v < d) {
              d = v;
              nf = f;
            }
          }
          const g = gates[gk];
          if (d <= 2 * s) {
            // HfO₂ 針孔：gate 0 下 fin 1 頂上一小塊沒長到，TiN 直接碰到 fin
            const pin = gk === 0 && nf === 1 && y < fins[1].topY && x >= fins[1].cx - 2 * s && x < fins[1].cx + 2 * s && z >= g.z0 + 9 * s && z < g.z0 + 12 * s;
            slice[i] = pin ? TIN : HFO;
          } else {
            // TiN 厚度：預設 2s；gate 1 下 fin 2 厚一點（3s）；gate 2 下 fin 0 的 +x 側有一段只剩 1s（薄點）
            let outer = 4 * s;
            if (gk === 1 && nf === 2) outer = 5 * s;
            else if (gk === 2 && nf === 0 && x > fins[0].cx && z >= g.z0 + 4 * s && z < g.z0 + 8 * s) outer = 3 * s;
            slice[i] = d <= outer ? TIN : POLY;
          }
        } else if (sp) {
          if (!isFin) slice[i] = SIN;
        } else {
          let epi = false;
          for (let f = 0; f < fins.length && !epi; f++) {
            const u = x - fins[f].cx - finShift[f][z] + ebh;
            if (u >= 0 && u < ebw && epiR[f][y * ebw + u]) epi = true;
          }
          slice[i] = epi ? EPI : AIR;
        }
      }
    // 接觸窗：從 capTop 往下填到第一個非空氣的格子（epi 頂）
    for (const c of contacts) {
      let x0: number;
      let x1: number;
      let floor = Y;
      if (c.kind === 'bar') {
        if (z < c.z0 || z >= c.z1) continue;
        x0 = c.x0;
        x1 = c.x1;
        floor = c.floor;
      } else {
        const dz = z + 0.5 - c.cz;
        const h2 = c.r * c.r - dz * dz;
        if (h2 < 0) continue;
        const h = Math.sqrt(h2);
        x0 = Math.ceil(c.cx - h - 0.5);
        x1 = Math.floor(c.cx + h - 0.5) + 1;
      }
      for (let x = Math.max(0, x0); x < Math.min(X, x1); x++) {
        let y = capTop;
        while (y < floor && slice[y * X + x] === AIR) {
          slice[y * X + x] = W;
          y++;
        }
        // VOID 縫：正中央一條 1s 寬（x）× 2s 長（z）的直縫，上下各留 3s 的 W
        if (c.kind === 'round' && c.seam && x >= c.cx - s && x < c.cx && z >= c.cz - s && z < c.cz + s)
          for (let yy = capTop + 3 * s; yy < y - 3 * s; yy++) slice[yy * X + x] = VOID;
      }
    }
    // bamboo defect：gate 1 的 poly 裡三片 1 voxel 厚的 VOID
    if (bamboo.has(z))
      for (let y = 20 * s; y < 56 * s; y++) for (let x = 24 * s; x < X - 24 * s; x++) if (slice[y * X + x] === POLY) slice[y * X + x] = VOID;
    // Si 殘留橋：gate 1／2 之間，STI 頂上方 1～3s，從 fin 1 連到 fin 2
    if (z >= 78 * s && z < 82 * s)
      for (let y = stiTop - 3 * s; y < stiTop - s; y++)
        for (let x = fins[1].cx; x < fins[2].cx; x++) if (slice[y * X + x] === AIR) slice[y * X + x] = FIN;
    // poly stringer：gate 2 面向 gap 2 那一側 spacer 的腳下，STI 上一小條 2s 高、2s 寬的 poly 殘留
    {
      const g = gates[2];
      const t = g.tiltArr[stiTop];
      for (let x = fins[1].cx + 12 * s; x < fins[1].cx + 22 * s; x++) {
        const za = g.z0 + g.ra[x] + t - spT;
        if (z < za - 2 * s || z >= za) continue;
        for (let y = topArr[x] - 2 * s; y < topArr[x]; y++) if (slice[y * X + x] === AIR) slice[y * X + x] = POLY;
      }
    }
    data.set(slice, z * X * Y);
  }
  // ILD：從上面的空氣層（6 鄰接）灌得到的空氣才是 ILD；灌不到的封閉空氣（merged epi 下面的空隙）是 VOID。
  // 一次 3D flood fill，O(空氣＋ILD 的格數)；先把灌到的標成 255，最後一趟換回來。
  fillIld(data, X, Y, Z, capTop);
  return { X, Y, Z, data };
}

/** 見 demoComplexVolume 結尾：從 (0,0,0) 起沿 6 鄰接走過所有連通的空氣格 → capTop 以上還是空氣、以下是 ILD；沒走到的空氣是 VOID。 */
function fillIld(data: Uint8Array, X: number, Y: number, Z: number, capTop: number) {
  const plane = X * Y;
  const N = plane * Z;
  const MARK = 255;
  let stack = new Int32Array(1 << 16);
  let top = 0;
  stack[top++] = 0;
  data[0] = MARK;
  while (top) {
    const i = stack[--top];
    if (top + 6 >= stack.length) {
      const bigger = new Int32Array(stack.length * 2);
      bigger.set(stack);
      stack = bigger;
    }
    const x = i % X;
    const y = ((i - x) / X) % Y;
    let j = i - 1;
    if (x > 0 && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
    j = i + 1;
    if (x < X - 1 && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
    j = i - X;
    if (y > 0 && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
    j = i + X;
    if (y < Y - 1 && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
    j = i - plane;
    if (j >= 0 && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
    j = i + plane;
    if (j < N && data[j] === AIR) (data[j] = MARK), (stack[top++] = j);
  }
  for (let z = 0; z < Z; z++) {
    const base = z * plane;
    for (let i = base; i < base + capTop * X; i++) if (data[i] === MARK) data[i] = AIR;
    for (let i = base + capTop * X; i < base + plane; i++) {
      const v = data[i];
      if (v === MARK) data[i] = ILD;
      else if (v === AIR) data[i] = VOID;
    }
  }
}
