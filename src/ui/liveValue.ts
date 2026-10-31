// 會一直變、只有一兩個小元件要看的值（滑鼠所在的格子、hover 說明）：放在 ref 裡、訂閱者自己 render，
// 不經過整頁的 state（plan v9 P7：滑鼠在主切面上移動時 Section3DPage 不重 render）。
import { useRef, useSyncExternalStore } from 'react';

export interface LiveValue<T> {
  get: () => T;
  /** 值沒變（eq）就不通知。 */
  set: (v: T) => void;
  subscribe: (fn: () => void) => () => void;
}

export function createLiveValue<T>(init: T, eq: (a: T, b: T) => boolean = Object.is): LiveValue<T> {
  let cur = init;
  const subs = new Set<() => void>();
  return {
    get: () => cur,
    set: (v) => {
      if (eq(cur, v)) return;
      cur = v;
      subs.forEach((f) => f());
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** 元件一輩子同一個 LiveValue。 */
export function useLiveValue<T>(init: T, eq?: (a: T, b: T) => boolean): LiveValue<T> {
  const r = useRef<LiveValue<T> | null>(null);
  if (!r.current) r.current = createLiveValue(init, eq);
  return r.current;
}

/** 訂閱：值變了只有呼叫這個 hook 的元件重 render。 */
export function useLive<T>(lv: LiveValue<T>): T {
  return useSyncExternalStore(lv.subscribe, lv.get, lv.get);
}
