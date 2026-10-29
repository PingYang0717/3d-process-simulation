// 體素陣列與所有直接改體素的操作。
// index = (z·Y + y)·X + x，對應 numpy C order 的 shape (Z, Y, X)。

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

/** 範例：3 根 fin × 3 根 poly gate，160×96×128；Poly-Si 3 裡有 3 片 bamboo defect（VOID）。 */
export function demoVolume(): Volume {
  const X = 160;
  const Y = 96;
  const Z = 128;
  const data = new Uint8Array(X * Y * Z);
  const at = (x: number, y: number, z: number) => (z * Y + y) * X + x;
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: number) => {
    for (let z = Math.max(0, z0); z < Math.min(Z, z1); z++)
      for (let y = Math.max(0, y0); y < Math.min(Y, y1); y++)
        for (let x = Math.max(0, x0); x < Math.min(X, x1); x++) data[at(x, y, z)] = m;
  };
  const finCenters = [40, 80, 120];
  const finW = 12;
  const finTop = 30;
  const stiTop = 60;
  const subTop = 70;
  const gates: [number, number][] = [
    [14, 38],
    [52, 76],
    [90, 114],
  ];
  box(0, X, subTop, Y, 0, Z, 1);
  box(0, X, stiTop, subTop, 0, Z, 2);
  // fin 截面：頂角切掉 2 格
  const isFin = (x: number, y: number) =>
    finCenters.some((c) => {
      const l = c - finW / 2;
      const r = c + finW / 2;
      if (x < l || x >= r || y < finTop || y >= subTop) return false;
      return Math.min(x - l, r - 1 - x) + (y - finTop) >= 2;
    });
  for (const [z0, z1] of gates) {
    box(8, 152, 18, stiTop, z0, z1, 6);
    box(8, 152, 14, 18, z0, z1, 7);
  }
  for (let z = 0; z < Z; z++)
    for (let y = finTop; y < subTop; y++) for (let x = 0; x < X; x++) if (isFin(x, y)) data[at(x, y, z)] = 3;
  const distToFin = (x: number, y: number) => {
    let d = 99;
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) if (isFin(x + dx, y + dy)) d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
    return d;
  };
  for (const [z0, z1] of gates)
    for (let z = z0; z < z1; z++)
      for (let y = finTop - 4; y < stiTop; y++)
        for (let x = 0; x < X; x++) {
          if (isFin(x, y)) continue;
          const d = distToFin(x, y);
          if (d <= 2) data[at(x, y, z)] = 4;
          else if (d <= 4) data[at(x, y, z)] = 5;
        }
  for (const z of [96, 101, 106])
    for (let y = 24; y < 56; y++)
      for (let x = 24; x < 136; x++) if (data[at(x, y, z)] === 6) data[at(x, y, z)] = VOID;
  return { X, Y, Z, data };
}

export interface Faces {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** 每個三角形屬於哪個體素（兩個三角形一個四邊形），供射線點選。 */
  faceVoxel: Int32Array;
  count: number;
}

const NEIGHBORS: Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * 只產生暴露面：鄰居材質不同（或被隱藏）才畫。
 * 給 mask 時改成只畫 mask 的外殼（選取顯示用）。
 */
