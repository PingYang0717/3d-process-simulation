// 體素陣列與所有直接改體素的操作。
// index = (z·Y + y)·X + x，對應 numpy C order 的 shape (Z, Y, X)。

import { type Scope, axisIndex, scopeBox } from './scope';
import { type Report, LINER_MAX, addCell, fillAt, moveCells, removeCell, shellOf } from './kernel';

export { LINER_MAX, fillAt };
import { BOTH, MeshBuilder, emitFaces } from './meshBuilder';

export interface Volume {
  X: number;
  Y: number;
  Z: number;
  data: Uint8Array;
}

export interface Material {
  id: number;
  name: string;
  color: string;
}

export interface BBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface RawComp {
  mat: number;
  count: number;
  bbox: BBox;
  seed: number;
}

/** 結構：6 鄰接同材質連通塊；key 跨編輯延續。 */
export interface Comp extends RawComp {
  key: string;
  label: string;
}

export interface Labeled {
  labels: Int32Array;
  comps: Comp[];
}

export type Vec3 = [number, number, number];
export type ZRange = [number, number];
/** 空出來的體素填什麼：'orig' = 原始陣列在那個位置的材質，或指定編號。 */
export type Backfill = 'orig' | number;

export const AIR = 0;
export const VOID = 254;

/** 內建範例的名稱表；載入檔案時不用它（見 materialsFor）。 */
export const MATERIALS: Material[] = [
  { id: 0, name: 'Air', color: '#ffffff' },
  { id: 1, name: 'Si (p)', color: '#ddd8cb' },
  { id: 2, name: 'STI SiO₂', color: '#9fd3e8' },
  { id: 3, name: 'Si fin', color: '#f3b9a1' },
  { id: 4, name: 'HfO₂', color: '#7fc8a9' },
  { id: 5, name: 'TiN', color: '#8e9aaf' },
  { id: 6, name: 'Poly-Si', color: '#e8604c' },
  { id: 7, name: 'SiN', color: '#c9b6e8' },
  { id: VOID, name: 'VOID（空洞）', color: '#1f1f1f' },
];

export const isVoid = (id: number) => id === VOID;

export const hexToRgb = (hex: string): Vec3 => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

export const idx = (v: Volume, x: number, y: number, z: number) => (z * v.Y + y) * v.X + x;

export const coordOf = (v: Volume, i: number): Vec3 => {
  const x = i % v.X;
  const y = ((i - x) / v.X) % v.Y;
  const z = (i - x - y * v.X) / (v.X * v.Y);
  return [x, y, z];
};

const inside = (v: Volume, x: number, y: number, z: number) =>
  x >= 0 && y >= 0 && z >= 0 && x < v.X && y < v.Y && z < v.Z;

/**
 * 範例：3 根 fin × 3 根 poly gate，160×96×128；Poly-Si 3 裡有 3 片 1 voxel 厚的 bamboo defect（VOID）。
 * scale 把每一軸放大幾倍（×3 = 480×288×384，約 5,300 萬 voxels），用來看大陣列的速度。
 */
export function demoVolume(scale = 1): Volume {
  const s = scale;
  const X = 160 * s;
  const Y = 96 * s;
  const Z = 128 * s;
  const data = new Uint8Array(X * Y * Z);
  const at = (x: number, y: number, z: number) => (z * Y + y) * X + x;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: number) => {
    for (let z = Math.max(0, z0); z < Math.min(Z, z1); z++)
      for (let y = Math.max(0, y0); y < Math.min(Y, y1); y++) data.fill(m, at(Math.max(0, x0), y, z), at(Math.min(X, x1), y, z));
  };
  const finCenters = [40 * s, 80 * s, 120 * s];
  const finW = 12 * s;
  const finTop = 30 * s;
  const stiTop = 60 * s;
  const subTop = 70 * s;
  const liner = 4 * s;
  const gates: [number, number][] = [
    [14 * s, 38 * s],
    [52 * s, 76 * s],
    [90 * s, 114 * s],
  ];
  box(0, X, subTop, Y, 0, Z, 1);
  box(0, X, stiTop, subTop, 0, Z, 2);
  // fin 截面（與 z 無關，先算成 2D）：頂角切掉 2 格
  const fin = new Uint8Array(X * Y);
  for (let y = finTop; y < subTop; y++)
    for (let x = 0; x < X; x++)
      fin[y * X + x] = finCenters.some((c) => {
        const l = c - finW / 2;
        const r = c + finW / 2;
        return x >= l && x < r && Math.min(x - l, r - 1 - x) + (y - finTop) >= 2 * s;
      })
        ? 1
        : 0;
  // 到 fin 的距離（Chebyshev，≤ liner 才算）；fin 本身與太遠的記 255
  const dist = new Uint8Array(X * Y).fill(255);
  for (let y = finTop - liner; y < stiTop; y++)
    for (let x = 0; x < X; x++) {
      if (fin[y * X + x]) continue;
      let d = 255;
      for (let dy = -liner; dy <= liner && d > 0; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= Y) continue;
        for (let dx = -liner; dx <= liner; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < X && fin[yy * X + xx]) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
        }
      }
      dist[y * X + x] = d;
    }
  for (const [z0, z1] of gates) {
    box(8 * s, X - 8 * s, 18 * s, stiTop, z0, z1, 6);
    box(8 * s, X - 8 * s, 14 * s, 18 * s, z0, z1, 7);
  }
  for (let z = 0; z < Z; z++)
    for (let y = finTop; y < subTop; y++) for (let x = 0; x < X; x++) if (fin[y * X + x]) data[at(x, y, z)] = 3;
  for (const [z0, z1] of gates)
    for (let z = z0; z < z1; z++)
      for (let y = finTop - liner; y < stiTop; y++)
        for (let x = 0; x < X; x++) {
          const d = dist[y * X + x];
          if (d <= 2 * s) data[at(x, y, z)] = 4;
          else if (d <= liner) data[at(x, y, z)] = 5;
        }
  for (const z of [96 * s, 101 * s, 106 * s])
    for (let y = 24 * s; y < 56 * s; y++)
      for (let x = 24 * s; x < X - 24 * s; x++) if (data[at(x, y, z)] === 6) data[at(x, y, z)] = VOID;
  return { X, Y, Z, data };
}

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  quads: number;
}

/** 每個體素的網格代碼：0 = 不畫；同代碼、同朝向、相鄰的面才合併。 */
export const DIFF_BIT = 256;

/**
 * Greedy meshing：每個軸、每一片，把「這一格 vs 下一格」不同的面標出來，
 * 同代碼、同朝向、相鄰的面合併成最大矩形。座標是體素座標（角落 = 整數）。
 * 兩種非 0 代碼相鄰時兩面都畫（各自朝外）。
 */
