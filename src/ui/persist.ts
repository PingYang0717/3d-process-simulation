import { useEffect, useState } from 'react';

const PREFIX = 'se3d.v1.';

/**
 * 寫入合併到瀏覽器空閒時（plan v14 P6）：每次 state 變動只記下最新的值，JSON.stringify＋setItem 在 idle 時一次做；
 * 卸載、離開頁面時立刻寫。
 */
const pending = new Map<string, unknown>();
let scheduled = false;
export function flushPersisted() {
  scheduled = false;
  for (const [k, v] of pending)
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 寫不進去就算了 */
    }
  pending.clear();
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(flushPersisted, { timeout: 500 });
  else setTimeout(flushPersisted, 0);
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPersisted);

/** 像 useState，但值會寫進 localStorage（欄寬、筆刷、顯示設定）；讀不到或格式不對就用預設。 */
export function usePersisted<T>(key: string, initial: T, valid: (v: unknown) => v is T = isSameShape(initial)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw);
        if (valid(parsed)) return parsed;
      }
    } catch {
      /* 無痕模式或被擋：當作沒存過 */
    }
    return initial;
  });
  useEffect(() => {
    pending.set(PREFIX + key, value);
    schedule();
  }, [key, value]);
  useEffect(() => () => flushPersisted(), []);
  return [value, setValue] as const;
}

/** 預設的驗證：型別一樣（物件則每個 key 的型別一樣）。 */
function isSameShape<T>(sample: T) {
  return (v: unknown): v is T => {
    if (sample === null || typeof sample !== 'object') return typeof v === typeof sample;
    if (v === null || typeof v !== 'object' || Array.isArray(v) !== Array.isArray(sample)) return false;
    if (Array.isArray(sample)) return true;
    return Object.keys(sample as object).every((k) => typeof (v as Record<string, unknown>)[k] === typeof (sample as Record<string, unknown>)[k]);
  };
}

/** 有 Modal 或 Drawer 開著：單鍵快捷鍵（B、D、1～4…）先不要動 3D。 */
export const overlayOpen = () =>
  !!document.querySelector('.ant-drawer-open, .ant-modal-wrap:not([style*="display: none"])');

/** 鍵盤事件來自打字的地方（文字輸入框、下拉、可編輯區）：單鍵快捷鍵不要搶。單選鈕、勾選框不算。 */
export const typingIn = (t: EventTarget | null) => {
  const el = (t as HTMLElement | null)?.closest?.('input,select,textarea,[contenteditable]') as HTMLInputElement | null;
  if (!el) return false;
  return !(el.tagName === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox'));
};
