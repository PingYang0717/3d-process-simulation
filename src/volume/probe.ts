// 試算（plan v17 §5.4.4、§5.5）：面板在動手之前要知道的三件事——誰會跟著、誰的厚度會變、這個方向最多還能做幾格與被誰擋。
// 不寫回帳簿。推拉：對受影響的每一排做一維模擬（simGrowRow）；內縮看結構沿那一軸的厚度；平移沿每個前緣掃原始陣列。
// 純函式：Worker 的 probe 請求與測試共用。
import { type Vec3, type Volume, AIR, VOID } from './volume';
import { type Block, linerLUT, shellFlood, simGrowRow } from './kernel';
import type { EditState } from './ops';
import { ADJ_WINDOW, cropMask, cropVolume, previewBox } from './preview';
import { fullScope } from './scope';
import { globalIndex } from './patch';

/** 一個方向最多能做幾格；more＝試到上限還做得到（實際可能更多）。 */
export interface Room {
  n: number;
  stop: Block | null;
  more?: boolean;
}

export interface ProbeReq {
  keys: string[];
  kind: 'push' | 'translate';
  /** push：哪一面（法線）。translate 不看（六個方向一次算）。 */
  dir?: Vec3;
  follow: boolean;
  liners: number[];
}

export interface Probe {
  /** 會跟著移動的材質（跟著移動開著才有）。 */
  follow: number[];
  /** 厚度會變的材質。 */
  thin: number[];
  /** 有沒有薄層貼著（跟著移動有沒有意義；和這一次的 follow 無關）。 */
  canFollow: boolean;
  /** push：外推、內縮各最多幾格。 */
  out?: Room;
  in?: Room;
  /** translate：六個方向（PROBE_DIRS 的順序）各最多幾格。 */
  dirs?: Room[];
}

/** 六個方向：上、下、左、右、前、後（和面板、鍵盤的順序一致）。 */
export const PROBE_DIRS: Vec3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** 試算的上限：外推最多模擬這麼多格；平移最多看這麼多格。 */
export const PROBE_MAX = 60;
export const PROBE_MOVE_MAX = 20;

const empty = (m: number) => m === AIR || m === VOID;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/**
 * 一個結構在 (a, sg) 方向每一排最外側那一格：fn(base, c)，base＝那一格的 index，c＝沿 a 的座標。
 * 只掃結構外框（O(外框)）。
 */
export function forEachFace(s: EditState, ci: number, a: number, sg: number, fn: (base: number, c: number) => void) {
  const { X, Y } = s.vol;
  const cb = s.L.comps[ci].bbox;
  const cl = [cb.x0, cb.y0, cb.z0];
  const ch = [cb.x1, cb.y1, cb.z1];
  const [u, v] = [0, 1, 2].filter((k) => k !== a);
  const p = [0, 0, 0];
  for (p[u] = cl[u]; p[u] <= ch[u]; p[u]++)
    for (p[v] = cl[v]; p[v] <= ch[v]; p[v]++) {
      for (let t = sg > 0 ? ch[a] : cl[a]; sg > 0 ? t >= cl[a] : t <= ch[a]; t -= sg) {
        p[a] = t;
        const i = (p[2] * Y + p[1]) * X + p[0];
        if (s.L.labels[i] === ci) {
          fn(i, t);
          break;
        }
      }
    }
}

const strideOf = (v: Volume, a: number) => (a === 0 ? 1 : a === 1 ? v.X : v.X * v.Y);
const lenOf = (v: Volume, a: number) => (a === 0 ? v.X : a === 1 ? v.Y : v.Z);

/** 推拉一面：外推（一維模擬，所有排取最小）、內縮（結構沿這一軸的厚度 − 1）、鄰居。 */
function probePush(s: EditState, req: ProbeReq & { dir: Vec3 }): Probe {
  const dir = req.dir;
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const sg = dir[a] > 0 ? 1 : -1;
  const st = strideOf(s.vol, a);
  const len = lenOf(s.vol, a);
  const liner = linerLUT(req.liners);
  const can = new Set<number>();
  const thin = new Set<number>();
  let out: Room = { n: PROBE_MAX, stop: null, more: true };
  let inn: Room = { n: Infinity, stop: { why: 'min' } };
  const row: number[] = [];
  for (const key of new Set(req.keys)) {
    const ci = s.L.comps.findIndex((c) => c.key === key);
    if (ci < 0) continue;
    const comp = s.L.comps[ci];
    const mat = comp.mat;
    const ext = a === 0 ? comp.bbox.x1 - comp.bbox.x0 : a === 1 ? comp.bbox.y1 - comp.bbox.y0 : comp.bbox.z1 - comp.bbox.z0;
    if (ext < inn.n) inn = { n: ext, stop: { why: 'min' } };
    forEachFace(s, ci, a, sg, (base, c) => {
      row.length = 0;
      for (let k = 1; k <= PROBE_MAX + ADJ_WINDOW; k++) {
        const t = c + k * sg;
        if (t < 0 || t >= len) {
          row.push(-1);
          break;
        }
        row.push(s.vol.data[base + k * sg * st]);
      }
      // 鄰居：跟著的薄層串、串外面那一層（留在原地＝緊貼的那一層）
      let k = 0;
      while (k < row.length && row[k] >= 0 && !empty(row[k]) && row[k] !== mat && liner[row[k]]) can.add(row[k++]);
      if (!req.follow) k = 0;
      const b = row[k];
      if (b !== undefined && b >= 0 && !empty(b) && b !== mat) thin.add(b);
      if (out.n === 0) return;
      const r = simGrowRow(row, out.n, mat, req.follow, liner);
      if (r.done < out.n) {
        // 擋住的那一格：row 的第 k 格＝最外側那一格往外 k + 1 格（推了 done 格之後，那一格的內容是原始的那一格往外 done 格的位置）
        const at = r.stop?.at !== undefined ? base + (r.stop.at + 1) * sg * st : undefined;
        out = { n: r.done, stop: r.stop && { ...r.stop, ...(at !== undefined ? { at } : {}) } };
      }
    });
  }
  if (inn.n === Infinity) inn = { n: 0, stop: { why: 'min' } };
  return { follow: req.follow ? sorted(can) : [], thin: sorted(thin), canFollow: can.size > 0, out, in: inn };
}