export function greedyMesh(
  X: number,
  Y: number,
  Z: number,
  codes: Uint16Array,
  colorOf: (code: number) => [number, number, number],
): MeshData {
  const dims = [X, Y, Z];
  const mb = new MeshBuilder();
  const stride = [1, X, X * Y];
  const mask = new Int32Array(Math.max(X * Y, Y * Z, X * Z));
  const x = [0, 0, 0];
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    for (let t = -1; t < dims[d]; t++) {
      // 這一片的面：正值 = 朝 +d 的面、負值 = 朝 −d、BOTH = 兩面都有（直接算 index，不逐格判斷出界）
      let n = 0;
      const hasA = t >= 0;
      const hasB = t < dims[d] - 1;
      const sd = stride[d];
      const su = stride[u];
      for (let j = 0; j < dims[v]; j++) {
        let i0 = j * stride[v] + t * sd;
        for (let i = 0; i < dims[u]; i++, i0 += su) {
          const a = hasA ? codes[i0] : 0;
          const b = hasB ? codes[i0 + sd] : 0;
          mask[n++] = a === b ? 0 : a && !b ? a : !a && b ? -b : BOTH | (a << 15) | b;
        }
      }
      x[d] = t + 1;
      n = 0;
      const W = dims[u];
      for (let j = 0; j < dims[v]; j++)
        for (let i = 0; i < W; ) {
          const c = mask[n];
          if (!c) {
            i++;
            n++;
            continue;
          }
          let w = 1;
          while (i + w < W && mask[n + w] === c) w++;
          let h = 1;
          grow: for (; j + h < dims[v]; h++)
            for (let k = 0; k < w; k++) if (mask[n + k + h * W] !== c) break grow;
          x[u] = i;
          x[v] = j;
          emitFaces(mb, c, d, u, v, x[0], x[1], x[2], w, h, colorOf);
          for (let l = 0; l < h; l++) mask.fill(0, n + l * W, n + l * W + w);
          i += w;
          n += w;
        }
    }
  }
  return mb.finish();
}

/**
 * 射線命中點（體素座標）＋面法線 → 被點到的體素：從命中點往法線反方向退半格。
 * 回傳 index，出界回傳 −1。
 */
export function voxelFromHit(vol: Volume, point: Vec3, normal: Vec3) {
  const x = Math.floor(point[0] - normal[0] * 0.5);
  const y = Math.floor(point[1] - normal[1] * 0.5);
  const z = Math.floor(point[2] - normal[2] * 0.5);
  return inside(vol, x, y, z) ? (z * vol.Y + y) * vol.X + x : -1;
}

export type BrushShape = 'round' | 'square';

/** 筆刷範圍：垂直於 dir 軸的平面上，離 center 在半徑 r 以內（圓）或 |da|,|db| ≤ r（方）；r = Infinity 表示整面。 */
export const inBrush = (axis: number, center: Vec3, r: number, shape: BrushShape, x: number, y: number, z: number) => {
  if (!isFinite(r)) return true;
  const a = axis === 0 ? y - center[1] : x - center[0];
  const b = axis === 2 ? y - center[1] : z - center[2];
  return shape === 'square' ? Math.abs(a) <= r && Math.abs(b) <= r : a * a + b * b <= r * r;
};

/**
 * 局部雕刻：只留下沿 dir 軸、筆刷範圍內的那些列。
 */
export function localMask(vol: Volume, mask: Uint8Array, dir: Vec3, center: Vec3, r: number, shape: BrushShape = 'round') {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(mask.length);
  const axis = dir[0] ? 0 : dir[1] ? 1 : 2;
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (mask[i] && inBrush(axis, center, r, shape, x, y, z)) out[i] = 1;
      }
  return out;
}

/**
 * 補平：筆刷範圍內每一列（沿 dir 軸）的最外側面補到或削到座標 to。
 * 矮的補起來（只填 Air；follow = 前方的薄襯層整列往前推、再填，和推面一樣；碰到厚的材質就停、不吃鄰居）；
 * 高的削掉（回填原始內容；follow = 上面的襯層跟著退回來）。
 * 只動 mask ∩ scope 裡的列；其他體素一個都不變。
 */
export function levelMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  scope: Scope,
  dir: Vec3,
  center: Vec3,
  r: number,
  shape: BrushShape,
  to: number,
  backfill: Backfill,
  follow = false,
  report?: Report,
): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  // 襯層跟推會邊改邊讀，所以 collectLiners 看的是改到一半的 out
  const live: Volume = { X, Y, Z, data: out };
  const axis = dir[0] ? 0 : dir[1] ? 1 : 2;
  const sign = dir[0] + dir[1] + dir[2];
  const d: Vec3 = [dir[0], dir[1], dir[2]];
  const len = axis === 0 ? X : axis === 1 ? Y : Z;
  const at =
    axis === 0
      ? (a: number, b: number, t: number) => (b * Y + a) * X + t
      : axis === 1
        ? (a: number, b: number, t: number) => (b * Y + t) * X + a
        : (a: number, b: number, t: number) => (t * Y + b) * X + a;
  // plan v9 P12：座標內聯（不配 Vec3）；scope 的軸不是掃描軸時，一整列在不在 scope 只看 (a, b)，提到列外判斷一次
  const A = axis === 0 ? Y : X;
  const B = axis === 2 ? Y : Z;
  const sa = axisIndex(scope.axis);
  const { lo: slo, hi: shi } = scope;
  const xOf = (a: number, t: number) => (axis === 0 ? t : a);
  const yOf = (a: number, b: number, t: number) => (axis === 0 ? a : axis === 1 ? t : b);
  const zOf = (b: number, t: number) => (axis === 2 ? t : b);
  const alongT = sa === axis;
  for (let b = 0; b < B; b++)
    for (let a = 0; a < A; a++) {
      if (!inBrush(axis, center, r, shape, xOf(a, 0), yOf(a, b, 0), zOf(b, 0))) continue;
      // 這一列在不在 scope：scope 沿掃描軸時每個 t 各自判斷，否則整列一樣
      let colIn = true;
      if (!alongT) {
        const c = sa === 0 ? xOf(a, 0) : sa === 1 ? yOf(a, b, 0) : zOf(b, 0);
        colIn = c >= slo && c <= shi;
        if (!colIn) continue;
      }
      const inT = (t: number) => !alongT || (t >= slo && t <= shi);
      // 這一列最外側（沿 dir）的 mask 體素
      let outer = -1;
      for (let t = 0; t < len; t++) if (mask[at(a, b, t)] && inT(t) && (sign > 0 || outer < 0)) outer = t;
      if (outer < 0) continue;
      const mat = vol.data[at(a, b, outer)];
      const gap = (to - outer) * sign;
      if (gap > 0) {
        // 補：從 outer 往 dir 走到 to；核心規則「加」（Air 填、薄襯層 follow 推開、厚的擋住就停）
        for (let k = 1; k <= gap; k++) {
          const t = outer + k * sign;
          if (t < 0 || t >= len) break;
          if (!inT(t)) break;
          if (!addCell(live, out, xOf(a, t), yOf(a, b, t), zOf(b, t), d, mat, follow, 'block', report)) break;
        }
      } else if (gap < 0) {
        // 削：從 outer 往回退到 to+1；核心規則「拿」（follow = 上面的襯層一格一格跟著退、最外面回填）
        for (let k = 0; k < -gap; k++) {
          const t = outer - k * sign;
          const i = at(a, b, t);
          if (!mask[i] || !inT(t)) continue;
          removeCell(live, out, orig, xOf(a, t), yOf(a, b, t), zOf(b, t), d, vol.data[i], mat, backfill, follow, report);
        }
      }
    }
  return { X, Y, Z, data: out };
}

/**
 * 整塊平移（核心規則「搬」）：先清空（回填）再寫入目標，搬到的地方蓋過去。
 * follow：外面的薄襯層（HfO₂／TiN 殼）一起搬；預設關（和以前相同）。
 */
