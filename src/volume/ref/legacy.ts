// 改寫前的 growMask／levelMask／translateMask（plan v7 §7.2 改用 kernel 之前的版本），只給測試當對照。
// 改寫後的版本必須和這裡逐體素相同。
import { type Backfill, type BrushShape, type Vec3, type Volume, AIR, coordOf, inBrush } from '../volume';
import { type Scope, axisIndex, scopeBox } from '../scope';

const inside = (v: Volume, x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < v.X && y < v.Y && z < v.Z;

/**
 * 補平：筆刷範圍內每一列（沿 dir 軸）的最外側面補到或削到座標 to。
 * 矮的補起來（只填 Air；follow = 前方的薄襯層整列往前推、再填，和推面一樣；碰到厚的材質就停、不吃鄰居）；
 * 高的削掉（回填原始內容；follow = 上面的襯層跟著退回來）。
 * 只動 mask ∩ scope 裡的列；其他體素一個都不變。
 */
export function legacyLevelMask(
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
  const coord = (a: number, b: number, t: number): Vec3 => (axis === 0 ? [t, a, b] : axis === 1 ? [a, t, b] : [a, b, t]);
  const A = axis === 0 ? Y : X;
  const B = axis === 2 ? Y : Z;
  const sa = axisIndex(scope.axis);
  const inZ = (c: Vec3) => c[sa] >= scope.lo && c[sa] <= scope.hi;
  for (let b = 0; b < B; b++)
    for (let a = 0; a < A; a++) {
      const c0 = coord(a, b, 0);
      if (!inBrush(axis, center, r, shape, c0[0], c0[1], c0[2])) continue;
      // 這一列最外側（沿 dir）的 mask 體素
      let outer = -1;
      for (let t = 0; t < len; t++) if (mask[at(a, b, t)] && inZ(coord(a, b, t)) && (sign > 0 || outer < 0)) outer = t;
      if (outer < 0) continue;
      const mat = vol.data[at(a, b, outer)];
      const gap = (to - outer) * sign;
      if (gap > 0) {
        // 補：從 outer 往 dir 走到 to；Air 直接填，薄襯層（follow）先往前推一格再填，厚的材質就停
        for (let k = 1; k <= gap; k++) {
          const t = outer + k * sign;
          if (t < 0 || t >= len) break;
          const i = at(a, b, t);
          const c = coord(a, b, t);
          if (!inZ(c)) break;
          if (out[i] !== AIR) {
            if (!follow) break;
            const liners = collectLiners(live, c, d, mat);
            if (!liners.length) break;
            for (let j = liners.length - 1; j >= 0; j--) {
              const [lx, ly, lz] = coordOf(live, liners[j]);
              const tx = lx + d[0];
              const ty = ly + d[1];
              const tz = lz + d[2];
              if (inside(live, tx, ty, tz)) out[(tz * Y + ty) * X + tx] = out[liners[j]];
            }
          }
          out[i] = mat;
        }
      } else if (gap < 0) {
        // 削：從 outer 往回退到 to+1；follow = 上面的襯層一格一格跟著退、最外面回填
        for (let k = 0; k < -gap; k++) {
          const t = outer - k * sign;
          const i = at(a, b, t);
          const c = coord(a, b, t);
          if (!mask[i] || !inZ(c)) continue;
          if (follow) {
            const liners = collectLiners(live, [c[0] + d[0], c[1] + d[1], c[2] + d[2]], d, mat);
            if (liners.length) {
              let dst = i;
              for (const j of liners) {
                out[dst] = out[j];
                dst = j;
              }
              out[dst] = fillAt(orig, dst, out[dst], backfill);
              continue;
            }
          }
          out[i] = fillAt(orig, i, vol.data[i], backfill);
        }
      }
    }
  return { X, Y, Z, data: out };
}

/** 回填：'orig' → 原始陣列該位置；若原本就是被搬走的材質則填 Air。 */
const fillAt = (orig: Volume, i: number, movedMat: number, backfill: Backfill) => {
  if (backfill !== 'orig') return backfill;
  const o = orig.data[i];
  return o === movedMat ? AIR : o;
};

/** 整塊平移：先清空（回填）再寫入目標，搬到的地方蓋過去。 */
export function legacyTranslateMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  scope: Scope,
  d: Vec3,
  backfill: Backfill,
): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const moved: number[] = [];
  const mats: number[] = [];
  const b = scopeBox(vol, scope);
  if (b)
  for (let z = b.z0; z <= b.z1; z++)
    for (let y = b.y0; y <= b.y1; y++)
      for (let x = b.x0; x <= b.x1; x++) {
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

/** 換材質：只改 mask ∩ scope。 */
export function legacySetMaskMaterial(vol: Volume, mask: Uint8Array, scope: Scope, mat: number): Volume {
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

/** 薄層判定：沿方向連續 ≤ 這麼多格才算襯層。 */
const LINER_MAX = 4;

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
export function legacyGrowMask(
  vol: Volume,
  orig: Volume,
  mask: Uint8Array,
  scope: Scope,
  dir: Vec3,
  n: number,
  backfill: Backfill,
  follow: boolean,
): Volume {
  let cur = vol;
  let m = new Uint8Array(mask);
  const { X, Y, Z } = vol;
  const sb = scopeBox(vol, scope);
  if (!sb) return vol;
  for (let step = 0; step < Math.abs(n); step++) {
    const out = new Uint8Array(cur.data);
    const d: Vec3 = n > 0 ? dir : [-dir[0], -dir[1], -dir[2]];
    if (n > 0) {
      const front = shiftMask(cur, outerFace(cur, m, d), d);
      for (let z = sb.z0; z <= sb.z1; z++)
        for (let y = sb.y0; y <= sb.y1; y++)
          for (let x = sb.x0; x <= sb.x1; x++) {
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
      for (let z = sb.z0; z <= sb.z1; z++)
        for (let y = sb.y0; y <= sb.y1; y++)
          for (let x = sb.x0; x <= sb.x1; x++) {
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

