// 簡化版的編輯器狀態（plan v17）：只有「原始」與「目前」一本帳簿、推拉／平移／換材質三個動作、相鄰材質規則。
// 每一步送 Worker（只在外框裡算），回來後主執行緒原地貼補丁；復原／重做存補丁（50 步或 256 MB）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import { type BBox, type Comp, type Labeled, type Material, type Vec3, type Volume, MATERIALS, coordOf, demoVolume, idx, materialsFor, nameComponents, unionBBox } from '../../volume/volume';
import { type EditState, type Op, matNameOf } from '../../volume/ops';
import type { FractionArray } from '../../volume/vti';
import { fullScope } from '../../volume/scope';
import { applyIn, cancelCall, compsIn, deriveIn, exportIn, exportMetaIn, forkIn, isCancelled, loadOrig, newVersion, probeIn, sidOf } from '../../volume/client';
import { type DiffAxes, type Step, applyStepInPlace, carryStepStats, cropArr, newAxes, stepBytes, stepTouch, unionBox } from '../../volume/patch';
import { demoComplexVolume } from '../../volume/demoComplex';
import type { OpReport } from '../../volume/report';
import type { Probe } from '../../volume/probe';
import { overlayOpen, typingIn, usePersisted } from '../../ui/persist';
import { useEvent } from '../../ui/useEvent';
import { type FaceName, FACES, OPPOSITE, blockedText, faceName, faceOf, materialParts, namesOf, stepParts } from './stepWords';

export { type EditState, type Op, applyOp, matNameOf } from '../../volume/ops';

/** 「改了哪些」的一筆（plan v17 §5.5）：第一句、每種鄰居各一句；這一步改了幾個體素；點它＝選回這一組結構。 */
export interface StepNote {
  parts: string[];
  changed: number;
  keys: string[];
}

/** 復原／重做堆疊的一格：補丁＋另一邊的版本號＋這一步的說明。 */
export interface HistEntry {
  step: Step;
  version: number;
  note: StepNote;
}

/** 目前這本帳簿（主執行緒只有這一份，每一步原地貼補丁）。 */
export interface Buffers {
  data: Uint8Array;
  labels: Int32Array;
  diff: Uint8Array;
  diffCount: number;
  counts: Float64Array;
  /** 所有改過的範圍（寬鬆聯集）：外面和原始逐位元組相同。 */
  touch: BBox | null;
  axes: DiffAxes;
}

/** 載入來源；.vti 的 Spacing／Origin／陣列名匯出時原封不動寫回。 */
export interface Meta {
  name?: string;
  format: 'demo' | 'npy' | 'vti';
  spacing?: number[];
  origin?: number[];
  arrayName?: string;
  arrays?: string[];
  unit?: 'nm' | 'um';
  /** .vti 原檔在 Worker 裡：照原格式匯出時用（比例陣列＋FieldData）。 */
  hasRaw?: boolean;
  fractions?: FractionArray[];
  materialSource?: 'FieldData' | 'auto';
  input?: { source: 'PointData' | 'CellData'; fractionArrays?: string[]; fieldData: boolean; dtype: string; compressed: boolean };
}

export type SelectMode = 'set' | 'add' | 'toggle';
export const selectModeOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode => (e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set');

/** 三個動作（plan v17 §5.3）。 */
export type Tool = 'push' | 'move' | 'mat';

/** 這本帳簿在 Worker 裡的名字。 */
export const OWNER = 'cur';
export const BASE_ID = 'base';
/** 復原的筆數與位元組上限。 */
const HISTORY_LIMIT = 50;
export const HISTORY_BYTES = 256 * 2 ** 20;
/** Worker 忙的時候最多排幾步。 */
export const QUEUE_MAX = 3;
/** 「每次 n 格」的上限。 */
export const STEP_MAX = 20;

/** 從最舊開始丟，直到筆數 ≤ 50 且 Σ stepBytes ≤ bytes（至少留 1 筆）。 */
export function trimHist(hist: HistEntry[], bytes = HISTORY_BYTES): HistEntry[] {
  let total = 0;
  for (const h of hist) total += stepBytes(h.step);
  let k = 0;
  while (hist.length - k > 1 && (hist.length - k > HISTORY_LIMIT || total > bytes)) total -= stepBytes(hist[k++].step);
  return k ? hist.slice(k) : hist;
}

const EMPTY: EditState = { vol: { X: 1, Y: 1, Z: 1, data: new Uint8Array(1) }, L: { labels: new Int32Array([-1]), comps: [] }, version: 0 };
const wrap = (buf: Buffers, comps: Comp[], version: number, dims: { X: number; Y: number; Z: number }): EditState => ({
  vol: { X: dims.X, Y: dims.Y, Z: dims.Z, data: buf.data },
  L: { labels: buf.labels, comps },
  version,
  owner: OWNER,
});
const changedCount = (st: Step) => {
  if (!st.data) return 0;
  let n = 0;
  const { before, after } = st.data;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) n++;
  return n;
};
/** 結構的中心那一格（不在結構裡就用它的第一格）。 */
function centerOf(L: Labeled, vol: Volume, c: Comp): Vec3 {
  const b = c.bbox;
  const p: Vec3 = [(b.x0 + b.x1) >> 1, (b.y0 + b.y1) >> 1, (b.z0 + b.z1) >> 1];
  const k = L.comps.indexOf(c);
  return L.labels[idx(vol, p[0], p[1], p[2])] === k ? p : coordOf(vol, c.seed);
}

