// 改體素的核心規則（plan v7 §7.2）：加、拿、搬三條規則只寫在這裡。
// growMask／levelMask／translateMask（3D 與右欄）和 profile（2D 剖面編輯）都呼叫它，所以兩邊結果一致。
// 這個檔案不從 volume.ts 匯入執行期的東西（volume.ts 反過來匯入它）。
import type { Backfill, Vec3, Volume } from './volume';

const AIR = 0;

/** 薄層判定：沿方向連續 ≤ 這麼多格才算襯層。 */
export const LINER_MAX = 4;

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
}
export const newReport = (): Report => ({ filled: 0, pushed: 0, removed: 0, blocked: 0, blockedBy: {}, blockedAt: [], skipped: [], fallback: [] });
export function mergeReport(a: Report, b: Report): Report {
  const blockedBy = { ...a.blockedBy };
  for (const [k, v] of Object.entries(b.blockedBy)) blockedBy[+k] = (blockedBy[+k] ?? 0) + v;
  return {
    filled: a.filled + b.filled,
    pushed: a.pushed + b.pushed,
    removed: a.removed + b.removed,
    blocked: a.blocked + b.blocked,
    blockedBy,
    blockedAt: [...a.blockedAt, ...b.blockedAt],
    skipped: [...a.skipped, ...b.skipped],
    fallback: [...a.fallback, ...b.fallback],
  };
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
 */
export const collectLiners = (vol: Volume, start: Vec3, step: Vec3, stopMat: number) => {
  const { X, Y, data } = vol;
  const cells: number[] = [];
  let [x, y, z] = start;
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
