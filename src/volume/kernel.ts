// 改體素的核心規則（plan v7 §7.2）：加、拿、搬三條規則只寫在這裡。
// growMask／translateMask 與相鄰材質規則（adjacentMasks）都呼叫它。
// 這個檔案不從 volume.ts 匯入執行期的東西（volume.ts 反過來匯入它）。
import type { Backfill, Vec3, Volume } from './volume';

const AIR = 0;

/** 薄層判定：沿方向連續 ≤ 這麼多格才算襯層。 */
export const LINER_MAX = 4;

/**
 * 相鄰材質規則（plan v17 §5.4）被擋下來的原因：
 * edge＝已經到模型邊界；self＝會碰到同材質（自己）；last＝緊貼那一層（mat）只剩 1 格；min＝內縮到只剩 1 格厚。
 * at＝擋住的那一格（index，座標是當時算的那個陣列）。
 */
export interface Block {
  /** lock＝被固定的結構擋住（keep＝它這一排最少要留幾格；LOCK_FULL＝完全鎖定）。 */
  why: 'edge' | 'self' | 'last' | 'min' | 'lock';
  keep?: number;
  mat?: number;
  at?: number;
}

/** 這一步做了什麼：填了幾格（空氣）、推了幾格（襯層被推開再填）、被擋幾格（厚的別的材質），被誰擋。 */
export interface Report {
  filled: number;
  pushed: number;
  removed: number;
  blocked: number;
  blockedBy: Record<number, number>;
  /** 被擋的格子（index，座標是當時算的那個陣列；只在外框裡算時由呼叫端換回整個陣列）。 */
  blockedAt: number[];
  /** 沒有這個結構而略過的片（profile 用；整個陣列的索引）。 */
  skipped: number[];
  /** 相對式套用對不到把手、退回絕對座標的片（profile 用）。 */
  fallback: number[];
  /** 'adjacent'（plan v17）：實際做了幾格（其他 policy 不設）。 */
  done?: number;
  /** 'adjacent'：沒做滿時被誰擋（做滿＝null）。 */
  stop?: Block | null;
  /** 'adjacent' 內縮：完全鎖定、沒有補回來而留空的材質（plan v21）。 */
  gaps?: number[];
}
export const newReport = (): Report => ({ filled: 0, pushed: 0, removed: 0, blocked: 0, blockedBy: {}, blockedAt: [], skipped: [], fallback: [] });

/** VOID（空洞）：相鄰材質規則把它當成空的（可以長進去、不是薄層）。和 volume.ts 的 VOID 相同。 */
const VOID_ID = 254;

/** 薄層材質編號 → 查表（256 格，1＝薄層）。空氣與空洞永遠不是薄層。 */
export function linerLUT(liners: Iterable<number>): Uint8Array {
  const t = new Uint8Array(256);
  for (const m of liners) if (m !== AIR && m !== VOID_ID && m >= 0 && m < 256) t[m] = 1;
  return t;
}

/** 空的（空氣或空洞）：可以直接長進去。 */
export const isEmpty = (m: number) => m === AIR || m === VOID_ID;

/**
 * 能不能吃掉 (x, y, z) 這一格（plan v17 §5.4.1 第 3 步；d＝往外的方向，selfMat＝結構自己的材質）：
 * 出界 → edge；空的 → 可以；同材質 → self；否則再往外一格必須同材質（吃掉之後那一層至少留 1 格），不是 → last。
 */
export function canTake(vol: Volume, x: number, y: number, z: number, d: Vec3, selfMat: number): Block | null {
  if (!inVol(vol, x, y, z)) return { why: 'edge' };
  const i = (z * vol.Y + y) * vol.X + x;
  const m = vol.data[i];
  if (isEmpty(m)) return null;
  if (m === selfMat) return { why: 'self', mat: m, at: i };
  return matAt(vol, x + d[0], y + d[1], z + d[2]) === m ? null : { why: 'last', mat: m, at: i };
}

/**
 * 包在結構外面的薄層（plan v17 §5.4.1 平移）：從結構（mask＝1）出發，沿相連的薄層材質一路收（六鄰接 flood），
 * 碰到不是薄層、或和結構同材質的就停；轉角因此收得到。收到的格子在 mask 標 2（原地改 mask），回傳收到幾格。
 */
