// 切面上的格子 RLE（profile Op 的 add／remove、手勢的輸出共用）。

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

/** add／remove 的 RLE 在切面上的外框（沒有格子回傳 null）。 */
export function rleBox(r: Rle2D) {
  return r.runs.length ? { u0: r.x0, v0: r.y0, u1: r.x0 + r.w - 1, v1: r.y0 + r.h - 1 } : null;
}