/**
 * 整塊平移：鄰居（整圈薄層＝跟著；集合外六鄰接＝厚度會變）與六個方向各最多幾格。
 * 搬的集合是剛體：推了 k 格之後，集合每一個前緣格子前面那一格，就是原始陣列裡往前 k 格的那一格（前面還沒被吃到），
 * 所以每個前緣沿方向掃一次原始陣列就知道第幾格會被擋（O(前緣 × 上限)），不必真的一格一格搬。
 * 同一排前面還有集合的格子（中間夾著別的材質）：那一段會跟著一起往前移，只看第一格。
 */
function probeMove(s: EditState, req: ProbeReq): Probe {
  const liner = linerLUT(req.liners);
  const fol = new Set<number>();
  const thin = new Set<number>();
  const keys = [...new Set(req.keys)];
  const rooms: Room[] = PROBE_DIRS.map(() => ({ n: PROBE_MOVE_MAX, stop: null, more: true }));
  const b0 = previewBox(s, { kind: 'translate', keys, scope: fullScope(s.vol), d: [1, 0, 0], backfill: 'outer', follow: req.follow, policy: 'adjacent', liners: req.liners });
  if (!b0) return { follow: [], thin: [], canFollow: false, dirs: rooms.map(() => ({ n: 0, stop: null })) };
  // 前緣往前最多讀 PROBE_MOVE_MAX＋1 格：外框六面都多留這麼多（夾到模型邊界；夾到的那一面才是真的邊界）
  const m = PROBE_MOVE_MAX + 2;
  const box = {
    x0: Math.max(0, b0.x0 - m), y0: Math.max(0, b0.y0 - m), z0: Math.max(0, b0.z0 - m),
    x1: Math.min(s.vol.X - 1, b0.x1 + m), y1: Math.min(s.vol.Y - 1, b0.y1 + m), z1: Math.min(s.vol.Z - 1, b0.z1 + m),
  };
  const vol = cropVolume(s.vol, box);
  const { X, Y, Z, data } = vol;
  const dims = [X, Y, Z];
  let canFollow = false;
  for (const k of keys) {
    const S = cropMask(s.L, new Set([k]), s.vol, box);
    const first = S.indexOf(1);
    if (first < 0) continue;
    const mat = data[first];
    if (req.follow) shellFlood(vol, S, mat, liner);
    else if (!canFollow) {
      // 跟著移動關著：另外 flood 一次，只為了知道有沒有薄層貼著
      const T = S.slice();
      canFollow = shellFlood(vol, T, mat, liner) > 0;
    }
    for (let i = 0; i < S.length; i++) {
      if (!S[i]) continue;
      if (S[i] === 2) fol.add(data[i]);
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      const c = [x, y, z];
      const nb = [x > 0 ? i - 1 : -1, x < X - 1 ? i + 1 : -1, y > 0 ? i - X : -1, y < Y - 1 ? i + X : -1, z > 0 ? i - X * Y : -1, z < Z - 1 ? i + X * Y : -1];
      for (const j of nb) if (j >= 0 && !S[j] && !empty(data[j]) && data[j] !== mat) thin.add(data[j]);
      PROBE_DIRS.forEach((d, di) => {
        const room = rooms[di];
        if (room.n === 0) return;
        const a = d[0] ? 0 : d[1] ? 1 : 2;
        const sg = d[a];
        const st = a === 0 ? 1 : a === 1 ? X : X * Y;
        const at = (t: number) => i + (t - c[a]) * st;
        const t0 = c[a] + sg;
        if (t0 >= 0 && t0 < dims[a] && S[at(t0)]) return; // 不是前緣
        // 同一排前面還有集合的格子：夾在中間的那一段跟著移，只看第一格
        let ahead = false;
        for (let t = t0 + sg; t >= 0 && t < dims[a]; t += sg)
          if (S[at(t)]) {
            ahead = true;
            break;
          }
        const lim = ahead ? 1 : room.n;
        for (let q = 0; q < lim; q++) {
          const t = t0 + q * sg;
          let stop: Block | null = null;
          if (t < 0 || t >= dims[a]) stop = { why: 'edge' };
          else {
            const mt = data[at(t)];
            if (empty(mt)) continue;
            if (mt === mat) stop = { why: 'self', mat: mt, at: at(t) };
            else {
              const t2 = t + sg;
              if (t2 < 0 || t2 >= dims[a] || data[at(t2)] !== mt) stop = { why: 'last', mat: mt, at: at(t) };
            }
          }
          if (stop) {
            if (q < room.n) rooms[di] = { n: q, stop: stop.at !== undefined ? { ...stop, at: globalIndex(box, s.vol, [stop.at])[0] } : stop };
            return;
          }
        }
      });
    }
  }
  return { follow: sorted(fol), thin: sorted(thin), canFollow: canFollow || fol.size > 0, dirs: rooms };
}

export function probe(s: EditState, req: ProbeReq): Probe {
  if (req.kind === 'push') return probePush(s, { ...req, dir: req.dir ?? [0, -1, 0] });
  return probeMove(s, req);
}