export function shellFlood(vol: Volume, mask: Uint8Array, selfMat: number, liner: Uint8Array): number {
  const { X, Y, Z, data } = vol;
  const XY = X * Y;
  const stack: number[] = [];
  const visit = (n: number) => {
    if (mask[n]) return;
    const m = data[n];
    if (!liner[m] || m === selfMat) return;
    mask[n] = 2;
    stack.push(n);
  };
  const expand = (i: number) => {
    const x = i % X;
    const y = ((i - x) / X) % Y;
    const z = (i - x - y * X) / XY;
    if (x > 0) visit(i - 1);
    if (x < X - 1) visit(i + 1);
    if (y > 0) visit(i - X);
    if (y < Y - 1) visit(i + X);
    if (z > 0) visit(i - XY);
    if (z < Z - 1) visit(i + XY);
  };
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) expand(i);
  let n = 0;
  while (stack.length) {
    n++;
    expand(stack.pop()!);
  }
  return n;
}

/** 一排的一維模擬結果：做得到幾格、被誰擋、最遠讀到往外第幾格（0＝結構最外側那一格往外第一格）。 */
export interface RowSim {
  done: number;
  stop: Block | null;
  reach: number;
}

/**
 * 外推的一維模擬（plan v17 §5.4.4 probe／previewBox）：row[k]＝結構最外側那一格往外第 k+1 格的材質（-1＝出界，
 * 陣列結尾之後當作「不知道」）。照 §5.4.1 一格一格推 n 次，不寫回帳簿。reach ≥ row.length 表示讀出窗外（結果不可靠）。
 */
export function simGrowRow(row: number[], n: number, selfMat: number, follow: boolean, liner: Uint8Array): RowSim {
  const r = row.slice();
  const at = (k: number) => (k < r.length ? r[k] : -2);
  let reach = 0;
  // 每推一格，r 的 0 號往外移一格：讀到第 k 格＝原始的第 step + k 格
  for (let step = 0; step < n; step++) {
    let len = 0;
    if (follow) {
      for (;;) {
        const m = at(len);
        reach = Math.max(reach, step + len);
        if (m === -2) return { done: step, stop: null, reach: row.length };
        if (m < 0 || isEmpty(m) || m === selfMat || !liner[m]) break;
        len++;
      }
    }
    const m = at(len);
    reach = Math.max(reach, step + len);
    if (m === -2) return { done: step, stop: null, reach: row.length };
    let stop: Block | null = null;
    // at：擋住的那一格在原始的 row 裡是第幾格（呼叫端換成 index）
    if (m === -1) stop = { why: 'edge' };
    else if (!isEmpty(m)) {
      if (m === selfMat) stop = { why: 'self', mat: m, at: step + len };
      else {
        const m2 = at(len + 1);
        reach = Math.max(reach, step + len + 1);
        if (m2 === -2) return { done: step, stop: null, reach: row.length };
        if (m2 !== m) stop = { why: 'last', mat: m, at: step + len };
      }
    }
    if (stop) return { done: step, stop, reach };
    // 薄層整串往外移一格（蓋掉 b），最前面那一格變成結構
    for (let j = len; j > 0; j--) r[j] = r[j - 1];
    r.shift();
  }
  return { done: n, stop: null, reach };
}

