import { type ComponentType, type ReactElement, createElement, memo, useLayoutEffect, useRef } from 'react';
import type { Editor } from '../pages/Section3D/editor';

/**
 * 吃 `ed` 的重元件只在自己用到的欄位變了才 render（plan v15 B2）。
 *
 * - `uses`：這個元件（含它底下沒有自己 memo 的子元件）render 期間會讀的 `ed` 欄位；逐一 `Object.is`，其他 props 淺比較。
 * - 傳進元件的 `ed` 是一個「永遠讀最新 Editor」的 Proxy（身分不變）：事件 handler／effect 裡讀到的永遠是最新值，
 *   所以只有「render 用到」的欄位才需要列在 `uses`；呼叫 `ed.xxx()` 的 handler 不必列（函式欄位已是 useEvent，身分不變）。
 * - DEV：render 期間（render 開始到這個元件的 layout effect）讀到 `uses` 以外的欄位就 `console.error`，e2e 把它當失敗，
 *   `uses` 才不會悄悄過期；同一個欄位每個實例只報一次。
 * - DEV：`window.__rendersBy[元件名]` 計 commit 次數（perf.cjs 讀；在 layout effect 裡數，StrictMode 的 render 雙跑不算）。
 */
export type EdKey = keyof Editor;

interface Holder {
  ed: Editor;
  /** 這個元件的 render 期間（含子元件的 render 與 layout effect）。 */
  rendering: boolean;
  name: string;
  uses: ReadonlySet<string>;
  warned: Set<string>;
}

const DEV = import.meta.env.DEV;

/** DEV：每個元件 commit 幾次（perf.cjs、e2e 讀 window.__rendersBy；呼叫端放在 useLayoutEffect 裡才不會被 StrictMode 的雙 render 算兩次）。 */
export function countRender(name: string) {
  if (!DEV || typeof window === 'undefined') return;
  const w = window as unknown as { __rendersBy?: Record<string, number> };
  const by = (w.__rendersBy ??= {});
  by[name] = (by[name] ?? 0) + 1;
}

/** 永遠讀 holder.ed 的 Proxy；DEV 下 render 期間讀到 uses 以外的欄位就報。 */
export function liveEd(holder: Holder): Editor {
  const warn = (k: PropertyKey) => {
    if (!DEV || !holder.rendering || typeof k !== 'string' || holder.uses.has(k) || holder.warned.has(k)) return;
    holder.warned.add(k);
    console.error(`memoEd：${holder.name} 讀了 ed.${k} 但沒列在 uses`);
  };
  return new Proxy({} as Editor, {
    get: (_, k) => {
      warn(k);
      return holder.ed[k as EdKey];
    },
    has: (_, k) => k in holder.ed,
    ownKeys: () => Reflect.ownKeys(holder.ed),
    getOwnPropertyDescriptor: (_, k) => {
      const d = Reflect.getOwnPropertyDescriptor(holder.ed, k);
      return d ? { ...d, configurable: true } : undefined;
    },
    set: () => false,
  });
}

type Inner<P> = P & { __vals: readonly unknown[]; __holder: Holder };

/** 比較：uses 的值逐一 Object.is，其他 props 淺比較（ed 是穩定的 Proxy，本來就相等）。 */
export function sameEdProps<P extends object>(prev: Inner<P>, next: Inner<P>): boolean {
  const a = prev.__vals;
  const b = next.__vals;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  const pk = Object.keys(prev);
  const nk = Object.keys(next);
  if (pk.length !== nk.length) return false;
  for (const k of nk) if (k !== '__vals' && !Object.is((prev as Record<string, unknown>)[k], (next as Record<string, unknown>)[k])) return false;
  return true;
}

export function memoEd<P extends { ed: Editor }>(Component: ComponentType<P>, uses: readonly EdKey[], name = Component.displayName ?? Component.name ?? 'memoEd'): (props: P) => ReactElement {
  const usesSet = new Set<string>(uses);
  const Memo = memo(function MemoEdInner(props: Inner<P>) {
    const { __vals: _v, __holder: h, ...rest } = props;
    void _v;
    if (DEV) h.rendering = true;
    // 子元件 render 完、layout effect 跑完才算離開 render 期間（passive effect 與事件 handler 讀最新值，不算）
    useLayoutEffect(() => {
      h.rendering = false;
      countRender(name);
    });
    return createElement(Component, rest as unknown as P);
  }, sameEdProps);
  Memo.displayName = `memoEd(${name})`;
  const Outer = (props: P) => {
    const ref = useRef<{ holder: Holder; live: Editor } | null>(null);
    if (!ref.current) {
      const holder: Holder = { ed: props.ed, rendering: false, name, uses: usesSet, warned: new Set() };
      ref.current = { holder, live: liveEd(holder) };
    }
    const { holder, live } = ref.current;
    holder.ed = props.ed;
    const vals = uses.map((k) => props.ed[k]);
    return createElement(Memo, { ...props, ed: live, __vals: vals, __holder: holder } as Inner<P>);
  };
  Outer.displayName = name;
  return Outer;
}