export function translateMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  scope: Scope,
  d: Vec3,
  backfill: Backfill,
  follow = false,
): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const cells: number[] = [];
  const b = scopeBox(vol, scope);
  if (b)
    for (let z = b.z0; z <= b.z1; z++)
      for (let y = b.y0; y <= b.y1; y++)
        for (let x = b.x0; x <= b.x1; x++) {
          const i = (z * Y + y) * X + x;
          if (mask[i]) cells.push(i);
        }
  const sa = axisIndex(scope.axis);
  const shell = follow ? shellOf(vol, cells, (i) => !!mask[i], (i) => {
    const c = coordOf(vol, i);
    return c[sa] >= scope.lo && c[sa] <= scope.hi;
  }) : [];
  moveCells(vol, orig, out, cells, d, backfill, shell);
  return { X, Y, Z, data: out };
}

/** 換材質：只改 mask ∩ scope。 */
export function setMaskMaterial(vol: Volume, mask: Uint8Array, scope: Scope, mat: number): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const b = scopeBox(vol, scope);
  if (b)
  for (let z = b.z0; z <= b.z1; z++)
    for (let y = b.y0; y <= b.y1; y++)
      for (let x = b.x0; x <= b.x1; x++) {
        const i = (z * Y + y) * X + x;
        if (mask[i]) out[i] = mat;
      }
  return { X, Y, Z, data: out };
}

const shiftMask = (vol: Volume, mask: Uint8Array, d: Vec3, out = new Uint8Array(mask.length)) => {
  const { X, Y, Z } = vol;
  out.fill(0);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (!mask[i]) continue;
        const tx = x + d[0];
        const ty = y + d[1];
        const tz = z + d[2];
        if (inside(vol, tx, ty, tz)) out[(tz * Y + ty) * X + tx] = 1;
      }
  return out;
};

/**
 * 每條沿 d 軸的線上，只留 mask 在 d 方向最外側的那一格（真正的外表面）。
 * 結構內部的空洞邊界不算，所以推面不會長進 void、也不會從 void 往外蝕。
 */
const outerFace = (vol: Volume, mask: Uint8Array, d: Vec3, out = new Uint8Array(mask.length)) => {
  const { X, Y, Z } = vol;
  out.fill(0);
  const axis = d[0] ? 0 : d[1] ? 1 : 2;
  const sign = d[0] + d[1] + d[2];
  const len = axis === 0 ? X : axis === 1 ? Y : Z;
  // (a, b) 走過垂直於該軸的平面，t 沿軸
  const at =
    axis === 0
      ? (a: number, b: number, t: number) => (b * Y + a) * X + t
      : axis === 1
        ? (a: number, b: number, t: number) => (b * Y + t) * X + a
        : (a: number, b: number, t: number) => (t * Y + b) * X + a;
  const A = axis === 0 ? Y : X;
  const B = axis === 2 ? Y : Z;
  for (let b = 0; b < B; b++)
    for (let a = 0; a < A; a++) {
      let hit = -1;
      for (let t = 0; t < len; t++) if (mask[at(a, b, t)] && (sign > 0 || hit < 0)) hit = t;
      if (hit >= 0) out[at(a, b, hit)] = 1;
    }
  return out;
};

/**
 * 推面：沿 dir 膨脹（n > 0）或侵蝕（n < 0）|n| 格，只推那一面。
 * follow = 襯層跟著走：前方薄層整列前移一格；縮短時同一列退回一格。
 */
export function growMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  scope: Scope,
  dir: Vec3,
  n: number,
  backfill: Backfill,
  follow: boolean,
  report?: Report,
): Volume {
  let cur = vol;
  // 第 0 步之前複製一次（之後原地改）；plan v9 P12：兩塊外框大小的 buffer 輪流當這一步的結果，face／front 共用 scratch
  const m = new Uint8Array(mask);
  const { X, Y, Z } = vol;
  const sb = scopeBox(vol, scope);
  if (!sb) return vol;
  const steps = Math.abs(n);
  if (!steps) return vol;
  const bufs: Uint8Array[] = [];
  const face = new Uint8Array(m.length);
  const front = n > 0 ? new Uint8Array(m.length) : face;
  for (let step = 0; step < steps; step++) {
    // 這一步讀 cur、寫 out（out 先複製 cur）；兩塊 buffer 輪流，cur 永遠不是 out
    let out = bufs[step & 1];
    if (!out) out = bufs[step & 1] = new Uint8Array(cur.data);
    else out.set(cur.data);
    const d: Vec3 = n > 0 ? dir : [-dir[0], -dir[1], -dir[2]];
    if (n > 0) {
      shiftMask(cur, outerFace(cur, m, d, face), d, front);
      for (let z = sb.z0; z <= sb.z1; z++)
        for (let y = sb.y0; y <= sb.y1; y++)
          for (let x = sb.x0; x <= sb.x1; x++) {
            const i = (z * Y + y) * X + x;
            if (!front[i] || m[i]) continue;
            const src = (z - d[2]) * X * Y + (y - d[1]) * X + (x - d[0]);
            // 核心規則「加」；推面一直是蓋過去（overwrite），和以前相同
            addCell(cur, out, x, y, z, d, cur.data[src], follow, 'overwrite', report);
          }
      for (let i = 0; i < m.length; i++) if (front[i]) m[i] = 1;
    } else {
      // d 指向要退的方向（dir 的反向）；要退掉的是 dir 方向最外側那一層
      const back: Vec3 = [-d[0], -d[1], -d[2]];
      outerFace(cur, m, back, face);
      for (let z = sb.z0; z <= sb.z1; z++)
        for (let y = sb.y0; y <= sb.y1; y++)
          for (let x = sb.x0; x <= sb.x1; x++) {
            const i = (z * Y + y) * X + x;
            if (!face[i]) continue;
            const mat = cur.data[i];
            // 核心規則「拿」
            removeCell(cur, out, orig, x, y, z, back, mat, mat, backfill, follow, report);
            m[i] = 0;
          }
    }
    cur = { X, Y, Z, data: out };
  }
  return cur;
}

export function materialCounts(vol: Volume) {
  const counts = new Map<number, number>();
  for (let i = 0; i < vol.data.length; i++) counts.set(vol.data[i], (counts.get(vol.data[i]) ?? 0) + 1);
  return counts;
}

/** 每個編號幾個體素（長度 256）。 */
export function countArray(data: Uint8Array) {
  const out = new Float64Array(256);
  for (let i = 0; i < data.length; i++) out[data[i]]++;
  return Array.from(out);
}

/** 逐體素比對原始。 */
export function diffMask(vol: Volume, orig: Volume) {
  const mask = new Uint8Array(vol.data.length);
  let count = 0;
  for (let i = 0; i < mask.length; i++)
    if (vol.data[i] !== orig.data[i]) {
      mask[i] = 1;
      count++;
    }
  return { mask, count };
}

export function encodeNpy(vol: Volume): Uint8Array {
  let header = `{'descr': '|u1', 'fortran_order': False, 'shape': (${vol.Z}, ${vol.Y}, ${vol.X}), }`;
  header += ' '.repeat(64 - ((10 + header.length + 1) % 64)) + '\n';
  const h = new TextEncoder().encode(header);
  const out = new Uint8Array(10 + h.length + vol.data.length);
  out.set([0x93, 78, 85, 77, 80, 89, 1, 0, h.length & 255, h.length >> 8]);
  out.set(h, 10);
  out.set(vol.data, 10 + h.length);
  return out;
}

