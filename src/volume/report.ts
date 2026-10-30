// 一步操作的報告（plan v7 §7.4）：總數、哪幾片有被擋（「看這些片」）、被擋的格子（切面上標紅）。
import type { Axis, Volume } from './volume';
import type { Report } from './kernel';
import { type LegacyOp, type Op, upgradeOp } from './ops';
import { axisIndex } from './scope';

export interface SliceReport {
  at: number;
  blocked: number;
}
export interface OpReport {
  axis: Axis;
  total: { filled: number; pushed: number; removed: number; blocked: number; skippedSlices: number };
  blockedBy: Record<number, number>;
  /** 有被擋的片（沿 scope 的軸），由小到大。 */
  slices: SliceReport[];
  /** 被擋的格子（整個陣列的 index；最多 BLOCKED_CAP 個）。 */
  cells: number[];
  skipped: number[];
}
const BLOCKED_CAP = 50_000;

export function summarize(r: Report, input: Op | LegacyOp, dims: Pick<Volume, 'X' | 'Y'>): OpReport {
  const op = upgradeOp(input);
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
    total: { filled: r.filled, pushed: r.pushed, removed: r.removed, blocked: r.blocked, skippedSlices: r.skipped.length },
    blockedBy: r.blockedBy,
    slices: [...per.entries()].sort((p, q) => p[0] - q[0]).map(([at, blocked]) => ({ at, blocked })),
    cells: r.blockedAt.slice(0, BLOCKED_CAP),
    skipped: [...r.skipped].sort((p, q) => p - q),
  };
}

/** 「4 片有 12 格被 Poly-Si 擋住」。 */
export function blockedPhrase(r: OpReport, matName: (id: number) => string) {
  if (!r.total.blocked) return '';
  const by = Object.entries(r.blockedBy)
    .sort((p, q) => q[1] - p[1])
    .map(([m]) => matName(+m))
    .slice(0, 2)
    .join('、');
  return `${r.slices.length} 片有 ${r.total.blocked.toLocaleString()} 格被 ${by} 擋住`;
}