export function buildFaces(vol: Volume, colorOf: (mat: number) => Vec3 | null, mask?: Uint8Array | null): Faces {
  const { X, Y, Z, data } = vol;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const fv: number[] = [];
  const quad = (x: number, y: number, z: number, n: Vec3, c: Vec3, voxel: number) => {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const cz = z + 0.5;
    const [nx, ny, nz] = n;
    const u: Vec3 = nx ? [0, 1, 0] : [1, 0, 0];
    const w: Vec3 = nz ? [0, 1, 0] : [0, 0, 1];
    const fx = cx + nx * 0.5;
    const fy = cy + ny * 0.5;
    const fz = cz + nz * 0.5;
    const corner = (a: number, b: number): Vec3 => [
      fx + u[0] * a * 0.5 + w[0] * b * 0.5,
      fy + u[1] * a * 0.5 + w[1] * b * 0.5,
      fz + u[2] * a * 0.5 + w[2] * b * 0.5,
    ];
    const p0 = corner(-1, -1);
    const p1 = corner(1, -1);
    const p2 = corner(1, 1);
    const p3 = corner(-1, 1);
    const tris = nx + ny + nz > 0 ? [p0, p1, p2, p0, p2, p3] : [p0, p2, p1, p0, p3, p2];
    for (const p of tris) {
      pos.push(p[0], p[1], p[2]);
      nor.push(nx, ny, nz);
      col.push(c[0] / 255, c[1] / 255, c[2] / 255);
    }
    fv.push(voxel, voxel);
  };
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        const m = data[i];
        if (mask ? !mask[i] : m === AIR) continue;
        const c = mask ? ([31, 94, 255] as Vec3) : colorOf(m);
        if (!c) continue;
        for (const n of NEIGHBORS) {
          const nx = x + n[0];
          const ny = y + n[1];
          const nz = z + n[2];
          const out = nx < 0 || ny < 0 || nz < 0 || nx >= X || ny >= Y || nz >= Z;
          const j = out ? -1 : (nz * Y + ny) * X + nx;
          const exposed = mask ? out || !mask[j] : (out ? AIR : data[j]) !== m;
          if (exposed) quad(x, y, z, n, c, i);
        }
      }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    colors: new Float32Array(col),
    faceVoxel: new Int32Array(fv),
    count: pos.length / 3,
  };
}

/** 回填：'orig' → 原始陣列該位置；若原本就是被搬走的材質則填 Air。 */
export const fillAt = (orig: Volume, i: number, movedMat: number, backfill: Backfill) => {
  if (backfill !== 'orig') return backfill;
  const o = orig.data[i];
  return o === movedMat ? AIR : o;
};

/** 整塊平移：先清空（回填）再寫入目標，搬到的地方蓋過去。 */
export function translateMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  zRange: ZRange,
  d: Vec3,
  backfill: Backfill,
): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const moved: number[] = [];
  const mats: number[] = [];
  for (let z = zRange[0]; z <= zRange[1]; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (!mask[i]) continue;
        moved.push(i);
        mats.push(vol.data[i]);
        out[i] = fillAt(orig, i, vol.data[i], backfill);
      }
  moved.forEach((i, k) => {
    const [x, y, z] = coordOf(vol, i);
    const tx = x + d[0];
    const ty = y + d[1];
    const tz = z + d[2];
    if (tx >= 0 && ty >= 0 && tz >= 0 && tx < X && ty < Y && tz < Z) out[(tz * Y + ty) * X + tx] = mats[k];
  });
  return { X, Y, Z, data: out };
}

/** 換材質：只改 mask ∩ z 範圍。 */
export function setMaskMaterial(vol: Volume, mask: Uint8Array, zRange: ZRange, mat: number): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  for (let z = zRange[0]; z <= zRange[1]; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++) {
        const i = (z * Y + y) * X + x;
        if (mask[i]) out[i] = mat;
      }
  return { X, Y, Z, data: out };
}

/** 薄層判定：沿方向連續 ≤ 這麼多格才算襯層。 */
export const LINER_MAX = 4;