/** 讀 .npy：uint8 直接用，int16／int32／int64 取低 8 位；fortran_order 拒絕。 */
export function decodeNpy(buf: ArrayBuffer): Volume {
  const b = new Uint8Array(buf);
  if (b[0] !== 0x93 || String.fromCharCode(...b.slice(1, 6)) !== 'NUMPY') throw new Error('不是 .npy');
  const major = b[6];
  const hlen = major === 1 ? b[8] | (b[9] << 8) : b[8] | (b[9] << 8) | (b[10] << 16) | (b[11] << 24);
  const off = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(b.slice(off, off + hlen));
  const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);
  const descrMatch = header.match(/'descr':\s*'([^']*)'/);
  if (!shapeMatch || !descrMatch) throw new Error('.npy header 讀不出來');
  const shape = shapeMatch[1]
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
  const descr = descrMatch[1];
  if (shape.length !== 3) throw new Error(`需要 3 維陣列，得到 shape (${shape.join(', ')})`);
  if (/'fortran_order':\s*True/.test(header)) throw new Error('不支援 fortran_order');
  const [Z, Y, X] = shape;
  const n = X * Y * Z;
  const body = buf.slice(off + hlen);
  let data: Uint8Array;
  if (descr === '|u1' || descr === '|i1') data = new Uint8Array(body.slice(0, n));
  else if (descr === '<u2' || descr === '<i2') {
    const src = new Uint16Array(body.slice(0, n * 2));
    data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = src[i] & 255;
  } else if (descr === '<u4' || descr === '<i4') {
    const src = new Uint32Array(body.slice(0, n * 4));
    data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = src[i] & 255;
  } else if (descr === '<i8' || descr === '<u8') {
    const src = new BigInt64Array(body.slice(0, n * 8));
    data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = Number(src[i] & 255n);
  } else throw new Error(`不支援 dtype ${descr}（請用 uint8 材質編號）`);
  if (data.length !== n) throw new Error('.npy 資料長度不足');
  return { X, Y, Z, data };
}

/** flood fill 用的堆疊；不夠時自動加倍，跨元件重複使用。 */
interface Stack {
  buf: Int32Array;
}

