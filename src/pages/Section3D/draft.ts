// 實驗頁設計區的草稿（plan v14 §5.4）：不存 localStorage（重新整理＝空的）；放在模組的記憶體裡，
// 切到編輯頁再回來（DesignPanel 會卸載）還在。選取換成和草稿變數完全無關的結構時清空。
import { type Design, type Factor, DEFAULT_NAME_TEMPLATE } from '../../volume/factors';

/** 草稿：變數＋每個變數的水平（unit；mode 決定絕對或相對）＋組合設定。 */
export interface Draft {
  factors: Factor[];
  levels: Record<string, number[]>;
  combine: Design['combine'];
  from: Design['from'];
  nameTemplate: string;
  picks: string[];
}
export const EMPTY_DRAFT: Draft = { factors: [], levels: {}, combine: 'full', from: 'base', nameTemplate: DEFAULT_NAME_TEMPLATE, picks: [] };

/**
 * 選取變了之後的草稿：沒選東西（只是點了空白）或草稿沒有變數＝不動；選取和任何一個變數的結構有交集＝不動；
 * 否則清掉變數、水平、手動勾選（組合方式、從哪裡開始、命名樣板留著）。
 */
export function nextDraft(prev: Draft, sel: Iterable<string>): Draft {
  const s = new Set(sel);
  if (!s.size || !prev.factors.length) return prev;
  if (prev.factors.some((f) => f.keys.some((k) => s.has(k)))) return prev;
  return { ...prev, factors: [], levels: {}, picks: [] };
}

/** 頁面這一次載入的草稿（模組變數：重新整理就沒了）。 */
let memo: Draft = EMPTY_DRAFT;
export const loadDraft = () => memo;
export const saveDraft = (d: Draft) => {
  memo = d;
};

// v12～v13 存在 localStorage 的舊草稿：不再讀，順手清掉
try {
  localStorage.removeItem('se3d.v1.designDraft2');
} catch {
  /* 沒有 localStorage（測試、隱私模式） */
}