const shiftMask = (vol: Volume, mask: Uint8Array, d: Vec3) => {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(mask.length);
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
const outerFace = (vol: Volume, mask: Uint8Array, d: Vec3) => {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(mask.length);
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
 * 從 (x, y, z) 起沿 step 收集前方薄層的體素（遇到 Air、stopMat 或厚於 LINER_MAX 的材質就停）。
 */
const collectLiners = (vol: Volume, start: Vec3, step: Vec3, stopMat: number) => {
  const { X, Y, data } = vol;
  const cells: number[] = [];
  let [x, y, z] = start;
  while (inside(vol, x, y, z)) {
    const m = data[(z * Y + y) * X + x];
    if (m === AIR || m === stopMat) break;
    let run = 0;
    let [rx, ry, rz] = [x, y, z];
    while (inside(vol, rx, ry, rz) && data[(rz * Y + ry) * X + rx] === m) {
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
 * 推面：沿 dir 膨脹（n > 0）或侵蝕（n < 0）|n| 格，只推那一面。
 * follow = 襯層跟著走：前方薄層整列前移一格；縮短時同一列退回一格。
 */
export function growMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  zRange: ZRange,
  dir: Vec3,
  n: number,
  backfill: Backfill,
  follow: boolean,
): Volume {
  let cur = vol;
  let m = new Uint8Array(mask);
  const { X, Y, Z } = vol;
  for (let step = 0; step < Math.abs(n); step++) {
    const out = new Uint8Array(cur.data);
    const d: Vec3 = n > 0 ? dir : [-dir[0], -dir[1], -dir[2]];
    if (n > 0) {
      const front = shiftMask(cur, outerFace(cur, m, d), d);
      for (let z = zRange[0]; z <= zRange[1]; z++)
        for (let y = 0; y < Y; y++)
          for (let x = 0; x < X; x++) {
            const i = (z * Y + y) * X + x;
            if (!front[i] || m[i]) continue;
            const src = (z - d[2]) * X * Y + (y - d[1]) * X + (x - d[0]);
            const mat = cur.data[src];
            if (follow) {
              const liners = collectLiners(cur, [x, y, z], d, mat);
              for (let k = liners.length - 1; k >= 0; k--) {
                const [lx, ly, lz] = coordOf(cur, liners[k]);
                const tx = lx + d[0];
                const ty = ly + d[1];
                const tz = lz + d[2];
                if (inside(cur, tx, ty, tz)) out[(tz * Y + ty) * X + tx] = cur.data[liners[k]];
              }
            }
            out[i] = mat;
          }
      m = new Uint8Array(m);
      for (let i = 0; i < m.length; i++) if (front[i]) m[i] = 1;
    } else {
      // d 指向要退的方向（dir 的反向）；要退掉的是 dir 方向最外側那一層
      const back: Vec3 = [-d[0], -d[1], -d[2]];
      const face = outerFace(cur, m, back);
      for (let z = zRange[0]; z <= zRange[1]; z++)
        for (let y = 0; y < Y; y++)
          for (let x = 0; x < X; x++) {
            const i = (z * Y + y) * X + x;
            if (!face[i]) continue;
            const mat = cur.data[i];
            let pulled = false;
            if (follow) {
              const liners = collectLiners(cur, [x + back[0], y + back[1], z + back[2]], back, mat);
              if (liners.length) {
                let to = i;
                for (const j of liners) {
                  out[to] = cur.data[j];
                  to = j;
                }
                out[to] = fillAt(orig, to, cur.data[to], backfill);
                pulled = true;
              }
            }
            if (!pulled) out[i] = fillAt(orig, i, mat, backfill);
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

/** 6 鄰接 flood fill（stack），順便算 bbox、count、seed。 */
export function labelComponents(vol: Volume): { labels: Int32Array; raw: RawComp[] } {
  const { X, Y, Z, data } = vol;
  const labels = new Int32Array(X * Y * Z).fill(-1);
  const raw: RawComp[] = [];
  const stack: number[] = [];
  for (let s = 0; s < data.length; s++) {
    if (labels[s] >= 0 || data[s] === AIR) continue;
    const mat = data[s];
    const id = raw.length;
    let count = 0;
    const bbox: BBox = { x0: X, x1: -1, y0: Y, y1: -1, z0: Z, z1: -1 };
    stack.push(s);
    labels[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      if (x < bbox.x0) bbox.x0 = x;
      if (x > bbox.x1) bbox.x1 = x;
      if (y < bbox.y0) bbox.y0 = y;
      if (y > bbox.y1) bbox.y1 = y;
      if (z < bbox.z0) bbox.z0 = z;
      if (z > bbox.z1) bbox.z1 = z;
      const nb = [
        x > 0 ? i - 1 : -1,
        x < X - 1 ? i + 1 : -1,
        y > 0 ? i - X : -1,
        y < Y - 1 ? i + X : -1,
        z > 0 ? i - X * Y : -1,
        z < Z - 1 ? i + X * Y : -1,
      ];
      for (const j of nb)
        if (j >= 0 && labels[j] < 0 && data[j] === mat) {
          labels[j] = id;
          stack.push(j);
        }
    }
    raw.push({ mat, count, bbox, seed: s });
  }
  return { labels, raw };
}

/** 第一次標記：依材質、x、z 排序編號，例如「Poly-Si 2」。 */
export function initialLabeled(vol: Volume, matName: (id: number) => string): Labeled {
  const { labels, raw } = labelComponents(vol);
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
  return { labels, comps };
}

const labelNumber = (label: string) => parseInt(label.split(' ').pop() ?? '0', 10) || 0;

/**
 * 名稱延續：舊結構的體素（已選的照位移平移）落在哪個新結構最多，新結構就沿用它的 key 與名字。
 * 大的先認領；同材質或重疊過半才繼承；被切出來的那一塊取新名。
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
  const { labels, raw } = labelComponents(next);
  const { X, Y, Z } = next;
  const owner = new Int32Array(raw.length).fill(-1);
  const nOld = prev.comps.length;
  const votes = new Map<number, number>();
  for (let i = 0; i < prevVol.data.length; i++) {
    const o = prev.labels[i];
    if (o < 0) continue;
    let j = i;
    if (movedMask?.[i]) {
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      const tx = x + shift[0];
      const ty = y + shift[1];
      const tz = z + shift[2];
      if (tx < 0 || ty < 0 || tz < 0 || tx >= X || ty >= Y || tz >= Z) continue;
      j = (tz * Y + ty) * X + tx;
    }
    const nw = labels[j];
    if (nw < 0) continue;
    const k = nw * nOld + o;
    votes.set(k, (votes.get(k) ?? 0) + 1);
  }
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
      if (raw[n].mat === prev.comps[o].mat || c * 2 > raw[n].count) {
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
  const comps = raw.map((r, i): Comp => {
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
  return { labels, comps };
}

/** 一組結構 key 的體素 mask；沒選取回傳 null。 */
export function maskOf(L: Labeled, keys: Set<string>): Uint8Array | null {
  if (!keys.size) return null;
  const ids = new Set<number>();
  L.comps.forEach((c, i) => {
    if (keys.has(c.key)) ids.add(i);
  });
  const mask = new Uint8Array(L.labels.length);
  for (let i = 0; i < mask.length; i++) if (L.labels[i] >= 0 && ids.has(L.labels[i])) mask[i] = 1;
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

/** 編號沒有內建色票時的自動配色。 */
export function hslHex(h: number, s: number, l: number) {
  h /= 360;
  s /= 100;
  l /= 100;
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** 依陣列裡出現的編號建立材質表；保證有 Air 與 VOID。 */
export function materialsFor(vol: Volume): Material[] {
  let mats = [...new Set(vol.data)]
    .sort((a, b) => a - b)
    .map((id) => MATERIALS.find((m) => m.id === id) ?? { id, name: `材質 ${id}`, color: hslHex((id * 47) % 360, 55, 70) });
  if (!mats.some((m) => m.id === VOID)) mats = [...mats, MATERIALS[MATERIALS.length - 1]];
  if (!mats.some((m) => m.id === AIR)) mats = [MATERIALS[0], ...mats];
  return mats;
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