/** 從 seed 起把同材質、labels 還是 −1 的 6 鄰接體素標成 id；回傳這塊的 count、bbox。 */
function floodFill(vol: Volume, labels: Int32Array, seed: number, id: number, st: Stack): RawComp {
  const { X, Y, Z, data } = vol;
  const plane = X * Y;
  const mat = data[seed];
  let stack = st.buf;
  let count = 0;
  let x0 = X;
  let x1 = -1;
  let y0 = Y;
  let y1 = -1;
  let z0 = Z;
  let z1 = -1;
  let top = 0;
  stack[top++] = seed;
  labels[seed] = id;
  while (top) {
    const i = stack[--top];
    count++;
    const x = i % X;
    const y = ((i - x) / X) % Y;
    const z = (i - x - y * X) / plane;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    if (top + 6 >= stack.length) {
      const bigger = new Int32Array(stack.length * 2);
      bigger.set(stack);
      stack = st.buf = bigger;
    }
    // 六個鄰居直接展開（大陣列時比共用一個 closure 快約兩成）
    let j = i - 1;
    if (x > 0 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
    j = i + 1;
    if (x < X - 1 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
    j = i - X;
    if (y > 0 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
    j = i + X;
    if (y < Y - 1 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
    j = i - plane;
    if (z > 0 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
    j = i + plane;
    if (z < Z - 1 && labels[j] < 0 && data[j] === mat) {
      labels[j] = id;
      stack[top++] = j;
    }
  }
  return { mat, count, bbox: { x0, x1, y0, y1, z0, z1 }, seed };
}

/** 6 鄰接同材質連通塊：每個體素屬於哪一塊，順便算 bbox、count、seed。 */
export function labelComponents(vol: Volume): { labels: Int32Array; raw: RawComp[] } {
  const N = vol.X * vol.Y * vol.Z;
  const labels = new Int32Array(N).fill(-1);
  const raw: RawComp[] = [];
  const st: Stack = { buf: new Int32Array(1 << 16) };
  for (let s = 0; s < N; s++) if (labels[s] < 0 && vol.data[s] !== AIR) raw.push(floodFill(vol, labels, s, raw.length, st));
  return { labels, raw };
}

/** 第一次命名：依材質、x、z 排序編號，例如「Poly-Si 2」。 */
export function nameComponents(raw: RawComp[], matName: (id: number) => string): Comp[] {
  const order = raw
    .map((_, i) => i)
    .sort((a, b) => raw[a].mat - raw[b].mat || raw[a].bbox.x0 - raw[b].bbox.x0 || raw[a].bbox.z0 - raw[b].bbox.z0);
  const perMat = new Map<number, number>();
  const comps = new Array<Comp>(raw.length);
  for (const i of order) {
    const r = raw[i];
    const n = (perMat.get(r.mat) ?? 0) + 1;
    perMat.set(r.mat, n);
    comps[i] = { ...r, key: `c${i}`, label: `${matName(r.mat)} ${n}` };
  }
  return comps;
}

export function initialLabeled(vol: Volume, matName: (id: number) => string): Labeled {
  const { labels, raw } = labelComponents(vol);
  return { labels, comps: nameComponents(raw, matName) };
}

const labelNumber = (label: string) => parseInt(label.split(' ').pop() ?? '0', 10) || 0;

/**
 * 舊結構 → 新結構的認領：votes[新][舊] = 舊結構有幾個體素（已選的照位移平移）落在新結構。
 * 大的先認領；同材質或重疊過半才繼承 key 與名字；沒人認領的取新名（同材質最大編號 ＋1）。
 */
function nameByVotes(
  prev: { comps: Comp[] },
  fresh: RawComp[],
  votes: Map<number, number>,
  matName: (id: number) => string,
  newKey: () => string,
): Comp[] {
  const nOld = prev.comps.length;
  const owner = new Int32Array(fresh.length).fill(-1);
  const byOld = new Map<number, { n: number; c: number }[]>();
  votes.forEach((c, k) => {
    const n = Math.floor(k / nOld);
    const o = k % nOld;
    if (!byOld.has(o)) byOld.set(o, []);
    byOld.get(o)!.push({ n, c });
  });
  const taken = new Set<number>();
  const olds = [...byOld.entries()].sort((a, b) => prev.comps[b[0]].count - prev.comps[a[0]].count);
  for (const [o, list] of olds) {
    list.sort((a, b) => b.c - a.c);
    for (const { n, c } of list) {
      if (taken.has(n)) continue;
      if (fresh[n].mat === prev.comps[o].mat || c * 2 > fresh[n].count) {
        owner[n] = o;
        taken.add(n);
        break;
      }
    }
  }
  const maxNum = new Map<number, number>();
  prev.comps.forEach((c) => {
    const n = labelNumber(c.label);
    if (n > (maxNum.get(c.mat) ?? 0)) maxNum.set(c.mat, n);
  });
  return fresh.map((r, i): Comp => {
    if (owner[i] >= 0) {
      const p = prev.comps[owner[i]];
      return {
        ...r,
        key: p.key,
        label: p.mat === r.mat ? p.label : `${matName(r.mat)}${p.label.slice(matName(p.mat).length)}`,
      };
    }
    const n = (maxNum.get(r.mat) ?? 0) + 1;
    maxNum.set(r.mat, n);
    return { ...r, key: newKey(), label: `${matName(r.mat)} ${n}` };
  });
}

/** 已選的體素照位移平移後的位置；出界回傳 −1。 */
const movedTo = (vol: Volume, i: number, movedMask: Uint8Array | null, shift: Vec3) => {
  if (!movedMask?.[i]) return i;
  const { X, Y, Z } = vol;
  const x = i % X;
  const y = ((i - x) / X) % Y;
  const z = (i - x - y * X) / (X * Y);
  const tx = x + shift[0];
  const ty = y + shift[1];
  const tz = z + shift[2];
  return tx < 0 || ty < 0 || tz < 0 || tx >= X || ty >= Y || tz >= Z ? -1 : (tz * Y + ty) * X + tx;
};

/** 名稱延續（整個陣列重算）：relabel 的對照版本，測試用來驗證只重算局部的結果相同。 */
export function relabelFull(
  prevVol: Volume,
  prev: Labeled,
  movedMask: Uint8Array | null,
  shift: Vec3,
  next: Volume,
  matName: (id: number) => string,
  newKey: () => string,
): Labeled {
  const { labels, raw } = labelComponents(next);
  const nOld = prev.comps.length;
  const votes = new Map<number, number>();
  for (let i = 0; i < prevVol.data.length; i++) {
    const o = prev.labels[i];
    if (o < 0) continue;
    const j = movedTo(next, i, movedMask, shift);
    if (j < 0 || labels[j] < 0) continue;
    const k = labels[j] * nOld + o;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
  return { labels, comps: nameByVotes(prev, raw, votes, matName, newKey) };
}

/**
 * 名稱延續，只重算被改到的地方：
 * 1. 找出和上一步不同的體素外框 R；
 * 2. 外框（多留 1 格）碰到的舊結構才重算，其他結構的體素、count、bbox 原封不動；
 * 3. 在「R ∪ 這些結構的外框」裡重新 flood fill，新結構和舊結構投票認領 key 與名字。
 * 沒碰到的結構不可能和改過的地方相連（相鄰的體素都沒變），所以結果和整個重算相同。
 */
export function relabel(
  prevVol: Volume,
  prev: Labeled,
  movedMask: Uint8Array | null,
  shift: Vec3,
  next: Volume,
  matName: (id: number) => string,
  newKey: () => string,
): Labeled {
  return relabelCore(prevVol, prev, (i) => movedTo(next, i, movedMask, shift), next, matName, newKey).L;
}

/** 和上一步不同的體素外框（整個陣列掃一次）；沒有不同回傳 null。 */
export function changedBox(a: Uint8Array, b: Uint8Array, dims: { X: number; Y: number; Z: number }): BBox | null {
  const { X, Y, Z } = dims;
  const N = X * Y * Z;
  let rx0 = X;
  let rx1 = -1;
  let ry0 = Y;
  let ry1 = -1;
  let rz0 = Z;
  let rz1 = -1;
  for (let i = 0; i < N; i++) {
    if (a[i] === b[i]) continue;
    const x = i % X;
    const y = ((i - x) / X) % Y;
    const z = (i - x - y * X) / (X * Y);
    if (x < rx0) rx0 = x;
    if (x > rx1) rx1 = x;
    if (y < ry0) ry0 = y;
    if (y > ry1) ry1 = y;
    if (z < rz0) rz0 = z;
    if (z > rz1) rz1 = z;
  }
  return rx1 < 0 ? null : { x0: rx0, x1: rx1, y0: ry0, y1: ry1, z0: rz0, z1: rz1 };
}

/** 沒被重算、但換了編號的結構（補洞用）：box 裡 labels == from 的改成 to。 */
export interface LabelMove {
  from: number;
  to: number;
  box: BBox;
}
export interface RelabelInfo {
  L: Labeled;
  /** 重新標記的範圍（改到的外框 ∪ 被重算結構的外框）。null = 沒改。 */
  S: BBox | null;
  /** S 外面只有這幾個結構換了編號（其他結構的編號不變）。 */
  moves: LabelMove[];
}

/**
 * relabel 的本體：moved(i) = 舊的第 i 格搬到哪（沒搬就是 i，出界 −1）；
 * R = 已知的改動外框（Worker 只在外框裡算時直接給，不必掃整個陣列）。
 */
export function relabelCore(
  prevVol: Volume,
  prev: Labeled,
  moved: (i: number) => number,
  next: Volume,
  matName: (id: number) => string,
  newKey: () => string,
  R?: BBox | null,
): RelabelInfo {
  const { X, Y, Z } = next;
  const b = next.data;
  // 1. 改到的外框
  const box = R === undefined ? changedBox(prevVol.data, b, next) : R;
  if (!box) return { L: prev, S: null, moves: [] };
  const { x0: rx0, x1: rx1, y0: ry0, y1: ry1, z0: rz0, z1: rz1 } = box;
  // 2. 在改到的外框（多留 1 格）裡有體素的舊結構才可能改變（沒碰到的結構，體素和鄰居都沒變）；
  //    S = R ∪ 它們的外框
  const touched = new Uint8Array(prev.comps.length);
  for (let z = Math.max(0, rz0 - 1); z <= Math.min(Z - 1, rz1 + 1); z++)
    for (let y = Math.max(0, ry0 - 1); y <= Math.min(Y - 1, ry1 + 1); y++) {
      const row = (z * Y + y) * X;
      for (let i = row + Math.max(0, rx0 - 1), e = row + Math.min(X - 1, rx1 + 1); i <= e; i++) {
        const l = prev.labels[i];
        if (l >= 0) touched[l] = 1;
      }
    }
  const S: BBox = { x0: rx0, x1: rx1, y0: ry0, y1: ry1, z0: rz0, z1: rz1 };
  prev.comps.forEach((c, k) => {
    if (!touched[k]) return;
    const bb = c.bbox;
    S.x0 = Math.min(S.x0, bb.x0);
    S.x1 = Math.max(S.x1, bb.x1);
    S.y0 = Math.min(S.y0, bb.y0);
    S.y1 = Math.max(S.y1, bb.y1);
    S.z0 = Math.min(S.z0, bb.z0);
    S.z1 = Math.max(S.z1, bb.z1);
  });
  // 3. 清掉這些結構的標記，在 S 裡重新 flood fill；新結構暫用編號 nOld 起
  const nOld = prev.comps.length;
  const labels = prev.labels.slice();
  for (let z = S.z0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + S.x0; i <= row + S.x1; i++) if (labels[i] >= 0 && touched[labels[i]]) labels[i] = -1;
    }
  const fresh: RawComp[] = [];
  const st: Stack = { buf: new Int32Array(1 << 16) };
  for (let z = S.z0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + S.x0; i <= row + S.x1; i++)
        if (labels[i] < 0 && b[i] !== AIR) fresh.push(floodFill(next, labels, i, nOld + fresh.length, st));
    }
  // 4. 投票：重算的舊結構 → 新結構（計數用 typed array，最後才轉成 nameByVotes 要的 Map）
  const tOf = new Int32Array(nOld).fill(-1);
  const tList: number[] = [];
  touched.forEach((t, k) => {
    if (t) {
      tOf[k] = tList.length;
      tList.push(k);
    }
  });
  const T = tList.length;
  const tally = new Float64Array(fresh.length * T);
  for (let z = S.z0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + S.x0; i <= row + S.x1; i++) {
        const o = prev.labels[i];
        if (o < 0 || !touched[o]) continue;
        const j = moved(i);
        if (j < 0 || labels[j] < nOld) continue;
        tally[(labels[j] - nOld) * T + tOf[o]]++;
      }
    }
  const votes = new Map<number, number>();
  tally.forEach((c, k) => {
    if (c) votes.set(Math.floor(k / T) * nOld + tList[k % T], c);
  });
  const named = nameByVotes(prev, fresh, votes, matName, newKey);
  // 5. 編號：沒碰到的結構編號不變（S 外面的 labels 不用動）；新結構先補被重算結構留下的空位，多的接在後面；
  //    空位比新結構多時，把最後面的結構搬進空位（只改它外框裡的 labels），陣列保持連續
  const comps = prev.comps.slice();
  const slots = tList; // 被重算結構的編號，由小到大
  const freshIdx = new Int32Array(fresh.length);
  named.forEach((c, j) => {
    if (j < slots.length) {
      comps[slots[j]] = c;
      freshIdx[j] = slots[j];
    } else {
      freshIdx[j] = comps.length;
      comps.push(c);
    }
  });
  const holes = new Set(slots.slice(named.length));
  const moves: LabelMove[] = [];
  let n = comps.length;
  for (const h of slots.slice(named.length)) {
    while (n > 0 && holes.has(n - 1)) n--;
    if (h >= n) continue;
    comps[h] = comps[n - 1];
    moves.push({ from: n - 1, to: h, box: comps[h].bbox });
    holes.delete(h);
    n--;
  }
  while (n > 0 && holes.has(n - 1)) n--;
  comps.length = n;
  for (let z = S.z0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + S.x0; i <= row + S.x1; i++) if (labels[i] >= nOld) labels[i] = freshIdx[labels[i] - nOld];
    }
  for (const mv of moves) moveLabel(labels, next, mv.box, mv.from, mv.to);
  return { L: { labels, comps }, S, moves };
}

/**
 * 已知改動外框 R 時的 relabel（Worker 每一步走這條）：
 * - 在 R（多留 1 格）裡有體素的舊結構才可能改變；其中「掉了體素」的才可能斷開，要重新 flood fill；
 *   只長出體素或只是鄰居變了的，整塊照舊（不必再走一遍），新長出的體素用 union-find 接到它身上。
 * - 名稱與 key 和 relabelFull 用同一套投票（nameByVotes），所以結果相同。
 * - 編號：整塊照舊的結構編號不變；新結構補掉了體素的結構留下的空位，再不夠才接在後面，
 *   空位多了就把最後面的結構搬進來（moves）。S 外面只有 moves 會改 labels。
 */
export function relabelFast(
  prevVol: Volume,
  prev: Labeled,
  moved: (i: number) => number,
  next: Volume,
  matName: (id: number) => string,
  newKey: () => string,
  R: BBox | null,
): RelabelInfo {
  if (!R) return { L: prev, S: null, moves: [] };
  const labels = prev.labels.slice();
  const r = relabelInPlace(labels, prev.comps, cropBox(prevVol.data, next, R), next, (i) => moved(i), matName, newKey, R);
  return { L: { labels, comps: r.comps }, S: r.S, moves: r.moves };
}

/** 外框裡的資料（複製）；patch.ts 的 cropArr 同一件事（這裡避免循環 import）。 */
function cropBox<T extends Uint8Array | Int32Array>(src: T, dims: { X: number; Y: number }, b: BBox): T {
  const W = b.x1 - b.x0 + 1;
  const H = b.y1 - b.y0 + 1;
  const D = b.z1 - b.z0 + 1;
  const out = new (src.constructor as { new (n: number): T })(W * H * D);
  for (let z = 0; z < D; z++)
    for (let y = 0; y < H; y++) {
      const s = ((z + b.z0) * dims.Y + y + b.y0) * dims.X + b.x0;
      out.set(src.subarray(s, s + W), (z * H + y) * W);
    }
  return out;
}

export interface RelabelInPlace {
  comps: Comp[];
  S: BBox;
  moves: LabelMove[];
  /** 改前的 labels 在 S 裡的裁片（Step.labels.before）。 */
  before: Int32Array;
}

/**
 * relabelFast 的原地版本（plan v9 §4.3）：labels 直接改成新的編號，不影印整個陣列。
 * - dataBefore：改前的體素在 R 裡的裁片（取代整個改前陣列；R 外面改前改後相同）。
 * - 任何寫入之前先把 Smax（R ∪ 碰到的結構的外框，⊇ 最後的 S）裡的舊 labels 裁下來當快照，之後讀舊值都讀它。
 * - moved(i, o)：舊的第 i 格（舊編號 o）搬到哪。
 */
export function relabelInPlace(
  labels: Int32Array,
  prevComps: Comp[],
  dataBefore: Uint8Array,
  next: Volume,
  moved: (i: number, o: number) => number,
  matName: (id: number) => string,
  newKey: () => string,
  R: BBox,
): RelabelInPlace {
  const prev = { comps: prevComps };
  const { X, Y, Z } = next;
  const b = next.data;
  const nOld = prevComps.length;
  const RW = R.x1 - R.x0 + 1;
  const RH = R.y1 - R.y0 + 1;
  // R 裡改過的格子
  const chg = new Uint8Array(dataBefore.length);
  for (let z = R.z0, k = 0; z <= R.z1; z++)
    for (let y = R.y0; y <= R.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + R.x0, e = row + R.x1; i <= e; i++, k++) if (dataBefore[k] !== b[i]) chg[k] = 1;
    }
  const inR = (x: number, y: number, z: number) => x >= R.x0 && x <= R.x1 && y >= R.y0 && y <= R.y1 && z >= R.z0 && z <= R.z1;
  // 1. 碰到的結構，以及掉了體素的（R 裡原本屬於它、現在材質不同）
  const touched = new Uint8Array(nOld);
  const lost = new Uint8Array(nOld);
  const ex = { x0: Math.max(0, R.x0 - 1), x1: Math.min(X - 1, R.x1 + 1), y0: Math.max(0, R.y0 - 1), y1: Math.min(Y - 1, R.y1 + 1), z0: Math.max(0, R.z0 - 1), z1: Math.min(Z - 1, R.z1 + 1) };
  for (let z = ex.z0; z <= ex.z1; z++)
    for (let y = ex.y0; y <= ex.y1; y++) {
      const row = (z * Y + y) * X;
      for (let x = ex.x0; x <= ex.x1; x++) {
        const l = labels[row + x];
        if (l < 0) continue;
        touched[l] = 1;
        if (inR(x, y, z) && chg[((z - R.z0) * RH + y - R.y0) * RW + x - R.x0]) lost[l] = 1;
      }
    }
  // 舊值快照：Smax = R ∪ 碰到的結構的外框（掉了體素的、被併掉的都是碰到的，所以 ⊇ 最後的 S）
  const Smax: BBox = { ...R };
  for (let k = 0; k < nOld; k++)
    if (touched[k]) {
      const bb = prevComps[k].bbox;
      Smax.x0 = Math.min(Smax.x0, bb.x0);
      Smax.x1 = Math.max(Smax.x1, bb.x1);
      Smax.y0 = Math.min(Smax.y0, bb.y0);
      Smax.y1 = Math.max(Smax.y1, bb.y1);
      Smax.z0 = Math.min(Smax.z0, bb.z0);
      Smax.z1 = Math.max(Smax.z1, bb.z1);
    }
  const PS = cropBox(labels, next, Smax);
  const SW = Smax.x1 - Smax.x0 + 1;
  const SH = Smax.y1 - Smax.y0 + 1;
  const S: BBox = { ...R };
  const grow = (bb: BBox) => {
    S.x0 = Math.min(S.x0, bb.x0);
    S.x1 = Math.max(S.x1, bb.x1);
    S.y0 = Math.min(S.y0, bb.y0);
    S.y1 = Math.max(S.y1, bb.y1);
    S.z0 = Math.min(S.z0, bb.z0);
    S.z1 = Math.max(S.z1, bb.z1);
  };
  for (let k = 0; k < nOld; k++) if (lost[k]) grow(prevComps[k].bbox);
  const F: BBox = { ...S }; // 要重新 flood fill 的範圍
  // 2. 清掉：掉了體素的結構（F 裡）、R 裡改過的格子
  for (let z = F.z0; z <= F.z1; z++)
    for (let y = F.y0; y <= F.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + F.x0; i <= row + F.x1; i++) {
        const l = labels[i];
        if (l >= 0 && lost[l]) labels[i] = -1;
      }
    }
  for (let z = R.z0, k = 0; z <= R.z1; z++)
    for (let y = R.y0; y <= R.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + R.x0; i <= row + R.x1; i++, k++) if (chg[k]) labels[i] = -1;
    }
  // 3. flood fill 清掉的格子：新片段編號 nOld 起
  const fresh: RawComp[] = [];
  const st: Stack = { buf: new Int32Array(1 << 16) };
  for (let z = F.z0; z <= F.z1; z++)
    for (let y = F.y0; y <= F.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + F.x0; i <= row + F.x1; i++) if (labels[i] < 0 && b[i] !== AIR) fresh.push(floodFill(next, labels, i, nOld + fresh.length, st));
    }
  // 4. union-find：新片段碰到同材質、整塊照舊的結構就接上（只看 F 裡新片段的格子的鄰居）
  const parent = new Int32Array(nOld + fresh.length);
  for (let k = 0; k < parent.length; k++) parent[k] = k;
  const find = (k: number): number => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  const unite = (p: number, q: number) => {
    const rp = find(p);
    const rq = find(q);
    if (rp !== rq) parent[Math.max(rp, rq)] = Math.min(rp, rq);
  };
  const plane = X * Y;
  if (fresh.length)
    for (let z = F.z0; z <= F.z1; z++)
      for (let y = F.y0; y <= F.y1; y++) {
        const row = (z * Y + y) * X;
        for (let x = F.x0; x <= F.x1; x++) {
          const i = row + x;
          const l = labels[i];
          if (l < nOld) continue;
          const m = b[i];
          let o: number;
          if (x > 0 && (o = labels[i - 1]) >= 0 && o < nOld && b[i - 1] === m) unite(l, o);
          if (x < X - 1 && (o = labels[i + 1]) >= 0 && o < nOld && b[i + 1] === m) unite(l, o);
          if (y > 0 && (o = labels[i - X]) >= 0 && o < nOld && b[i - X] === m) unite(l, o);
          if (y < Y - 1 && (o = labels[i + X]) >= 0 && o < nOld && b[i + X] === m) unite(l, o);
          if (z > 0 && (o = labels[i - plane]) >= 0 && o < nOld && b[i - plane] === m) unite(l, o);
          if (z < Z - 1 && (o = labels[i + plane]) >= 0 && o < nOld && b[i + plane] === m) unite(l, o);
        }
      }
  // 5. 每一類（根）＝一個結果結構：整塊照舊的結構（沒掉體素、touched 或接到新片段）＋新片段
  const classOf = new Map<number, number>(); // 根 → 結果編號
  const members: { gs: number[]; fs: number[] }[] = [];
  const add = (k: number) => {
    const r = find(k);
    let c = classOf.get(r);
    if (c === undefined) {
      c = members.length;
      classOf.set(r, c);
      members.push({ gs: [], fs: [] });
    }
    if (k < nOld) members[c].gs.push(k);
    else members[c].fs.push(k - nOld);
  };
  for (let k = 0; k < nOld; k++) if (touched[k] && !lost[k]) add(k);
  for (let j = 0; j < fresh.length; j++) add(nOld + j);
  const raw: RawComp[] = members.map(({ gs, fs }) => {
    const parts = [...gs.map((k) => prevComps[k] as RawComp), ...fs.map((j) => fresh[j])];
    const bb = { ...parts[0].bbox };
    let count = 0;
    for (const p of parts) {
      count += p.count;
      bb.x0 = Math.min(bb.x0, p.bbox.x0);
      bb.x1 = Math.max(bb.x1, p.bbox.x1);
      bb.y0 = Math.min(bb.y0, p.bbox.y0);
      bb.y1 = Math.max(bb.y1, p.bbox.y1);
      bb.z0 = Math.min(bb.z0, p.bbox.z0);
      bb.z1 = Math.max(bb.z1, p.bbox.z1);
    }
    return { mat: parts[0].mat, count, bbox: bb, seed: parts[0].seed };
  });
  // 6. 投票：整塊照舊的結構把全部體素投給自己那一類；掉了體素的照位移數它的體素落在哪一類
  const votes = new Map<number, number>();
  members.forEach(({ gs }, c) => gs.forEach((k) => votes.set(c * nOld + k, prevComps[k].count)));
  // 編號（舊結構 0..nOld−1、新片段 nOld..）→ 結果類別；−1 = 不在任何類（沒碰到的舊結構、掉了體素的舊結構）
  const cls = new Int32Array(nOld + fresh.length).fill(-1);
  for (let k = 0; k < cls.length; k++) if (k >= nOld || (touched[k] && !lost[k])) cls[k] = classOf.get(find(k))!;
  const resOf = (l: number) => (l < 0 ? -1 : cls[l]);
  for (let z = F.z0; z <= F.z1; z++)
    for (let y = F.y0; y <= F.y1; y++) {
      const row = (z * Y + y) * X;
      const prow = ((z - Smax.z0) * SH + y - Smax.y0) * SW - Smax.x0;
      for (let x = F.x0; x <= F.x1; x++) {
        const i = row + x;
        const o = PS[prow + x];
        if (o < 0 || !lost[o]) continue;
        const j = moved(i, o);
        if (j < 0) continue;
        const c = resOf(labels[j]);
        if (c < 0) continue;
        const k = c * nOld + o;
        votes.set(k, (votes.get(k) ?? 0) + 1);
      }
    }
  const named = nameByVotes(prev, raw, votes, matName, newKey);
  // 7. 編號：有整塊照舊結構的類用其中最小的編號；其他照舊結構併進來（它的外框併進 S，labels 在 S 裡重寫）
  const comps = prevComps.slice();
  const target = new Int32Array(members.length).fill(-1);
  const freed: number[] = [];
  members.forEach(({ gs }, c) => {
    if (!gs.length) return;
    const t = Math.min(...gs);
    target[c] = t;
    comps[t] = named[c];
    for (const g of gs)
      if (g !== t) {
        freed.push(g);
        grow(prevComps[g].bbox);
      }
  });
  for (let k = 0; k < nOld; k++) if (lost[k]) freed.push(k);
  freed.sort((p, q) => p - q);
  let fi = 0;
  members.forEach((_, c) => {
    if (target[c] >= 0) return;
    if (fi < freed.length) target[c] = freed[fi++];
    else target[c] = comps.length, comps.push(named[c]);
    comps[target[c]] = named[c];
  });
  // 寫回 S：新片段、被併掉的照舊結構
  const mergedAway = new Int32Array(nOld).fill(-1);
  members.forEach(({ gs }, c) => gs.forEach((g) => g !== target[c] && (mergedAway[g] = target[c])));
  for (let z = S.z0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++) {
      const row = (z * Y + y) * X;
      for (let i = row + S.x0; i <= row + S.x1; i++) {
        const l = labels[i];
        if (l >= nOld) labels[i] = target[cls[l]];
        else if (l >= 0 && mergedAway[l] >= 0) labels[i] = mergedAway[l];
      }
    }
  // 8. 空位壓緊：把最後面的結構搬進空位（只改它外框裡的 labels）
  const holes = new Set(freed.slice(fi));
  const moves: LabelMove[] = [];
  let n = comps.length;
  for (const h of freed.slice(fi)) {
    while (n > 0 && holes.has(n - 1)) n--;
    if (h >= n) continue;
    comps[h] = comps[n - 1];
    moves.push({ from: n - 1, to: h, box: comps[h].bbox });
    holes.delete(h);
    n--;
  }
  while (n > 0 && holes.has(n - 1)) n--;
  comps.length = n;
  // 改前的 labels 在 S 裡（S ⊆ Smax，從快照裁，不必再讀已改寫的陣列）
  const SW2 = S.x1 - S.x0 + 1;
  const before = new Int32Array(SW2 * (S.y1 - S.y0 + 1) * (S.z1 - S.z0 + 1));
  for (let z = S.z0, k = 0; z <= S.z1; z++)
    for (let y = S.y0; y <= S.y1; y++, k += SW2) {
      const s0 = ((z - Smax.z0) * SH + y - Smax.y0) * SW + S.x0 - Smax.x0;
      before.set(PS.subarray(s0, s0 + SW2), k);
    }
  for (const mv of moves) moveLabel(labels, next, mv.box, mv.from, mv.to);
  return { comps, S, moves, before };
}


