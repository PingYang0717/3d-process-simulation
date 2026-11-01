// 「沒碰到這一片就不重描」（plan v15 §5.3 A4）：一片的輪廓／階梯／手勢環境只在這一片真的可能變了才重算。
// 每一步 L 的身分都會換（帳簿貼了補丁就換一個新的 cur），但多數步驟只碰到 stepTouch 那個外框；
// 外框和 (axis, at) 這一片不相交，這一片的體素就一個都沒動，用上一次的結果就好。
import { useRef } from 'react';
import type { Axis, BBox, Labeled } from '../../volume/volume';
import { axisIndex } from '../../volume/scope';
import type { LastStep } from './editor';

/** 一次 render 看到的 (L, 最近一步的 seq, 哪一片)。 */
export interface SliceRevKey {
  L: Labeled | undefined;
  seq: number | undefined;
  axis: Axis;
  at: number;
}

/** 外框有沒有碰到 (axis, at) 這一片。 */
export function planeHit(box: BBox | null | undefined, axis: Axis, at: number) {
  if (!box) return false;
  const a = axisIndex(axis);
  return at >= [box.x0, box.y0, box.z0][a] && at <= [box.x1, box.y1, box.z1][a];
}

/**
 * 這一片要不要當成「變了」（純函式，給 hook 與測試）。
 * - 第一次、換片（axis／at 變了）：變了。
 * - L 身分變了但 seq 沒動（換 split、換檔、重播、parked → live）：整片可能都不同，變了。
 * - seq 動了：剛好 +1 且外框沒碰到這一片 → 沒變；跳號（漏看了一步）或碰到 → 變了。
 * - 都沒動：沒變。
 * box＝最近一步的 stepTouch（null＝那一步沒有外框，當成碰到）。
 */
export function sliceTouched(prev: SliceRevKey | null, next: SliceRevKey, box: BBox | null | undefined): boolean {
  if (!prev || prev.axis !== next.axis || prev.at !== next.at) return true;
  if (next.seq === prev.seq) return next.L !== prev.L;
  if (prev.seq === undefined || next.seq !== prev.seq + 1) return true;
  return !box || planeHit(box, next.axis, next.at);
}

const sameKey = (a: SliceRevKey, b: SliceRevKey) => a.L === b.L && a.seq === b.seq && a.axis === b.axis && a.at === b.at;

/** hook 記住的狀態：上一組輸入、目前的版次、那一次算出來的 touched。 */
export interface SliceRevState {
  key: SliceRevKey;
  rev: number;
  touched: boolean;
}

/**
 * 一次 render（純函式）：輸入和上一次完全相同就回同一個狀態（StrictMode 的第二次呼叫、不相干的 state 變了），
 * 第二次不會把 touched 翻成 false 而讓 memo 用錯的 touched 去 get；不同才對照上一組算 touched、必要時 rev +1。
 */
export function stepSliceRev(s: SliceRevState | null, next: SliceRevKey, box: BBox | null | undefined): SliceRevState {
  if (s && sameKey(s.key, next)) return s;
  const touched = sliceTouched(s?.key ?? null, next, box);
  return { key: next, rev: (s?.rev ?? 0) + (touched ? 1 : 0), touched };
}

/**
 * 這一片的「版次」：touched 的 render 才 +1。memo 的 deps 用 rev 取代 L（L 改從 ref 讀），
 * touched 傳給 ModelStore.get（false＝不驗證、只把版本號接上）。
 */
export function useSliceRev(L: Labeled | undefined, axis: Axis, at: number, lastStep: LastStep | null | undefined): { rev: number; touched: boolean } {
  const st = useRef<SliceRevState | null>(null);
  st.current = stepSliceRev(st.current, { L, seq: lastStep?.seq, axis, at }, lastStep?.box);
  return { rev: st.current.rev, touched: st.current.touched };
}
