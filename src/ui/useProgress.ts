import { useSyncExternalStore } from 'react';
import { type ProgressState, progressSnapshot, subscribeProgress } from '../volume/progress';

/** Worker 長請求的進度（apply／chunks／layer）；沒有在跑的類型就沒有鍵。 */
export function useProgress(): Record<string, ProgressState> {
  return useSyncExternalStore(subscribeProgress, progressSnapshot, progressSnapshot);
}

/** 進度文字＋百分比（null＝沒有在跑）。 */
export function progressWords(p: Record<string, ProgressState>): { text: string; percent: number | null; phase: ProgressState['phase'] } | null {
  const a = p.apply;
  const c = p.chunks;
  const l = p.layer;
  if (a) {
    if (a.phase === 'compute') return { text: '計算這一步…', percent: null, phase: 'compute' };
    return { text: '寫回結果、重新標結構…', percent: 60, phase: 'commit' };
  }
  if (c) return { text: c.total ? `更新 3D 網格 ${c.done}／${c.total} 塊` : '更新 3D 網格…', percent: c.total ? Math.round((c.done / c.total) * 100) : null, phase: 'chunks' };
  if (l) return { text: l.total ? `更新選取層 ${l.done}／${l.total} 塊` : '更新選取層…', percent: l.total ? Math.round((l.done / l.total) * 100) : null, phase: 'layer' };
  return null;
}