/** box 裡 labels == from 的改成 to。 */
export function moveLabel(labels: Int32Array, d: { X: number; Y: number }, b: BBox, from: number, to: number) {
  for (let z = b.z0; z <= b.z1; z++)
    for (let y = b.y0; y <= b.y1; y++) {
      const row = (z * d.Y + y) * d.X;
      for (let i = row + b.x0; i <= row + b.x1; i++) if (labels[i] === from) labels[i] = to;
    }
}

/**
 * 一組結構 key 的體素 mask；沒選取回傳 null。
 * dims 有給就只掃這些結構的聯集外框（plan v9 P10：結果仍是整個陣列大小，掃描 O(外框)）。
 */
export function maskOf(L: Labeled, keys: Set<string>, dims?: { X: number; Y: number; Z: number }): Uint8Array | null {
  if (!keys.size) return null;
  const on = new Uint8Array(L.comps.length);
  L.comps.forEach((c, i) => {
    if (keys.has(c.key)) on[i] = 1;
  });
  const mask = new Uint8Array(L.labels.length);
  const b = dims ? unionBBox(L.comps.filter((c) => keys.has(c.key))) : null;
  if (dims && !b) return mask;
  if (b && dims) {
    const { X, Y } = dims;
    for (let z = b.z0; z <= b.z1; z++)
      for (let y = b.y0; y <= b.y1; y++)
        for (let i = (z * Y + y) * X + b.x0, e = i + b.x1 - b.x0; i <= e; i++) {
          const l = L.labels[i];
          if (l >= 0 && on[l]) mask[i] = 1;
        }
    return mask;
  }
  for (let i = 0; i < mask.length; i++) {
    const l = L.labels[i];
    if (l >= 0 && on[l]) mask[i] = 1;
  }
  return mask;
}

