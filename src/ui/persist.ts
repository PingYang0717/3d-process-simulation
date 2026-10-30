import { useEffect, useState } from 'react';

const PREFIX = 'se3d.v1.';

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
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* 寫不進去就算了 */
    }
  }, [key, value]);
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
