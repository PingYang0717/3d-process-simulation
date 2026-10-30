// profile Op（plan v7 §7.3、§10.3）：2D 剖面上拖節點、斜邊、圓弧產生的改動。
// 一份「要加的格子」與「要拿的格子」（切面座標，每格帶往外的方向碼），套用到 scope 裡的每一片：
// 先拿再加；加的格子由近到遠、要和這一片已經是結構的格子 4 鄰接才填；這一片沒有結構就整片略過。
// 實際改體素一律走 kernel（和 3D 的推面、補平同一套規則）。
import type { Backfill, Vec3, Volume } from './volume';
import { type Report, addCell, removeCell } from './kernel';
import { type Scope, axisIndex, planeAxes, to3D } from './scope';

/** 切面上的 RLE：相對 (x0, y0) 的外框；runs = [row, start, len, dir, ...]（dir 0 = +u、1 = −u、2 = +v、3 = −v）。 */
export interface Rle2D {
  x0: number;
  y0: number;
  w: number;
  h: number;
  runs: number[];
}

export interface ProfileCell {
  u: number;
  v: number;
  dir: number;
}

export interface ProfileOp {
  kind: 'profile';
  keys: string[];
  /** axis = 切面法線軸。 */
  scope: Scope;
  /** 參考片（手勢做在哪一片）。 */
  at: number;
  /** 每個結構各自一份要加、要拿的格子。 */
  perKey: Record<string, { add: Rle2D; remove: Rle2D }>;
  follow: boolean;
  backfill: Backfill;
  /** 「頂角節點往外 2 vx」之類，由手勢產生。 */
  text?: string;
}

/** 格子 → RLE（同一列、相鄰、同方向的合成一段）。順序照給的順序的列排，套用時再依距離排序。 */
export function encodeRle(cells: ProfileCell[]): Rle2D {
  if (!cells.length) return { x0: 0, y0: 0, w: 0, h: 0, runs: [] };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of cells) {
    x0 = Math.min(x0, c.u);
    y0 = Math.min(y0, c.v);
    x1 = Math.max(x1, c.u);
    y1 = Math.max(y1, c.v);
  }
  const sorted = [...cells].sort((a, b) => a.v - b.v || a.u - b.u);
  const runs: number[] = [];
  for (const c of sorted) {
    const n = runs.length;
    if (n && runs[n - 4] === c.v - y0 && runs[n - 3] + runs[n - 2] === c.u - x0 && runs[n - 1] === c.dir) runs[n - 2]++;
    else runs.push(c.v - y0, c.u - x0, 1, c.dir);
  }
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1, runs };
}

export function decodeRle(r: Rle2D): ProfileCell[] {
  const out: ProfileCell[] = [];
  for (let k = 0; k < r.runs.length; k += 4) {
    const [row, start, len, dir] = [r.runs[k], r.runs[k + 1], r.runs[k + 2], r.runs[k + 3]];
    for (let j = 0; j < len; j++) out.push({ u: r.x0 + start + j, v: r.y0 + row, dir });
  }
  return out;
}

/** 方向碼 → 體素方向（切面 axis 上）。 */
export function dirVec(axis: Scope['axis'], code: number): Vec3 {
  const du = code === 0 ? 1 : code === 1 ? -1 : 0;
  const dv = code === 2 ? 1 : code === 3 ? -1 : 0;
  return to3D(axis, du, dv, 0);
}

/** add／remove 的 RLE 在切面上的外框（沒有格子回傳 null）。 */
export function rleBox(r: Rle2D) {
  return r.runs.length ? { u0: r.x0, v0: r.y0, u1: r.x0 + r.w - 1, v1: r.y0 + r.h - 1 } : null;
}

/**
 * 在 vol 上套用 profile（vol 可以是裁下來的一塊，off = 它在整個陣列的起點）。
 * masks：每個 key 的結構體素（和 vol 同大小）。
 */
export function applyProfileMask(vol: Volume, orig: Volume, masks: Map<string, Uint8Array>, op: ProfileOp, off: Vec3, report?: Report): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const live: Volume = { X, Y, Z, data: out };
  const a = axisIndex(op.scope.axis);
  const [ua, va] = planeAxes(op.scope.axis);
  const dims = [X, Y, Z];
  const len = dims[a];
  const at = (u: number, v: number, t: number) => {
    const p = to3D(op.scope.axis, u - off[ua], v - off[va], t);
    return p[0] < 0 || p[1] < 0 || p[2] < 0 || p[0] >= X || p[1] >= Y || p[2] >= Z ? -1 : (p[2] * Y + p[1]) * X + p[0];
  };
  const cells = Object.fromEntries(Object.entries(op.perKey).map(([k, v]) => [k, { add: decodeRle(v.add), remove: decodeRle(v.remove) }]));
  const lo = Math.max(0, op.scope.lo - off[a]);
  const hi = Math.min(len - 1, op.scope.hi - off[a]);
  for (let t = lo; t <= hi; t++) {
    let any = false;
    for (const key of op.keys) {
      const mask = masks.get(key);
      const c = cells[key];
      if (!mask || !c) continue;
      // 這一片有沒有這個結構（只看 add／remove 附近不夠：結構可能整片不在）
      let has = false;
      const pl = [0, 0, 0];
      pl[a] = t;
      const [A, B] = [dims[ua], dims[va]];
      for (let v = 0; v < B && !has; v++)
        for (let u = 0; u < A; u++) {
          pl[ua] = u;
          pl[va] = v;
          if (mask[(pl[2] * Y + pl[1]) * X + pl[0]]) {
            has = true;
            break;
          }
        }
      if (!has) continue;
      any = true;
      // 先拿：只拿屬於這個結構的
      for (const cell of c.remove) {
        const i = at(cell.u, cell.v, t);
        if (i < 0 || !mask[i]) continue;
        const x = i % X;
        const y = ((i - x) / X) % Y;
        const z = (i - x - y * X) / (X * Y);
        const m = out[i];
        removeCell(live, out, orig, x, y, z, dirVec(op.scope.axis, cell.dir), m, m, op.backfill, op.follow, report);
      }
      // 再加：由近到遠（cells 已依 BFS 距離排序），要 4 鄰接「已是結構」的格子才填，材質取那個鄰居的
      const grown = new Set<number>();
      const isStruct = (i: number) => i >= 0 && ((mask[i] && out[i] === vol.data[i]) || grown.has(i));
      const nbrs: [number, number][] = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      // 加的格子可能要好幾輪才接得上（RLE 是逐列存的）：依「離結構的距離」一層一層加
      let pending = c.add.slice();
      for (let round = 0; pending.length && round < 256; round++) {
        const next: typeof pending = [];
        for (const cell of pending) {
          const i = at(cell.u, cell.v, t);
          if (i < 0) continue;
          let src = -1;
          for (const [du, dv] of nbrs) {
            const j = at(cell.u + du, cell.v + dv, t);
            if (isStruct(j)) {
              src = j;
              break;
            }
          }
          if (src < 0) {
            next.push(cell);
            continue;
          }
          const x = i % X;
          const y = ((i - x) / X) % Y;
          const z = (i - x - y * X) / (X * Y);
          if (out[i] === out[src] && mask[i]) continue;
          if (addCell(live, out, x, y, z, dirVec(op.scope.axis, cell.dir), out[src], op.follow, 'block', report)) grown.add(i);
        }
        if (next.length === pending.length) break;
        pending = next;
      }
    }
    if (!any && report) report.skipped.push(t + off[a]);
  }
  return live;
}