export type Axis = 'x' | 'y' | 'z';

export interface Direction {
  id: string;
  name: string;
  hint: string;
  arrow: string;
  axis: Axis;
  d: Vec3;
}

/** 方向用白話；索引怎麼變放小字。 */
export const DIRECTIONS: Direction[] = [
  { id: 'up', name: '往上', hint: '畫面上方，y 索引變小', arrow: '↑', axis: 'y', d: [0, -1, 0] },
  { id: 'down', name: '往下', hint: '畫面下方，y 索引變大', arrow: '↓', axis: 'y', d: [0, 1, 0] },
  { id: 'xm', name: '往左', hint: 'x 索引變小', arrow: '←', axis: 'x', d: [-1, 0, 0] },
  { id: 'xp', name: '往右', hint: 'x 索引變大', arrow: '→', axis: 'x', d: [1, 0, 0] },
  { id: 'zm', name: '往前', hint: '深度方向，z 索引變小', arrow: '⤓', axis: 'z', d: [0, 0, -1] },
  { id: 'zp', name: '往後', hint: '深度方向，z 索引變大', arrow: '⤒', axis: 'z', d: [0, 0, 1] },
];

export const directionName = (d: Vec3) =>
  DIRECTIONS.find((x) => x.d[0] === d[0] && x.d[1] === d[1] && x.d[2] === d[2])?.name ?? '';

