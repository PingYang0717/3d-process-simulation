// 一步操作的報告（plan v7 §7.4）：總數、哪幾片有被擋（「看這些片」）、被擋的格子（切面上標紅）。
import type { Axis, Volume } from './volume';
import type { Block, Report } from './kernel';
import type { Op } from './ops';
import { axisIndex } from './scope';

export interface SliceReport {
  at: number;
  blocked: number;
}
export interface OpReport {
  axis: Axis;
  total: { filled: number; pushed: number; removed: number; blocked: number; skippedSlices: number; fallbackSlices: number };
  blockedBy: Record<number, number>;
  /** 有被擋的片（沿 scope 的軸），由小到大。 */
  slices: SliceReport[];
  /** 被擋的格子（整個陣列的 index；最多 BLOCKED_CAP 個）。Int32Array：Worker 端摘要後 transfer 回來（plan v15 C7）。 */
  cells: Int32Array;
  skipped: number[];
  /** 'adjacent'（plan v17）：實際做了幾格、沒做滿時被誰擋。 */
  done?: number;
  stop?: Block | null;
  /** 'adjacent'：每種鄰居怎麼了（材質編號），與這一步改了幾個體素（Worker 隨 apply 一起回，O(補丁)）。 */
  effects?: Effects;
  changed?: number;
  /** 'adjacent' 內縮：完全鎖定、沒有補回來而留空的材質。 */
  gaps?: number[];
}

/** 這一步之後鄰居怎麼了：跟著移動、變薄、變厚、一側變薄另一側變厚（plan v17 §5.5）。 */
export interface Effects {
  follow: number[];
  lost: number[];
  gained: number[];
  both: number[];
}

/**
 * 由補丁算鄰居的變化（plan v17 §5.5、v21）：補丁範圍內每種材質（選取的材質、空的不算）少了幾格、多了幾格。
 * 有少也有多＝跟著移動（位置換了）；只有少＝變薄（被壓薄的固定結構）；只有多＝變厚（補回來的固定結構）。
 */
export function stepEffects(before: Uint8Array, after: Uint8Array, self: Set<number>): { effects: Effects; changed: number } {
  const lost = new Float64Array(256);
  const gained = new Float64Array(256);
  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    const b = before[i];
    const a = after[i];
    if (a === b) continue;
    changed++;
    lost[b]++;
    gained[a]++;
  }
  const effects: Effects = { follow: [], lost: [], gained: [], both: [] };
  for (let m = 1; m < 256; m++) {
    if (m === 254 || self.has(m) || (!lost[m] && !gained[m])) continue;
    (lost[m] && gained[m] ? effects.follow : lost[m] ? effects.lost : effects.gained).push(m);
  }
  return { effects, changed };
}
/** 回主執行緒的被擋格子上限（切面標紅用；slices 的每片被擋數在截斷前算完，所以「看這些片」仍然完整）。 */
export const BLOCKED_CAP = 50_000;

/** Report → OpReport：在 Worker 端做（apply／applyParked），主執行緒只拿摘要，不 clone 整個 blockedAt。 */
export function summarize(r: Report, op: Op, dims: Pick<Volume, 'X' | 'Y'>): OpReport {
  const axis = op.scope.axis;
  const a = axisIndex(axis);
  const per = new Map<number, number>();
  for (const i of r.blockedAt) {
    const x = i % dims.X;
    const y = ((i - x) / dims.X) % dims.Y;
    const z = (i - x - y * dims.X) / (dims.X * dims.Y);
    const t = [x, y, z][a];
    per.set(t, (per.get(t) ?? 0) + 1);
  }
  return {
    axis,
    total: { filled: r.filled, pushed: r.pushed, removed: r.removed, blocked: r.blocked, skippedSlices: r.skipped.length, fallbackSlices: new Set(r.fallback).size },
    blockedBy: r.blockedBy,
    slices: [...per.entries()].sort((p, q) => p[0] - q[0]).map(([at, blocked]) => ({ at, blocked })),
    cells: Int32Array.from(r.blockedAt.length > BLOCKED_CAP ? r.blockedAt.slice(0, BLOCKED_CAP) : r.blockedAt),
    skipped: [...r.skipped].sort((p, q) => p - q),
    ...(r.done !== undefined ? { done: r.done, stop: r.stop ?? null } : {}),
    ...(r.gaps?.length ? { gaps: r.gaps } : {}),
  };
}