export function useEditor() {
  const { message } = App.useApp();
  const [materials, setMaterials] = useState<Material[]>([]);
  const materialsRef = useRef(materials);
  materialsRef.current = materials;
  const [meta, setMeta] = useState<Meta>({ format: 'demo' });
  const [origState, setOrig] = useState<EditState | null>(null);
  const [origCounts, setOrigCounts] = useState<Float64Array | null>(null);
  const origRef = useRef(origState);
  origRef.current = origState;
  const origCountsRef = useRef(origCounts);
  origCountsRef.current = origCounts;
  /** 目前：還沒改過＝原始（借用原始的陣列，buf 為 null）。 */
  const [curState, setCurState] = useState<EditState | null>(null);
  const [buf, setBufState] = useState<Buffers | null>(null);
  const [hist, setHistState] = useState<HistEntry[]>([]);
  const [future, setFutureState] = useState<HistEntry[]>([]);
  // 排隊中的步驟接在前一步的結果後面：帳簿的狀態另外放一份在 ref（每次改都同步更新）
  const book = useRef<{ cur: EditState | null; buf: Buffers | null; hist: HistEntry[]; future: HistEntry[] }>({ cur: null, buf: null, hist: [], future: [] });
  const setBook = (b: Partial<typeof book.current>) => {
    Object.assign(book.current, b);
    if ('cur' in b) setCurState(b.cur!);
    if ('buf' in b) setBufState(b.buf!);
    if ('hist' in b) setHistState(b.hist!);
    if ('future' in b) setFutureState(b.future!);
  };
  const [sel, setSel] = useState<Set<string>>(new Set());
  /** 最後選的那個結構（箭頭畫在它的外框上）。 */
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  const [tool, setTool] = usePersisted<Tool>('v17tool', 'push', (v): v is Tool => v === 'push' || v === 'move' || v === 'mat');
  const [face, setFace] = usePersisted<FaceName>('v17face', '上', (v): v is FaceName => FACES.some((f) => f.name === v));
  const [stepN, setStepNRaw] = usePersisted('v17n', 1, (v): v is number => typeof v === 'number' && v >= 1 && v <= STEP_MAX);
  const setStepN = (n: number) => setStepNRaw(Math.max(1, Math.min(STEP_MAX, Math.round(n) || 1)));
  /** 相鄰材質：跟著移動（true）／留在原地（false）。 */
  const [follow, setFollow] = usePersisted('v17follow', true);
  const [nmPerVoxel, setNmPerVoxel] = usePersisted('nmPerVoxel', 0.5, (v): v is number => typeof v === 'number' && v > 0);
  /** 最近一步的報告。 */
  const [report, setReport] = useState<OpReport | null>(null);
  /** 底下一行：上一步的一句話（canUndo＝後面放「復原」）。 */
  const [last, setLast] = useState<{ text: string; canUndo: boolean; at: number; box?: BBox } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const queue = useRef<Op[]>([]);
  const running = useRef(false);
  const keySeq = useRef(1000);
  /** 每一步送 Worker 前先叫它：畫面在主執行緒用裁切的小塊立刻畫出結果。 */
  const previewHook = useRef<((op: Op) => void) | null>(null);

  const ready = !!origState;
  const orig = origState ?? EMPTY;
  const cur = curState ?? orig;
  const vol = cur.vol;
  const L = cur.L;

  const matName = useMemo(() => matNameOf(materials), [materials]);
  const matNames = useMemo(() => Object.fromEntries(materials.map((m) => [m.id, m.name])), [materials]);
  /** 薄層材質（plan v17 §5.4.2）：載入時判定、清單上可以手動切換。 */
  const liners = useMemo(() => materials.filter((m) => m.liner).map((m) => m.id), [materials]);
  const compByKey = useMemo(() => new Map(L.comps.map((c) => [c.key, c])), [L]);
  const selComps = useMemo(() => L.comps.filter((c) => sel.has(c.key)), [L, sel]);
  const selIdx = useMemo(() => L.comps.flatMap((c, i) => (sel.has(c.key) ? [i] : [])), [L, sel]);
  const selBox: BBox | null = useMemo(() => unionBBox(selComps), [selComps]);
  const selMat = selComps[0]?.mat ?? null;
  /** 箭頭畫在哪個結構上：最後選的（還在的話），否則第一個。 */
  const handleComp = (lastKey && sel.has(lastKey) ? compByKey.get(lastKey) : undefined) ?? selComps[0] ?? null;
  const selName = namesOf(selComps, matName);
  /** 選取的 mask（3D 判斷滑鼠是不是在已選的結構上、切面描藍邊）。 */
  const selMask = useMemo(() => {
    if (!selIdx.length || !selBox) return null;
    const on = new Uint8Array(L.comps.length);
    for (const i of selIdx) on[i] = 1;
    const m = new Uint8Array(L.labels.length);
    const { X, Y } = vol;
    for (let z = selBox.z0; z <= selBox.z1; z++)
      for (let y = selBox.y0; y <= selBox.y1; y++)
        for (let i = (z * Y + y) * X + selBox.x0, e = i + selBox.x1 - selBox.x0; i <= e; i++) {
          const l = L.labels[i];
          if (l >= 0 && on[l]) m[i] = 1;
        }
    return m;
  }, [L, selIdx, selBox, vol]);
  const diffCount = buf?.diffCount ?? 0;
  const scope = useMemo(() => fullScope(vol), [vol]);

  // ---- 第一次改之前：把原始抄一份當帳簿（載入完就在 idle 時分段先抄好，不卡在按下去的那一刻） ----
  const spare = useRef<{ src: EditState; buf: Buffers; at: number } | null>(null);
  useEffect(() => {
    const o = origState;
    const oc = origCounts;
    spare.current = null;
    if (!o || !oc) return;
    const N = o.vol.data.length;
    const entry = { src: o, buf: { data: new Uint8Array(N), labels: new Int32Array(N), diff: new Uint8Array(N), diffCount: 0, counts: oc.slice(), touch: null, axes: newAxes(o.vol) } as Buffers, at: 0 };
    spare.current = entry;
    const STEP = 1 << 21;
    let cancelled = false;
    const idle = (cb: () => void) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(cb, { timeout: 1000 }) : window.setTimeout(cb, 16));
    const run = () => {
      if (cancelled || spare.current !== entry) return;
      const t0 = performance.now();
      while (entry.at < N && performance.now() - t0 < 6) {
        const end = Math.min(N, entry.at + STEP);
        entry.buf.data.set(o.vol.data.subarray(entry.at, end), entry.at);
        entry.buf.labels.set(o.L.labels.subarray(entry.at, end), entry.at);
        entry.at = end;
      }
      if (entry.at < N) idle(run);
    };
    idle(run);
    return () => {
      cancelled = true;
    };
  }, [origState, origCounts]);
  /** 帳簿：有了直接用；還沒有就拿先抄好的那一份（沒抄完的尾巴現在補），Worker 也 fork 一份。 */
  const own = (): { cur: EditState; buf: Buffers } => {
    const b = book.current;
    if (b.buf && b.cur) return { cur: b.cur, buf: b.buf };
    const o = origRef.current!;
    const oc = origCountsRef.current!;
    const s = spare.current;
    let nb: Buffers;
    if (s && s.src === o) {
      const N = o.vol.data.length;
      if (s.at < N) {
        s.buf.data.set(o.vol.data.subarray(s.at), s.at);
        s.buf.labels.set(o.L.labels.subarray(s.at), s.at);
        s.at = N;
      }
      nb = s.buf;
      spare.current = null;
    } else nb = { data: o.vol.data.slice(), labels: o.L.labels.slice(), diff: new Uint8Array(o.vol.data.length), diffCount: 0, counts: oc.slice(), touch: null, axes: newAxes(o.vol) };
    const version = sidOf(o);
    void forkIn(OWNER, o, version).catch(() => {});
    const c = wrap(nb, o.L.comps, version, o.vol);
    setBook({ cur: c, buf: nb });
    return { cur: c, buf: nb };
  };

  /** 一步的說明（plan v17 §5.5）；一格都沒做回傳 null 與「擋下來了」的原因。 */
  const describe = (op: Op, from: EditState, r: OpReport, after: Comp[] | null): { parts: string[] | null; text: string } => {
    const keys = new Set(op.keys);
    const comps = from.L.comps.filter((c) => keys.has(c.key));
    const who = namesOf(comps, matName);
    const stopWho = r.stop?.at !== undefined && from.L.labels[r.stop.at] >= 0 ? from.L.comps[from.L.labels[r.stop.at]]?.label : undefined;
    if (op.kind === 'material') {
      const now = after ? namesOf(after.filter((c) => keys.has(c.key)), matName) : undefined;
      const parts = materialParts(who, matName(op.m), now);
      return { parts, text: parts.join(' · ') };
    }
    if (op.kind !== 'push' && op.kind !== 'translate') return { parts: null, text: '' };
    const done = r.done ?? 0;
    if (!done) return { parts: null, text: blockedText(r.stop, matName, stopWho) };
    const dir = op.kind === 'push' ? op.dir : op.d;
    const n = op.kind === 'push' ? op.n : Math.abs(op.d[0] + op.d[1] + op.d[2]);
    const parts = stepParts({ kind: op.kind, who, face: faceName(dir), n, done, nmPerVoxel, follow: !!op.follow, effects: r.effects, stop: r.stop, stopWho }, matName);
    return { parts, text: parts.join(' · ') };
  };

  // ---- 一步：送 Worker、原地貼、記進復原堆疊 ----
  const commitOne = async (op: Op) => {
    const o = origRef.current;
    if (!o) return;
    const { cur: from, buf: b } = own();
    let r;
    try {
      r = await applyIn(from, { op, matNames, keyCounter: keySeq.current });
    } catch (e) {
      if (isCancelled(e)) message.info({ key: 'queue', content: '已取消，這一步沒有套用' });
      else message.error(`計算失敗，這一步沒有套用：${(e as Error)?.message ?? e}`);
      return;
    }
    keySeq.current = r.keyCounter;
    setReport(r.report);
    if (!r.step.data) {
      const d = describe(op, from, r.report, null);
      setLast({ text: op.kind === 'material' ? '已經是這個材質' : d.text, canUndo: false, at: Date.now() });
      return;
    }
    const comps = applyStepInPlace(from.vol, b.data, b.labels, r.step, 'fwd');
    b.diffCount = carryStepStats(from.vol, b.data, o.vol.data, b.diff, b.diffCount, b.counts, r.step, 'fwd', b.axes);
    b.touch = unionBox(b.touch, stepTouch(r.step));
    const next = wrap(b, comps ?? from.L.comps, r.version, from.vol);
    const d = describe(op, from, r.report, comps);
    const note: StepNote = { parts: d.parts ?? [d.text], changed: r.report.changed ?? changedCount(r.step), keys: [...op.keys] };
    setBook({ cur: next, hist: trimHist([...book.current.hist, { step: r.step, version: sidOf(from), note }]), future: [] });
    keepSel(next);
    setLast({ text: d.text, canUndo: true, at: Date.now(), box: r.step.data.box });
  };

  const drain = async () => {
    running.current = true;
    setBusy('計算中…');
    try {
      while (queue.current.length) {
        await latest.current.commitOne(queue.current[0]);
        queue.current.shift();
        setQueued(Math.max(0, queue.current.length - 1));
      }
    } finally {
      running.current = false;
      setBusy(null);
      setQueued(0);
      if (undoAfter.current) {
        undoAfter.current = false;
        undoRef.current();
      }
    }
  };
  const enqueue = (op: Op) => {
    if (queue.current.length > QUEUE_MAX) {
      message.warning({ key: 'queue', content: '還在算前面的步驟，請稍等' });
      return;
    }
    if (!running.current) previewHook.current?.(op);
    queue.current.push(op);
    setQueued(Math.max(0, queue.current.length - 1));
    if (!running.current) void latest.current.drain();
  };
  const latest = useRef({ enqueue, drain, commitOne });
  latest.current = { enqueue, drain, commitOne };
  const commit = useCallback((op: Op) => {
    if (!origRef.current) return;
    latest.current.enqueue(op);
  }, []);
  /** 取消：清掉還沒開始的步驟；正在算的那一步請 Worker 在安全點停。 */
  const cancel = useCallback(() => {
    if (!running.current) return;
    queue.current.length = Math.min(queue.current.length, 1);
    setQueued(0);
    cancelCall('apply');
    cancelCall('chunks');
    cancelCall('layer');
  }, []);

  /** 選取裡已經不存在的 key 拿掉。 */
  const keepSel = (s: EditState) =>
    setSel((prev) => {
      if (!prev.size) return prev;
      const keys = new Set(s.L.comps.map((c) => c.key));
      const next = [...prev].filter((k) => keys.has(k));
      return next.length === prev.size ? prev : new Set(next);
    });

  // ---- 復原／重做／全部還原 ----
  const stepInPlace = (h: HistEntry, dir: 'fwd' | 'back'): EditState => {
    const o = origRef.current!;
    const { cur: c, buf: b } = book.current;
    void deriveIn(c!, h.version, h.step, dir).catch(() => {});
    const comps = applyStepInPlace(o.vol, b!.data, b!.labels, h.step, dir);
    b!.diffCount = carryStepStats(o.vol, b!.data, o.vol.data, b!.diff, b!.diffCount, b!.counts, h.step, dir, b!.axes);
    b!.touch = unionBox(b!.touch, stepTouch(h.step));
    return wrap(b!, comps ?? c!.L.comps, h.version, o.vol);
  };
  const undoAfter = useRef(false);
  const undoRef = useRef<() => void>(() => {});
  const undo = useCallback(() => {
    if (running.current) {
      queue.current.length = Math.min(queue.current.length, 1);
      setQueued(0);
      undoAfter.current = true;
      return;
    }
    const { hist: hs, cur: c, buf: b } = book.current;
    if (!hs.length || !c || !b) return;
    const h = hs[hs.length - 1];
    const prev = stepInPlace(h, 'back');
    setBook({ cur: prev, hist: hs.slice(0, -1), future: [{ step: h.step, version: sidOf(c), note: h.note }, ...book.current.future] });
    keepSel(prev);
    setReport(null);
    setLast({ text: `已復原：${h.note.parts.join(' · ')}`, canUndo: false, at: Date.now() });
  }, []);
  undoRef.current = undo;
  const redo = useCallback(() => {
    if (running.current) return;
    const { future: fs, cur: c, buf: b } = book.current;
    if (!fs.length || !c || !b) return;
    const f = fs[0];
    const next = stepInPlace(f, 'fwd');
    setBook({ cur: next, hist: trimHist([...book.current.hist, { step: f.step, version: sidOf(c), note: f.note }]), future: fs.slice(1) });
    keepSel(next);
    setReport(null);
    setLast({ text: `已重做：${f.note.parts.join(' · ')}`, canUndo: true, at: Date.now() });
  }, []);
  /**
   * 全部還原（plan v17 §5.8）：回到原始；它本身是一步（補丁＝改過的範圍裡「目前 → 原始」），可以復原。
   */
  const resetAll = useCallback(() => {
    const o = origRef.current;
    const { cur: c, buf: b } = book.current;
    if (running.current || !o || !c || !b || !b.diffCount || !b.touch) return;
    const box = b.touch;
    const step: Step = {
      data: { box, before: cropArr(b.data, o.vol, box), after: cropArr(o.vol.data, o.vol, box) },
      labels: { box, before: cropArr(b.labels, o.vol, box), after: cropArr(o.L.labels, o.vol, box), moves: [], compsBefore: c.L.comps, compsAfter: o.L.comps },
    };
    const note: StepNote = { parts: ['全部還原（回到原始）'], changed: b.diffCount, keys: [] };
    const h: HistEntry = { step, version: sidOf(c), note };
    // 往前套：Worker 的帳簿從目前到一個新版本（內容＝原始）
    const v = newVersion();
    void deriveIn(c, v, step, 'fwd').catch(() => {});
    const comps = applyStepInPlace(o.vol, b.data, b.labels, step, 'fwd');
    b.diffCount = carryStepStats(o.vol, b.data, o.vol.data, b.diff, b.diffCount, b.counts, step, 'fwd', b.axes);
    const next = wrap(b, comps ?? o.L.comps, v, o.vol);
    setBook({ cur: next, hist: trimHist([...book.current.hist, h]), future: [] });
    keepSel(next);
    setReport(null);
    setLast({ text: '已全部還原，輸出與原始相同', canUndo: true, at: Date.now() });
  }, []);

  // ---- 選取 ----
  const selectKeys = useCallback(
    (keys: string[], mode: SelectMode = 'set') => {
      const cs = book.current.cur?.L.comps ?? origRef.current?.L.comps ?? [];
      const byKey = new Map(cs.map((c) => [c.key, c]));
      setSel((prev) => {
        if (mode === 'set') return new Set(keys);
        // 多選只收相同材質（plan v17 §5.2）
        const first = [...prev].map((k) => byKey.get(k)).find((c) => !!c);
        const ok = first ? keys.filter((k) => byKey.get(k)?.mat === first.mat) : keys;
        if (first && ok.length < keys.length) message.info({ key: 'multi', content: `只能多選相同材質：已選的是 ${matName(first.mat)}` });
        const next = new Set(prev);
        if (mode === 'add') ok.forEach((k) => next.add(k));
        else ok.forEach((k) => (next.has(k) ? next.delete(k) : next.add(k)));
        return next;
      });
      if (keys.length) setLastKey(keys[keys.length - 1]);
      // 選到隱藏材質裡的結構：打開
      const mats = keys.map((k) => byKey.get(k)?.mat).filter((m): m is number => m !== undefined);
      setHidden((h) => (mats.some((m) => h.has(m)) ? new Set([...h].filter((m) => !mats.includes(m))) : h));
    },
    [message, matName],
  );
  const clearSel = useCallback(() => setSel(new Set()), []);
  /** 點清單：選取並把十字移到它的中心（選了一定看得到）。 */
  const selectFromList = useCallback(
    (key: string, mode: SelectMode) => {
      selectKeys([key], mode);
      const s = book.current.cur ?? origRef.current;
      const c = s?.L.comps.find((x) => x.key === key);
      if (s && c) setCursor(centerOf(s.L, s.vol, c));
    },
    [selectKeys],
  );
  const pickVoxel = useCallback(
    (i: number | null, mode: SelectMode = 'set') => {
      const s = book.current.cur ?? origRef.current;
      if (!s) return;
      const l = i === null ? -1 : s.L.labels[i];
      if (l < 0) {
        if (mode === 'set') clearSel();
        return;
      }
      selectKeys([s.L.comps[l].key], mode);
      setCursor(coordOf(s.vol, i!));
    },
    [selectKeys, clearSel],
  );
  /** 選全部同材質（「選全部 Poly-Si（2）」、Ctrl+A）。 */
  const selectSame = useCallback(() => {
    if (selMat === null) return;
    setSel(new Set(L.comps.filter((c) => c.mat === selMat).map((c) => c.key)));
  }, [L, selMat]);
  const toggleHidden = useCallback(
    (mat: number) => {
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(mat)) next.delete(mat);
        else next.add(mat);
        return next;
      });
      // 把目前選取的材質隱藏：取消選取
      if (selMat === mat && !hidden.has(mat)) setSel(new Set());
    },
    [selMat, hidden],
  );

  // ---- 動作（plan v17 §5.3）：都作用在整個結構、相鄰材質規則 ----
  const pushOp = useCallback(
    (f: FaceName, n: number): Op | null =>
      !sel.size || !n ? null : { kind: 'push', keys: [...sel], scope, dir: faceOf(f).d, n, follow, backfill: 'outer', policy: 'adjacent', liners },
    [sel, scope, follow, liners],
  );
  const moveOp = useCallback(
    (f: FaceName, n: number): Op | null => {
      if (!sel.size || !n) return null;
      const d = faceOf(n > 0 ? f : OPPOSITE[f]).d.map((v) => v * Math.abs(n)) as Vec3;
      return { kind: 'translate', keys: [...sel], scope, d, backfill: 'outer', follow, policy: 'adjacent', liners };
    },
    [sel, scope, follow, liners],
  );
  /** 3D 箭頭拖 n 格 → Op（推拉＝外推／內縮那一面；平移＝往箭頭方向搬）。 */
  const faceOp = useCallback(
    (dir: Vec3, n: number): Op | null => (tool === 'move' ? moveOp(faceName(dir), n) : pushOp(faceName(dir), n)),
    [tool, moveOp, pushOp],
  );
  const push = useEvent((f: FaceName, n: number) => {
    const op = pushOp(f, n);
    if (op) commit(op);
  });
  const move = useEvent((f: FaceName, n: number) => {
    const op = moveOp(f, n);
    if (op) commit(op);
  });
  /** 換材質：換到檔案裡原本沒有的材質時，新材質沿用來源材質的薄層設定（plan v17 §5.4.2）。 */
  const setMaterial = useEvent((m: number) => {
    if (!sel.size) return;
    const src = materialsRef.current.find((x) => x.id === selMat);
    const dst = materialsRef.current.find((x) => x.id === m);
    if (dst && src && !L.comps.some((c) => c.mat === m) && !!dst.liner !== !!src.liner) setMaterials((ms) => ms.map((x) => (x.id === m ? { ...x, liner: !!src.liner } : x)));
    commit({ kind: 'material', keys: [...sel], scope, m });
  });

  // ---- 試算（plan v17 §5.4.4）：同時最多一個在飛、永遠送最新的 ----
  const [probe, setProbe] = useState<{ sig: string; p: Probe } | null>(null);
  const probeSig = ready && sel.size && tool !== 'mat' ? `${sidOf(cur)}|${[...sel].sort().join(',')}|${tool}|${tool === 'push' ? face : ''}|${follow}|${liners.join(',')}` : '';
  const probeFly = useRef<{ inflight: boolean; pending: (() => void) | null }>({ inflight: false, pending: null });
  useEffect(() => {
    if (!probeSig) return;
    const send = () => {
      const s = book.current.cur ?? origRef.current;
      if (!s) return;
      probeFly.current.inflight = true;
      const sig = probeSig;
      probeIn(s, { keys: [...sel], kind: tool === 'move' ? 'translate' : 'push', dir: faceOf(face).d, follow, liners })
        .then((p) => setProbe({ sig, p }))
        .catch(() => {})
        .finally(() => {
          probeFly.current.inflight = false;
          const next = probeFly.current.pending;
          probeFly.current.pending = null;
          next?.();
        });
    };
    if (probeFly.current.inflight) probeFly.current.pending = send;
    else send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeSig]);
  const probeNow = probe && probe.sig === probeSig ? probe.p : null;

  // ---- 載入與材質 ----
  const loadVolume = useCallback(async (v: Volume, m: Meta, mats?: Material[]) => {
    if (running.current) return;
    setBusy('分析結構中…');
    running.current = true;
    try {
      const r = await loadOrig(v);
      const linerSet = new Set(r.liners);
      let table = materialsFor(r.raw.map((x) => x.mat));
      if (mats) {
        table = table.map((t) => mats.find((x) => x.id === t.id) ?? t);
        // 內建範例：表上其他材質也列出來（換材質可以換成檔案裡沒有的，例如 SiGe）
        for (const x of mats) if (!table.some((t) => t.id === x.id)) table.push(x);
        table.sort((a, b) => a.id - b.id);
      }
      table = table.map((t) => ({ ...t, liner: linerSet.has(t.id) }));
      setMaterials(table);
      setMeta(m);
      const comps = nameComponents(r.raw, matNameOf(table));
      const o: EditState = { vol: v, L: { labels: r.labels, comps }, version: r.version, owner: BASE_ID };
      setOrig(o);
      setOrigCounts(r.counts);
      void compsIn(BASE_ID, comps).catch(() => {});
      void exportMetaIn(m.hasRaw && m.fractions ? m.fractions : null).catch(() => {});
      setBook({ cur: null, buf: null, hist: [], future: [] });
      keySeq.current = 1000;
      setSel(new Set());
      setHidden(new Set());
      setReport(null);
      setProbe(null);
      setCursor([v.X >> 1, v.Y >> 1, v.Z >> 1]);
      if (m.spacing) setNmPerVoxel(m.unit === 'um' ? m.spacing[0] * 1000 : m.spacing[0]);
      const names = table.filter((t) => t.liner).map((t) => t.name);
      setLast({ text: names.length ? `已載入。薄層：${names.join('、')}（判斷錯了可以在左邊清單切換）` : '已載入。沒有判定為薄層的材質', canUndo: false, at: Date.now() });
    } finally {
      setBusy(null);
      running.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 內建範例：簡單（3 根 fin × 3 根閘極）、複雜（比較像真實製程）。 */
  const demo = useCallback(
    (kind: 'basic' | 'complex' = 'basic') =>
      loadVolume(kind === 'complex' ? demoComplexVolume(1) : demoVolume(1), { format: 'demo', name: kind === 'complex' ? '複雜範例' : '簡單範例' }, MATERIALS),
    [loadVolume],
  );
  /** 改名：結構名字前綴跟著換（原始、目前、復原堆疊裡的都換）。 */
  const renameMaterial = useEvent((id: number, name: string) => {
    if (!name) return;
    const old = matName(id);
    setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)));
    const fix = (comps: Comp[]) => comps.map((c) => (c.mat === id && c.label.startsWith(old) ? { ...c, label: name + c.label.slice(old.length) } : c));
    const fixS = (s: EditState): EditState => ({ ...s, L: { ...s.L, comps: fix(s.L.comps) } });
    const fixH = (h: HistEntry): HistEntry => (h.step.labels ? { ...h, step: { ...h.step, labels: { ...h.step.labels, compsBefore: fix(h.step.labels.compsBefore), compsAfter: fix(h.step.labels.compsAfter) } } } : h);
    setOrig((o) => o && fixS(o));
    const b = book.current;
    setBook({ cur: b.cur && fixS(b.cur), hist: b.hist.map(fixH), future: b.future.map(fixH) });
  });
  const setMaterialColor = useEvent((id: number, color: string) => setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, color } : m))));
  /** 薄層標記（自動判定錯的時候的出路）。 */
  const toggleLiner = useEvent((id: number) => setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, liner: !m.liner } : m))));

  // ---- 匯出：一顆按鈕、一個 .vti，格式和輸入相同（比例陣列＋FieldData 的檔照原檔寫回；否則 UInt8 CellData） ----
  const exportVti = useEvent(() => {
    const spacing = meta.spacing ?? [nmPerVoxel, nmPerVoxel, nmPerVoxel];
    const origin = meta.origin ?? [0, 0, 0];
    const like = !!(meta.hasRaw && meta.fractions);
    const mats = materialsRef.current.map((m) => ({ id: m.id, name: m.name, color: m.color }));
    const b = book.current;
    return exportIn({ state: b.buf && b.cur ? b.cur : undefined }, { format: 'vti', spacing, origin, arrayName: meta.arrayName && !like ? meta.arrayName : 'material', materials: mats });
  });

  // ---- 十字 ----
  const stepCursor = useEvent((axis: 'x' | 'y' | 'z', delta: number) =>
    setCursor((c) => {
      const a = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
      const max = axis === 'x' ? vol.X : axis === 'y' ? vol.Y : vol.Z;
      const next: Vec3 = [...c];
      next[a] = Math.max(0, Math.min(max - 1, c[a] + delta));
      return next;
    }),
  );

  // ---- 鍵盤（plan v17 §5.6）：方向鍵對應模型的上下左右前後 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target) || overlayOpen()) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && k === 'a') {
        e.preventDefault();
        selectSame();
        return;
      }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') {
        clearSel();
        return;
      }
      // 焦點在滑桿、下拉、輸入框上：方向鍵留給它們
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae.closest('[role=slider],.ant-select,.ant-input-number,input,textarea')) return;
      const f = FACES.find((x) => x.key === e.key);
      if (f && sel.size) {
        e.preventDefault();
        if (tool === 'move') move(f.name, stepN);
        else if (tool === 'push') setFace(f.name);
        return;
      }
      if ((e.key === '+' || e.key === '=' || e.key === '-') && sel.size && tool === 'push') {
        e.preventDefault();
        push(face, e.key === '-' ? -stepN : stepN);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectSame, clearSel, sel.size, tool, face, stepN, move, push, setFace]);

  // 開發模式：e2e（scripts/e2e/m17.cjs）讀狀態
  const steps = hist.length;
  const out = {
    ready,
    materials,
    matName,
    liners,
    meta,
    orig,
    cur,
    vol,
    L,
    comps: L.comps,
    compByKey,
    hist,
    future,
    steps,
    diffCount,
    undo,
    redo,
    resetAll,
    busy,
    queued,
    cancel,
    report,
    last,
    setLast,
    sel,
    selComps,
    selIdx,
    selBox,
    selMask,
    selMat,
    selName,
    handleComp,
    selectKeys,
    selectFromList,
    clearSel,
    pickVoxel,
    selectSame,
    hidden,
    toggleHidden,
    cursor,
    setCursor,
    stepCursor,
    cursorIndex: idx(vol, cursor[0], cursor[1], cursor[2]),
    tool,
    setTool,
    face,
    setFace,
    stepN,
    setStepN,
    follow,
    setFollow,
    nmPerVoxel,
    setNmPerVoxel,
    scope,
    commit,
    push,
    move,
    pushOp,
    moveOp,
    faceOp,
    setMaterial,
    probe: probeNow,
    previewHook,
    loadVolume,
    demo,
    renameMaterial,
    setMaterialColor,
    toggleLiner,
    exportVti,
    origCounts,
    version: sidOf(cur),
  };
  if (import.meta.env.DEV) (window as unknown as { __ed?: unknown }).__ed = out;
  return out;
}

export type Editor = ReturnType<typeof useEditor>;
