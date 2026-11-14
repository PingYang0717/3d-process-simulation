// 試算（plan v17 §5.5、v21）：面板在動手之前要知道的事——這一步會帶動誰、會推到哪個固定的結構、這個方向最多還能做幾格與被誰擋。
// 不寫回帳簿。實際在裁切範圍裡算一次（和正式套用同一段程式）。純函式：Worker 的 probe 請求與測試共用。
import { type LockSpec, type Vec3, type Volume, AIR, VOID, lockTable, pushCutCells } from './volume';
import type { Block } from './kernel';
import type { AdjPushOp, AdjTranslateOp, EditState } from './ops';
import { cropLock, cropMask, cropVolume, previewBoxTrial } from './preview';
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
  /** 固定的結構。 */
  locks?: LockSpec[];
  /** 舊版欄位，不再影響結果。 */
  follow?: boolean;
  liners?: number[];
}

export interface Probe {
  /** push：這一步會跟著移動的結構（key）。 */
  follow: string[];
  /** push：這一步會推到的固定結構（key）：可被壓薄的會變薄，完全鎖定的會擋住。 */
  hit: string[];
  /** push：外推最多幾格；內縮＝縮到還不會有選到的結構整個消失為止。 */
  out?: Room;
  in?: Room;
  /** push：內縮滿這麼多格，選到的結構（其中一個）會整個消失。 */
  vanishAt?: number;
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

/** 選到的每個結構內縮幾格會整個消失（每一排一步拿掉一格：最厚的那一排有幾格）。取最小的。 */
function vanishSteps(s: EditState, keys: string[], a: number): number {
  const { X, Y } = s.vol;
  const st = strideOf(s.vol, a);
  let min = Infinity;
  for (const key of keys) {
    const ci = s.L.comps.findIndex((c) => c.key === key);
    if (ci < 0) continue;
    const cb = s.L.comps[ci].bbox;
    const cl = [cb.x0, cb.y0, cb.z0];
    const ch = [cb.x1, cb.y1, cb.z1];
    const [u, v] = [0, 1, 2].filter((k) => k !== a);
    const p = [0, 0, 0];
    let max = 0;
    for (p[u] = cl[u]; p[u] <= ch[u]; p[u]++)
      for (p[v] = cl[v]; p[v] <= ch[v]; p[v]++) {
        p[a] = cl[a];
        const base = (p[2] * Y + p[1]) * X + p[0];
        let n = 0;
        for (let t = 0; t <= ch[a] - cl[a]; t++) if (s.L.labels[base + t * st] === ci) n++;
        if (n > max) max = n;
      }
    if (max && max < min) min = max;
  }
  return min;
}

const roomOf = (s: EditState, box: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }, done: number, stop: Block | null | undefined, max: number): Room => ({
  n: done,
  stop: stop && stop.at !== undefined ? { ...stop, at: globalIndex(box, s.vol, [stop.at])[0] } : (stop ?? null),
  ...(done >= max ? { more: true } : {}),
});

/**
 * 推拉一面（plan v21 §3）：外推最多幾格＝實際在裁切範圍裡算 PROBE_MAX 格；內縮＝縮到還不會有結構消失為止；
 * 這一步會帶動誰＝第一格會動的每一排往外一路走，沒固定的結構＝跟著移動，盡頭是固定的結構（中間沒有空氣可以吸收）＝會被推到。
 */
function probePush(s: EditState, req: ProbeReq & { dir: Vec3 }): Probe {
  const dir = req.dir;
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const sg = dir[a] > 0 ? 1 : -1;
  const st = strideOf(s.vol, a);
  const len = lenOf(s.vol, a);
  const keys = [...new Set(req.keys)];
  const follow = new Set<number>();
  const hit = new Set<number>();
  let out: Room = { n: 0, stop: null };
  const trialOp: AdjPushOp = { kind: 'push', keys, scope: fullScope(s.vol), dir, n: PROBE_MAX, follow: true, backfill: 'outer', policy: 'adjacent', locks: req.locks };
  const { box, trial } = previewBoxTrial(s, trialOp);
  if (box && trial) {
    out = roomOf(s, box, trial.report.done ?? 0, trial.report.stop, PROBE_MAX);
    const table = lockTable(s.L, req.locks);
    const vol = cropVolume(s.vol, box);
    const lock = cropLock(s.L, table, s.vol, box);
    const { X, Y } = s.vol;
    const cOf = (i: number) => (a === 0 ? i % X : a === 1 ? ((i - (i % X)) / X) % Y : Math.floor(i / (X * Y)));
    for (const key of keys) {
      const self = s.L.comps.findIndex((c) => c.key === key);
      const mask = cropMask(s.L, new Set([key]), s.vol, box);
      for (const g of globalIndex(box, s.vol, pushCutCells(vol, mask, dir, lock))) {
        if (s.L.labels[g] !== self && s.L.labels[g] >= 0) follow.add(s.L.labels[g]);
        let air = false;
        let j = g + sg * st;
        for (let c = cOf(g) + sg; c >= 0 && c < len; c += sg, j += sg * st) {
          const l = s.L.labels[j];
          if (l === self) break;
          if (l >= 0 && table[l]) {
            if (!air) hit.add(l);
            break;
          }
          if (empty(s.vol.data[j])) air = true;
          else if (l >= 0) follow.add(l);
        }
      }
    }
  }
  const v = vanishSteps(s, keys, a);
  const keyOf = (set: Set<number>) => [...set].sort((p, q) => p - q).map((l) => s.L.comps[l].key);
  return { follow: keyOf(follow), hit: keyOf(hit), out, in: { n: v === Infinity ? 0 : v - 1, stop: { why: 'min' } }, ...(v === Infinity ? {} : { vanishAt: v }) };
}

/** 整塊平移：六個方向各實際算 PROBE_MOVE_MAX 格，看最多能搬幾格、被誰擋。 */
function probeMove(s: EditState, req: ProbeReq): Probe {
  const keys = [...new Set(req.keys)];
  const dirs = PROBE_DIRS.map((d): Room => {
    const op: AdjTranslateOp = { kind: 'translate', keys, scope: fullScope(s.vol), d: d.map((v) => v * PROBE_MOVE_MAX) as Vec3, backfill: 'outer', follow: true, policy: 'adjacent', locks: req.locks };
    const { box, trial } = previewBoxTrial(s, op);
    if (!box || !trial) return { n: 0, stop: null };
    return roomOf(s, box, trial.report.done ?? 0, trial.report.stop, PROBE_MOVE_MAX);
  });
  return { follow: [], hit: [], dirs };
}

export function probe(s: EditState, req: ProbeReq): Probe {
  if (req.kind === 'push') return probePush(s, { ...req, dir: req.dir ?? [0, -1, 0] });
  return probeMove(s, req);
}
