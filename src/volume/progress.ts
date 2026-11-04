// Worker 長請求的進度（plan v16）：client.ts 收到 { progress } 訊息就放進來，畫面用 useProgress 讀。
// 純模組、不碰 React（hook 在 ui/useProgress.ts）。
export interface ProgressState {
  type: string;
  phase: 'compute' | 'commit' | 'chunks' | 'layer';
  done: number;
  total: number;
  at: number;
}

const current = new Map<string, ProgressState>();
const listeners = new Set<() => void>();
let snapshot: Record<string, ProgressState> = {};

const emit = () => {
  snapshot = Object.fromEntries(current);
  for (const l of listeners) l();
};

/** 某一類請求（apply／chunks／layer）的最新進度；null＝結束。 */
export function setProgress(type: string, p: Omit<ProgressState, 'type' | 'at'> | null) {
  if (p) current.set(type, { type, at: Date.now(), ...p });
  else if (!current.delete(type)) return;
  emit();
}

export function subscribeProgress(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** 目前所有類型的進度（同一個物件直到下一次變動；給 useSyncExternalStore）。 */
export const progressSnapshot = () => snapshot;
