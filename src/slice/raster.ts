// 編輯後的環 → 這一片的格子（plan v7 §10.2）：掃描線以格子中心判定內外（偶奇規則，內環自動挖空），不反鋸齒；
// 前後比較得到要加、要拿的格子，每格帶方向碼（往外的軸向）。
import type { Ring, XY } from './trace';

/** 方向碼：0 = +u、1 = −u、2 = +v、3 = −v。 */
export const DIR_UV: XY[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
export const dirCode = (du: number, dv: number) => (Math.abs(du) >= Math.abs(dv) ? (du >= 0 ? 0 : 1) : dv >= 0 ? 2 : 3);

/** 多邊形（可多個，偶奇規則）→ W×H 的格子（格子中心在裡面才算）；off = 格子 (0,0) 的座標。 */
export function rasterize(polys: XY[][], u0: number, v0: number, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H);
  const xs: number[] = [];
  for (let r = 0; r < H; r++) {
    const y = v0 + r + 0.5;
    xs.length = 0;
    for (const p of polys)
      for (let i = 0; i < p.length; i++) {
        const [ax, ay] = p[i];
        const [bx, by] = p[(i + 1) % p.length];
        if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil(xs[k] - 0.5 - u0));
      const to = Math.min(W, Math.ceil(xs[k + 1] - 0.5 - u0));
      for (let c = from; c < to; c++) out[r * W + c] = 1;
    }
  }
  return out;
}

/**
 * 編輯環：disp[i] = 第 i 個頂點的位移。每一段兩端位移相同 → 原始折線整段平移；
 * 不同 → 沿原始折線長度內插（彎的地方跟著變形）。回傳新的完整折線。
 */
export function editRing(r: Ring, disp: XY[]): XY[] {
  const out: XY[] = [];
  r.raw.forEach((seg, i) => {
    const d0 = disp[i];
    const d1 = disp[(i + 1) % disp.length];
    const len: number[] = [0];
    for (let k = 1; k < seg.length; k++) len.push(len[k - 1] + Math.hypot(seg[k][0] - seg[k - 1][0], seg[k][1] - seg[k - 1][1]));
    const total = len[len.length - 1] || 1;
    for (let k = 0; k < seg.length - 1; k++) {
      const t = len[k] / total;
      out.push([seg[k][0] + d0[0] + (d1[0] - d0[0]) * t, seg[k][1] + d0[1] + (d1[1] - d0[1]) * t]);
    }
  });
  return out;
}

export interface Cell {
  u: number;
  v: number;
  /** 方向碼（往外）。 */
  dir: number;
}

/**
 * 前後兩份格子的差：after && !before → 加、before && !after → 拿。
 * 加的格子方向＝從原本的結構 BFS 走過來的方向（離原本邊界由近到遠排序）；
 * 拿的格子方向＝往外（往現在的外面 BFS 反過來）。
 */
export function deltaOf(before: Uint8Array, after: Uint8Array, u0: number, v0: number, W: number, H: number): { add: Cell[]; remove: Cell[] } {
  const bfs = (seed: (i: number) => boolean, target: (i: number) => boolean) => {
    const dirOf = new Int8Array(W * H).fill(-1);
    const order: number[] = [];
    let q: number[] = [];
    for (let i = 0; i < W * H; i++) if (seed(i)) q.push(i);
    const seen = new Uint8Array(W * H);
    q.forEach((i) => (seen[i] = 1));
    while (q.length) {
      const nq: number[] = [];
      for (const i of q) {
        const u = i % W;
        const v = (i - u) / W;
        for (let d = 0; d < 4; d++) {
          const nu = u + DIR_UV[d][0];
          const nv = v + DIR_UV[d][1];
          if (nu < 0 || nv < 0 || nu >= W || nv >= H) continue;
          const j = nv * W + nu;
          if (seen[j] || !target(j)) continue;
          seen[j] = 1;
          dirOf[j] = d;
          order.push(j);
          nq.push(j);
        }
      }
      q = nq;
    }
    return { dirOf, order };
  };
  const adds = bfs((i) => !!before[i], (i) => !!after[i] && !before[i]);
  const add: Cell[] = adds.order.map((i) => ({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: adds.dirOf[i] }));
  // 拿：從外面（原本就不是結構的格子）走進被拿掉的格子；往外 = 走進來方向的反向
  const rems = bfs((i) => !before[i], (i) => !!before[i] && !after[i]);
  const flip = [1, 0, 3, 2];
  const remove: Cell[] = rems.order.map((i) => ({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: flip[rems.dirOf[i]] }));
  // 和外面不相連的被拿掉的格子（例如被包住）也要拿：方向給往上
  for (let i = 0; i < W * H; i++)
    if (before[i] && !after[i] && rems.dirOf[i] < 0) remove.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  for (let i = 0; i < W * H; i++)
    if (after[i] && !before[i] && adds.dirOf[i] < 0) add.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  return { add, remove };
}
