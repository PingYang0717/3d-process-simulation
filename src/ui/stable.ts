import { useRef } from 'react';

/**
 * 值相同就回上一個物件（plan v15 B1）：給 useMemo 算出來的小物件（scope、selBBox、gesture）用，
 * 下游的 effect／memo 以身分比較時才不會因為「每次都是新物件」白跑。
 * same(prev, next) 回 true ＝沿用 prev。
 */
export function useStable<T>(value: T, same: (a: T, b: T) => boolean): T {
  const ref = useRef(value);
  if (ref.current !== value && !same(ref.current, value)) ref.current = value;
  return ref.current;
}
