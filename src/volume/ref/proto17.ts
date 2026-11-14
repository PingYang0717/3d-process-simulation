// plan v17 的相鄰材質規則：prototype（docs/proto-v17-simple-version.html）的逐格寫法，照搬成對照實作；
// 推拉的「旁邊的薄層排也跟著」（pushRows）照 docs/proto-v19-shell-follow-collapse.html。
// 和 prototype 唯一的不同：結構身分用 mask（每個選到的結構一份）、薄層與「碰到自己」以材質判斷（plan §11、D6）。
// volume.ts 的 adjacentMasks 是逐排、可以在裁切範圍裡算的版本；kernel17.test.ts 逐體素比對兩者。
import type { Vec3, Volume } from '../volume';

const AIR = 0;
const VOID = 254;
const empty = (m: number) => m === AIR || m === VOID;

export interface RefBlock {
  why: 'edge' | 'self' | 'last' | 'min';
  mat?: number;
}

export function refAdjacent(vol: Volume, masks: Uint8Array[], kind: 'push' | 'translate', dir: Vec3, n: number, follow: boolean, liners: number[]) {
  const { X, Y, Z } = vol;
  const N = X * Y * Z;
  const DIM = [X, Y, Z];
  const STEP = [1, X, X * Y];
  const liner = new Set(liners);
  const coord = (i: number) => {
    const x = i % X;
    const y = ((i - x) / X) % Y;
    return [x, y, (i - x - y * X) / (X * Y)];
  };
  const next = (i: number, a: number, s: number) => {
    const c = coord(i)[a] + s;
    return c < 0 || c >= DIM[a] ? -1 : i + s * STEP[a];
  };
  type St = { mat: Uint8Array; own: Uint8Array[] };
  const lin = (st: St, i: number, a: number, s: number, self: number) => {
    const out: number[] = [];
    while (i >= 0) {
      const m = st.mat[i];
      if (empty(m) || m === self || !liner.has(m)) break;
      out.push(i);
      i = next(i, a, s);
    }
    return out;
  };
  const outer = (own: Uint8Array, a: number, s: number) => {
    const res: number[] = [];
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const p = [0, 0, 0];
    for (p[b] = 0; p[b] < DIM[b]; p[b]++)
      for (p[c] = 0; p[c] < DIM[c]; p[c]++)
        for (let k = 0; k < DIM[a]; k++) {
          p[a] = s > 0 ? DIM[a] - 1 - k : k;
          const i = (p[2] * Y + p[1]) * X + p[0];
          if (own[i]) {
            res.push(i);
            break;
          }
        }
    return res;
  };
  let lastBlock: RefBlock | null = null;
  const canTake = (st: St, b: number, a: number, s: number, self: number): RefBlock | null => {
    if (b < 0) return { why: 'edge' };
    const m = st.mat[b];
    if (empty(m)) return null;
    if (m === self) return { why: 'self', mat: m };
    const b2 = next(b, a, s);
    return b2 >= 0 && st.mat[b2] === m ? null : { why: 'last', mat: m };
  };
  /**
   * 這一步要動的每一排的切口（plan v19 §3.1）：結構每一排最外側那一格；跟著移動時再從切口往旁邊（同一層）
   * 找相連的薄層，那一排也在同一層切開。由外往內一層一層 flood（一排可以從好幾層走到時取最外側）。
   */
  const pushRows = (st: St, k: number, self: number, a: number, s: number) => {
    const cuts = outer(st.own[k], a, s);
    if (!follow) return cuts;
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const rowKey = (i: number) => coord(i)[b] * 65536 + coord(i)[c];
    const seeds = cuts.slice().sort((p, q) => s * (coord(q)[a] - coord(p)[a]));
    const seen = new Set(cuts.map(rowKey));
    for (const seed of seeds) {
      const stack = [seed];
      while (stack.length) {
        const i = stack.pop()!;
        for (const [la, ls] of [[b, 1], [b, -1], [c, 1], [c, -1]]) {
          const nb = next(i, la, ls);
          if (nb < 0 || seen.has(rowKey(nb))) continue;
          const m = st.mat[nb];
          if (empty(m) || m === self || !liner.has(m)) continue;
          seen.add(rowKey(nb));
          cuts.push(nb);
          stack.push(nb);
        }
      }
    }
    return cuts;
  };
  const grow1 = (st: St, k: number, self: number, a: number, s: number) => {
    const plan: [number, number, number[]][] = [];
    for (const c of pushRows(st, k, self, a, s)) {
      const t = next(c, a, s);
      const L = follow && t >= 0 ? lin(st, t, a, s, self) : [];
      const block = canTake(st, L.length ? next(L[L.length - 1], a, s) : t, a, s, self);
      if (block) {
        lastBlock = block;
        return false;
      }
      plan.push([c, t, L]);
    }
    for (const [c, t, L] of plan) {
      for (let j = L.length - 1; j >= 0; j--) st.mat[next(L[j], a, s)] = st.mat[L[j]];
      st.mat[t] = st.mat[c];
      if (st.own[k][c]) st.own[k][t] = 1;
    }
    return true;
  };
  const shrink1 = (st: St, k: number, self: number, a: number, s: number) => {
    let lo = Infinity;
    let hi = -1;
    for (let i = 0; i < N; i++)
      if (st.own[k][i]) {
        const c = coord(i)[a];
        lo = Math.min(lo, c);
        hi = Math.max(hi, c);
      }
    if (hi < 0 || hi - lo < 1) {
      lastBlock = { why: 'min' };
      return false;
    }
    for (const c of pushRows(st, k, self, a, s)) {
      const o = next(c, a, s);
      const L = follow && o >= 0 ? lin(st, o, a, s, self) : [];
      let to = c;
      for (const j of L) {
        st.mat[to] = st.mat[j];
        to = j;
      }
      const beyond = next(to, a, s);
      if (beyond >= 0) st.mat[to] = st.mat[beyond];
      else if (!L.length) st.mat[to] = AIR;
      st.own[k][c] = 0;
    }
    return true;
  };
  const move1 = (st: St, k: number, self: number, a: number, s: number) => {
    const mask = new Uint8Array(N);
    const queue: number[] = [];
    for (let i = 0; i < N; i++)
      if (st.own[k][i]) {
        mask[i] = 1;
        queue.push(i);
      }
    if (follow)
      while (queue.length) {
        const i = queue.pop()!;
        for (let b = 0; b < 3; b++)
          for (const sg of [1, -1]) {
            const nb = next(i, b, sg);
            if (nb < 0 || mask[nb]) continue;
            const m = st.mat[nb];
            if (liner.has(m) && !empty(m) && m !== self) {
              mask[nb] = 2;
              queue.push(nb);
            }
          }
      }
    const cells: number[] = [];
    for (let i = 0; i < N; i++) {
      if (!mask[i]) continue;
      const t = next(i, a, s);
      if (t < 0 || !mask[t]) {
        const block = canTake(st, t, a, s, self);
        if (block) {
          lastBlock = block;
          return false;
        }
      }
      cells.push(i);
    }
    const mats = cells.map((i) => st.mat[i]);
    const fills = cells.map((i) => {
      let j = i;
      do j = next(j, a, -s);
      while (j >= 0 && mask[j]);
      return j >= 0 ? st.mat[j] : AIR;
    });
    cells.forEach((i, q) => (st.mat[i] = fills[q]));
    const own = new Uint8Array(N);
    cells.forEach((i, q) => {
      const t = next(i, a, s);
      st.mat[t] = mats[q];
      if (st.own[k][i]) own[t] = 1;
    });
    st.own[k] = own;
    return true;
  };
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const s = Math.sign(dir[a]);
  let st: St = { mat: vol.data.slice(), own: masks.filter((m) => m.some((x) => x)).map((m) => m.slice()) };
  const selfs = st.own.map((m) => st.mat[m.indexOf(1)]);
  let done = 0;
  for (; done < Math.abs(n); done++) {
    const t: St = { mat: st.mat.slice(), own: st.own.map((m) => m.slice()) };
    const ok = t.own.every((_, k) => (kind === 'translate' ? move1(t, k, selfs[k], a, s) : n > 0 ? grow1(t, k, selfs[k], a, s) : shrink1(t, k, selfs[k], a, s)));
    if (!ok) break;
    st = t;
  }
  return { data: st.mat, done, stop: done < Math.abs(n) ? lastBlock : null };
}