/** 這個切面上有沒有 mask 的體素（並排比較用來提示換切面）。 */
export function sliceHasAny(mask: Uint8Array, vol: Volume, axis: Axis, at: number) {
  const { X, Y, Z } = vol;
  if (axis === 'z') {
    const plane = X * Y;
    for (let i = at * plane; i < (at + 1) * plane; i++) if (mask[i]) return true;
    return false;
  }
  if (axis === 'y') {
    for (let z = 0; z < Z; z++) {
      const row = (z * Y + at) * X;
      for (let x = 0; x < X; x++) if (mask[row + x]) return true;
    }
    return false;
  }
  for (let z = 0; z < Z; z++) for (let y = 0; y < Y; y++) if (mask[(z * Y + y) * X + at]) return true;
  return false;
}

/** 16 色可分辨調色盤：載入檔案後依編號順序輪流取。 */
export const PALETTE = [
  '#e8604c',
  '#5b8def',
  '#52b788',
  '#f4a261',
  '#9d7bd8',
  '#4cc9f0',
  '#f06595',
  '#b5b35c',
  '#8e9aaf',
  '#f3b9a1',
  '#7fc8a9',
  '#c9b6e8',
  '#ddd8cb',
  '#9fd3e8',
  '#ffb703',
  '#2a9d8f',
];

/**
 * 檔案沒有材質名稱與顏色的標準欄位，所以一律「材質 n」、顏色從調色盤輪流取；
 * 0 當空、254 當空洞，兩者一定在表裡。名稱與顏色之後在左欄改。
 */
export function materialsFor(ids: Iterable<number>): Material[] {
  let k = 0;
  return [...new Set([...ids, AIR, VOID])]
    .sort((a, b) => a - b)
    .map((id) =>
      id === AIR
        ? { id, name: '0（空／Air）', color: '#ffffff' }
        : id === VOID
          ? { id, name: 'VOID（空洞）', color: '#1f1f1f' }
          : { id, name: `材質 ${id}`, color: PALETTE[k++ % PALETTE.length] },
    );
}

export const bboxDims = (b: BBox) => ({
  w: b.x1 - b.x0 + 1,
  h: b.y1 - b.y0 + 1,
  d: b.z1 - b.z0 + 1,
  x: b.x0,
  y: b.y0,
  z: b.z0,
});

export const unionBBox = (comps: { bbox: BBox }[]): BBox | null =>
  comps.length
    ? comps.reduce(
        (a, c) => ({
          x0: Math.min(a.x0, c.bbox.x0),
          x1: Math.max(a.x1, c.bbox.x1),
          y0: Math.min(a.y0, c.bbox.y0),
          y1: Math.max(a.y1, c.bbox.y1),
          z0: Math.min(a.z0, c.bbox.z0),
          z1: Math.max(a.z1, c.bbox.z1),
        }),
        { ...comps[0].bbox },
      )
    : null;
