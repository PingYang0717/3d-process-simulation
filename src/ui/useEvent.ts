import { useCallback, useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...a: any[]) => any;

/**
 * 身分永遠相同、呼叫時用最新那一次 render 的 fn（plan v15 B2）。
 * 給「回傳給 UI 的事件 handler」用：子元件可以 memo、listener 可以只掛一次，不必每 render 換 closure。
 * 不要拿它當 useEffect／useMemo 的 deps 期待它觸發——它永遠不變；要跟著輸入重算的（op factory、matName）維持 useCallback／useMemo。
 */
export function useEvent<T extends AnyFn>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...a: Parameters<T>) => ref.current(...a)) as T, []);
}
