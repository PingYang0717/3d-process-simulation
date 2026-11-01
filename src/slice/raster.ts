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

/** BFS 的 scratch（plan v15 B3）：依 W·H 放大、每次 fill 清，不每幀配新的。同一時間只有一個 deltaOf 在跑。 */
let dirScratch = new Int8Array(0);
let seenScratch = new Uint8Array(0);
const scratchFor = (n: number) => {
  if (dirScratch.length < n) {
    dirScratch = new Int8Array(n);
    seenScratch = new Uint8Array(n);
  }
  return { dirOf: dirScratch, seen: seenScratch };
};

/**
 * 前後兩份格子的差：after && !before → 加、before && !after → 拿。
 * 加的格子方向＝從原本的結構 BFS 走過來的方向（離原本邊界由近到遠排序）；
 * 拿的格子方向＝往外（往現在的外面 BFS 反過來）。
 *
 * plan v15 B3：BFS 的種子只取「邊界格」——是 src 而且 4 鄰接裡有 target 的格子。原本把所有 src 格子都推進 queue，
 * 拿的那次（src = 外面）等於整個 bbox 的外面都進 JS array。發現的集合與順序和原本完全相同：原本的種子迴圈依
 * index 遞增、每個種子 d = 0..3 找鄰居，一個沒有 target 鄰居的種子什麼都不會發現，拿掉它不影響其他種子的順序
 * （deltaOfRef 是原本的寫法，raster.test.ts 隨機對照）。dirOf／seen 用模組層 scratch；回傳的 Cell[] 不變。
 */
export function deltaOf(before: Uint8Array, after: Uint8Array, u0: number, v0: number, W: number, H: number): { add: Cell[]; remove: Cell[] } {
  const N = W * H;
  const { dirOf, seen } = scratchFor(N);
  /** src(i) 是種子的那一側、target(i) 要被發現的格子；bfs 回傳發現的順序，方向留在 dirOf。 */
  const bfs = (src: (i: number) => boolean, target: (i: number) => boolean) => {
    dirOf.fill(-1, 0, N);
    seen.fill(0, 0, N);
    const order: number[] = [];
    let q: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!src(i)) continue;
      const u = i % W;
      // 邊界格：4 鄰接裡至少一個 target
      if ((u + 1 < W && target(i + 1)) || (u > 0 && target(i - 1)) || (i + W < N && target(i + W)) || (i >= W && target(i - W))) q.push(i);
    }
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
    return order;
  };
  const isAdd = (i: number) => !!after[i] && !before[i];
  const isRem = (i: number) => !!before[i] && !after[i];
  // 加：從原本的結構走進新長出來的格子（scratch 在下一次 bfs 會被蓋掉，所以沒走到的也在這裡先補）
  const add: Cell[] = bfs((i) => !!before[i], isAdd).map((i) => ({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: dirOf[i] }));
  const addTail: Cell[] = [];
  for (let i = 0; i < N; i++) if (after[i] && !before[i] && dirOf[i] < 0) addTail.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  // 拿：從外面（原本就不是結構的格子）走進被拿掉的格子；往外 = 走進來方向的反向
  const flip = [1, 0, 3, 2];
  const remove: Cell[] = bfs((i) => !before[i], isRem).map((i) => ({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: flip[dirOf[i]] }));
  // 和外面不相連的被拿掉的格子（例如被包住）也要拿：方向給往上
  for (let i = 0; i < N; i++)
    if (before[i] && !after[i] && dirOf[i] < 0) remove.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  for (const c of addTail) add.push(c);
  return { add, remove };
}

/** v14 以前的 deltaOf（所有 src 格子都當種子、每次配新陣列）：只給測試對照與 fallback 用，結果和 deltaOf 逐格、逐順序相同。 */
export function deltaOfRef(before: Uint8Array, after: Uint8Array, u0: number, v0: number, W: number, H: number): { add: Cell[]; remove: Cell[] } {
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
  const rems = bfs((i) => !before[i], (i) => !!before[i] && !after[i]);
  const flip = [1, 0, 3, 2];
  const remove: Cell[] = rems.order.map((i) => ({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: flip[rems.dirOf[i]] }));
  for (let i = 0; i < W * H; i++)
    if (before[i] && !after[i] && rems.dirOf[i] < 0) remove.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  for (let i = 0; i < W * H; i++)
    if (after[i] && !before[i] && adds.dirOf[i] < 0) add.push({ u: (i % W) + u0, v: Math.floor(i / W) + v0, dir: 3 });
  return { add, remove };
}