export const inVol = (v: Volume, x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < v.X && y < v.Y && z < v.Z;

/** 'above' 的回呼：第 i 格（材質 movedMat）上面那層的材質；沒有（或是空氣）回 -1。 */
export type AboveOf = (i: number, movedMat: number) => number;

/**
 * 回填：'orig' → 原始陣列該位置；若原本就是被搬走的材質則填 Air。
 * 'above'（plan v14 §5.3）→ above(i) 找到的材質；沒給 above 或找不到 → 照 'orig'。
 * 'outer' → 和 'orig' 一樣，只是「原本就是被搬走的材質」時改填外面那一層（outer＝沿退的方向緊鄰的材質），
 *   例如 fin 變窄：HfO₂ 跟著往內、外面的 gate／填充層補上，不會出現空氣；外面是空氣或出界（outer < 0）才填 Air。
 */
export const fillAt = (orig: Volume, i: number, movedMat: number, backfill: Backfill, above?: AboveOf, outer = -1) => {
  if (typeof backfill === 'number') return backfill;
  if (backfill === 'above' && above) {
    const m = above(i, movedMat);
    if (m >= 0) return m;
  }
  const o = orig.data[i];
  if (o !== movedMat) return o;
  return backfill === 'outer' && outer >= 0 && outer !== movedMat ? outer : AIR;
};

/** (x, y, z) 沿 d 走一格的材質；出界回 -1。 */
const matAt = (v: Volume, x: number, y: number, z: number) => (inVol(v, x, y, z) ? v.data[(z * v.Y + y) * v.X + x] : -1);

/**
 * 從 (x, y, z) 起沿 step 收集前方薄層的體素（遇到 Air、stopMat 或厚於 LINER_MAX 的材質就停）。
 * liner 有給（plan v17：載入時判定一次的薄層表）就只看表：遇到空的、stopMat 或表上不是薄層的材質就停。
 */
export const collectLiners = (vol: Volume, start: Vec3, step: Vec3, stopMat: number, liner?: Uint8Array) => {
  const { X, Y, data } = vol;
  const cells: number[] = [];
  let [x, y, z] = start;
  if (liner) {
    while (inVol(vol, x, y, z)) {
      const i = (z * Y + y) * X + x;
      const m = data[i];
      if (isEmpty(m) || m === stopMat || !liner[m]) break;
      cells.push(i);
      x += step[0];
      y += step[1];
      z += step[2];
    }
    return cells;
  }
  while (inVol(vol, x, y, z)) {
    const m = data[(z * Y + y) * X + x];
    if (m === AIR || m === stopMat) break;
    let run = 0;
    let [rx, ry, rz] = [x, y, z];
    while (inVol(vol, rx, ry, rz) && data[(rz * Y + ry) * X + rx] === m) {
      run++;
      rx += step[0];
      ry += step[1];
      rz += step[2];
    }
    if (run > LINER_MAX) break;
    for (let k = 0; k < run; k++) {
      cells.push((z * Y + y) * X + x);
      x += step[0];
      y += step[1];
      z += step[2];
    }
  }
  return cells;
};

/**
 * 規則 1「加」：把 (x, y, z) 變成 mat，往 d 方向長出來。
 * - 空氣：填。
 * - 薄襯層且 follow：沿 d 把襯層整列往前推一格再填。
 * - 其他（厚的別的材質，或 follow 關著碰到襯層）：policy 'block' → 不動、回傳 false（被擋）；
 *   policy 'overwrite' → 直接蓋掉（推面 growMask 的舊規則）。
 * read＝判斷與取值用的狀態（可以就是 out，邊改邊讀），out＝寫入。
 */
export function addCell(
  read: Volume,
  out: Uint8Array,
  x: number,
  y: number,
  z: number,
  d: Vec3,
  mat: number,
  follow: boolean,
  policy: 'block' | 'overwrite',
  report?: Report,
): boolean {
  const { X, Y } = read;
  const i = (z * Y + y) * X + x;
  const cur = read.data[i];
  let liners: number[] = [];
  if (policy === 'block') {
    if (cur !== AIR) {
      if (follow) liners = collectLiners(read, [x, y, z], d, mat);
      if (!liners.length) {
        if (report) {
          report.blocked++;
          report.blockedBy[cur] = (report.blockedBy[cur] ?? 0) + 1;
          report.blockedAt.push(i);
        }
        return false;
      }
    }
  } else if (follow) liners = collectLiners(read, [x, y, z], d, mat);
  for (let j = liners.length - 1; j >= 0; j--) {
    const c = liners[j];
    const lx = c % X;
    const ly = ((c - lx) / X) % Y;
    const lz = (c - lx - ly * X) / (X * Y);
    const tx = lx + d[0];
    const ty = ly + d[1];
    const tz = lz + d[2];
    if (inVol(read, tx, ty, tz)) out[(tz * Y + ty) * X + tx] = read.data[c];
  }
  out[i] = mat;
  if (report) {
    if (liners.length) report.pushed++;
    else report.filled++;
  }
  return true;
}

/**
 * 規則 2「拿」：拿掉 (x, y, z)（movedMat＝它原本的材質），回填 backfill。
 * follow：外側（沿 back 方向）的薄層一格一格跟著退回來，最外面回填。
 */
export function removeCell(
  read: Volume,
  out: Uint8Array,
  orig: Volume,
  x: number,
  y: number,
  z: number,
  back: Vec3,
  movedMat: number,
  stopMat: number,
  backfill: Backfill,
  follow: boolean,
  report?: Report,
  above?: AboveOf,
) {
  const { X, Y } = read;
  const i = (z * Y + y) * X + x;
  if (report) report.removed++;
  if (follow) {
    const liners = collectLiners(read, [x + back[0], y + back[1], z + back[2]], back, stopMat);
    if (liners.length) {
      let to = i;
      for (const j of liners) {
        out[to] = read.data[j];
        to = j;
      }
      // 最外面那一格：外面緊鄰的（厚的層、或結構自己以外第一個停下來的材質）補上；
      // 'outer' 時一路跟到陣列邊界（外面出界）＝那一層延伸到邊界外，照它自己的材質補，不在邊上留空氣
      const tx = to % X;
      const ty = ((to - tx) / X) % Y;
      const tz = (to - tx - ty * X) / (X * Y);
      const o = matAt(read, tx + back[0], ty + back[1], tz + back[2]);
      out[to] = backfill === 'outer' && o < 0 && orig.data[to] === read.data[to] ? read.data[to] : fillAt(orig, to, read.data[to], backfill, above, o);
      return;
    }
  }
  out[i] = fillAt(orig, i, movedMat, backfill, above, matAt(read, x + back[0], y + back[1], z + back[2]));
}

const DIRS6: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * 殼：結構每個邊界格沿朝外的軸向收集到的薄層（遇空氣、同材質或厚的就停）。
 * dirs 省略＝六個軸向；2D 時只給切面上的四個。只收 test 通過（例如 scope 內）的格子。
 */
export function shellOf(vol: Volume, cells: number[], isStruct: (i: number) => boolean, test: (i: number) => boolean, dirs: Vec3[] = DIRS6) {
  const { X, Y } = vol;
  const shell = new Set<number>();
  for (const i of cells) {
    const x = i % X;
    const y = ((i - x) / X) % Y;
    const z = (i - x - y * X) / (X * Y);
    const mat = vol.data[i];
    for (const d of dirs) {
      const nx = x + d[0];
      const ny = y + d[1];
      const nz = z + d[2];
      if (!inVol(vol, nx, ny, nz)) continue;
      const n = (nz * Y + ny) * X + nx;
      if (isStruct(n)) continue;
      for (const c of collectLiners(vol, [nx, ny, nz], d, mat)) if (!isStruct(c) && test(c)) shell.add(c);
    }
  }
  return [...shell];
}

/**
 * 規則 3「搬」：cells 搬到 +d。先清空（回填）再寫入目標，搬到的地方蓋過去。
 * follow：殼（shellOf）一起搬；殼先寫、結構後寫（結構蓋殼）。出界的丟掉。
 */
export function moveCells(vol: Volume, orig: Volume, out: Uint8Array, cells: number[], d: Vec3, backfill: Backfill, shell: number[] = []) {
  const { X, Y } = vol;
  const write = (list: number[], mats: number[]) =>
    list.forEach((i, k) => {
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      const tx = x + d[0];
      const ty = y + d[1];
      const tz = z + d[2];
      if (inVol(vol, tx, ty, tz)) out[(tz * Y + ty) * X + tx] = mats[k];
    });
  const mats = cells.map((i) => vol.data[i]);
  const smats = shell.map((i) => vol.data[i]);
  for (const i of cells) out[i] = fillAt(orig, i, vol.data[i], backfill);
  for (const i of shell) out[i] = fillAt(orig, i, vol.data[i], backfill);
  write(shell, smats);
  write(cells, mats);
}
