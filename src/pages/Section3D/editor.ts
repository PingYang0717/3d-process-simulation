import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import {
  type Axis,
  type Backfill,
  type BBox,
  type Comp,
  type Labeled,
  type Material,
  type Vec3,
  type Volume,
  MATERIALS,
  coordOf,
  demoVolume,
  idx,
  maskOf,
  materialsFor,
  nameComponents,
  unionBBox,
} from '../../volume/volume';
import { type EditState, type Local, type Op, type SweepKind, matNameOf, opText, sweepOps } from '../../volume/ops';
import type { BrushShape } from '../../volume/volume';
import { type Scope, axisIndex, axisLen, boxRange, clampScope, fullScope, isFullScope, scopeBox } from '../../volume/scope';

/** 範圍：整個結構（預設）、只有目前這一片、自訂一段；軸＝目前主切面的法線軸。 */
export type ScopeMode = 'whole' | 'slice' | 'custom';
const isAxis = (v: unknown): v is Axis => v === 'x' || v === 'y' || v === 'z';
const isScopeMode = (v: unknown): v is ScopeMode => v === 'whole' || v === 'slice' || v === 'custom';

/** 選取 ∩ scope：所見即會被改。scope 是整段時直接回傳原 mask。 */
export function maskInScope(mask: Uint8Array, vol: Volume, scope: Scope): Uint8Array {
  if (isFullScope(scope, vol)) return mask;
  const out = new Uint8Array(mask.length);
  const b = scopeBox(vol, scope);
  if (!b) return out;
  const { X, Y } = vol;
  if (scope.axis === 'z') {
    const plane = X * Y;
    out.set(mask.subarray(b.z0 * plane, (b.z1 + 1) * plane), b.z0 * plane);
    return out;
  }
  for (let z = b.z0; z <= b.z1; z++)
    for (let y = b.y0; y <= b.y1; y++) {
      const row = (z * Y + y) * X;
      out.set(mask.subarray(row + b.x0, row + b.x1 + 1), row + b.x0);
    }
  return out;
}

/** mask 沿 axis 每一片有沒有體素（找「最近有這個結構的一片」用）。 */
export function slicesWith(mask: Uint8Array, vol: Volume, axis: Axis): Uint8Array {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(axisLen(vol, axis));
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const row = (z * Y + y) * X;
      for (let x = 0; x < X; x++) if (mask[row + x]) out[axis === 'x' ? x : axis === 'y' ? y : z] = 1;
    }
  return out;
}

/** 3D 筆刷：推拉（沿法線長／縮 n 格）、補平（補到／削到點到的那一面）或關閉（拖拉一律轉視角）；半徑 null = 整面。 */
export interface Brush {
  mode: 'push' | 'level' | 'off';
  radius: number | null;
  shape: BrushShape;
}
/** 3D 上雕刻的一筆：View3D 送出，editor 補上選取、z 範圍、襯層與回填設定變成 Op。 */
export type Sculpt = { kind: 'push'; dir: Vec3; n: number; local: Local } | { kind: 'level'; dir: Vec3; to: number; local: Local };
import { applyIn, deriveIn, dropOwners, forkIn, loadOrig, newVersion, replayIn, sidOf } from '../../volume/client';
import { type Step, applyStepInPlace, carryStepStats } from '../../volume/patch';
import { type OpReport, blockedPhrase, summarize } from '../../volume/report';
import { boxVoxels } from '../../volume/preview';
import { clipBox as clipScopeBox } from '../../volume/scope';
import type { PickedHandle } from './SliceEditor';
import { ModelStore } from '../../slice/model';
import { overlayOpen, typingIn, usePersisted } from '../../ui/persist';

export { type EditState, type Op, type SweepKind, applyOp, matNameOf, opText, replay, sweepOps } from '../../volume/ops';

/**
 * 復原／重做堆疊的一格（§8.3）：補丁＋另一邊的 ops 與版本號。不存整個陣列。
 * hist 裡的 step 往回套（back）回到 version；future 裡的往前套（fwd）。
 */
export interface HistEntry {
  step: Step;
  ops: Op[];
  version: number;
}

/**
 * 一個 split 的帳簿（plan v9 §4.1）：體素、結構編號、和原始不同的格子、材質體積帳，主執行緒只有這一份，
 * 每一步原地貼補丁。cur.vol.data／cur.L.labels 永遠指向這裡（或還沒改過時借用原始）。
 */
export interface SplitBuffers {
  data: Uint8Array;
  labels: Int32Array;
  diff: Uint8Array;
  diffCount: number;
  counts: Float64Array;
}

export interface Split {
  id: string;
  name: string;
  ops: Op[];
  /** 規則：改 buf 內容的同一個 tick 一定換一個新的 cur（新版本號），以 cur／vol／L 身分當 deps 的 memo 才會重算。 */
  cur: EditState;
  hist: HistEntry[];
  future: HistEntry[];
  /** null＝還沒改過，借用原始的陣列。 */
  buf: SplitBuffers | null;
}

/** 一步的報告（訊息、「看這些片」、被擋的格子標紅）。 */
export interface StepReport extends OpReport {
  op: Op;
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
}

export interface Diff {
  mask: Uint8Array;
  count: number;
}

export const BASE_ID = 'base';
/** 每個 split 留幾步 Undo（存的是補丁，只有改到的外框那麼大）。 */
const HISTORY_LIMIT = 50;
/** Worker 忙的時候最多排幾步；再多就拒絕並提示。 */
export const QUEUE_MAX = 3;
const EMPTY: EditState = { vol: { X: 1, Y: 1, Z: 1, data: new Uint8Array(1) }, L: { labels: new Int32Array([-1]), comps: [] }, version: 0 };

/** split 和原始的 diff（主執行緒差量更新，不再跟 Worker 要，§4.4）。 */
export const splitDiff = (s: Pick<Split, 'buf'>): Diff => (s.buf ? { mask: s.buf.diff, count: s.buf.diffCount } : NO_DIFF);
const NO_DIFF: Diff = { mask: new Uint8Array(0), count: 0 };

/** 帳簿 buf 的某個版本的 wrapper（每一步新物件，陣列身分不變）。 */
const wrap = (owner: string, buf: SplitBuffers, comps: Comp[], version: number, dims: { X: number; Y: number; Z: number }): EditState => ({
  vol: { X: dims.X, Y: dims.Y, Z: dims.Z, data: buf.data },
  L: { labels: buf.labels, comps },
  version,
  owner,
});

// ---- useEditor ----

export type SelectMode = 'set' | 'add' | 'toggle';
export const selectModeOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode =>
  e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set';

export interface MenuState {
  x: number;
  y: number;
  key: string | null;
  /** 沿射線往裡面還有哪些結構（含第一個），「這裡的其他結構」用。 */
  along?: string[];
}

export function useEditor() {
  const { message, modal } = App.useApp();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [meta, setMeta] = useState<Meta>({ format: 'demo' });
  const [origState, setOrig] = useState<EditState | null>(null);
  // 一開始只有「原始」；第一次在原始上調整會自動建立 Split 1
  const [splits, setSplitsState] = useState<Split[]>([]);
  const [activeId, setActiveIdState] = useState(BASE_ID);
  // 排隊中的步驟要接在前一步的結果後面，所以 split 清單另外放一份在 ref（每次改都同步更新）
  const splitsRef = useRef<Split[]>([]);
  const activeRef = useRef(BASE_ID);
  const setSplits = useCallback((v: Split[] | ((all: Split[]) => Split[])) => {
    const next = typeof v === 'function' ? v(splitsRef.current) : v;
    // 開發模式檢查（plan v9 §9）：每個有帳簿的 split，cur 一定指向它自己的帳簿
    if (import.meta.env.DEV)
      for (const sp of next)
        if (sp.buf && (sp.cur.vol.data !== sp.buf.data || sp.cur.L.labels !== sp.buf.labels || sp.cur.owner !== sp.id))
          console.error(`split ${sp.id} 的 cur 沒有指向自己的帳簿`);
    splitsRef.current = next;
    setSplitsState(next);
  }, []);
  const setActiveId = useCallback((id: string) => {
    activeRef.current = id;
    setActiveIdState(id);
  }, []);
  /** 最近一步的報告（被擋的片、格子）。 */
  const [report, setReport] = useState<StepReport | null>(null);
  /** 排隊等 Worker 的步驟數（不含正在算的那一步）。 */
  const [queued, setQueued] = useState(0);
  const queue = useRef<Op[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  // 範圍（Scope）：一個狀態，位置列與右欄兩處顯示。軸＝主切面的法線軸（上次用的方向記在 localStorage）
  const [editAxis, setEditAxis] = usePersisted<Axis>('editAxis', 'z', isAxis);
  const [scopeMode, setScopeMode] = usePersisted<ScopeMode>('scopeMode', 'whole', isScopeMode);
  /** 自訂範圍的兩端（絕對座標，沿 editAxis）。 */
  const [customRange, setCustomRange] = useState<[number, number]>([0, 0]);
  /** 在 3D 上雕刻（進階，預設關）：關著時 3D 上怎麼拖都只轉視角。 */
  const [sculpt3d, setSculpt3d] = usePersisted('sculpt3d', false);
  /** 選到結構時主切面自動放大到它。 */
  const [autoZoom, setAutoZoom] = usePersisted('autoZoom', true);
  /** 大操作確認門檻（體素數）：一步會動到的範圍超過就先問。 */
  const [bigOp, setBigOp] = usePersisted('bigOp', 4_000_000, (v): v is number => typeof v === 'number' && v > 0);
  /** 多選時把手勢也做在長得一樣的結構上（§7.7）。 */
  const [mirror, setMirror] = usePersisted('mirror', true);
  /** 主切面上選到的把手（節點／邊）：右欄數值輸入、方向鍵。 */
  const [handle, setHandle] = useState<PickedHandle | null>(null);
  // 跨次記住：襯層跟推、nm 比例（載入有 spacing 的 .vti 會覆蓋）、筆刷
  const [follow, setFollow] = usePersisted('follow', true);
  const [backfill, setBackfill] = useState<Backfill>('orig');
  const [nmPerVoxel, setNmPerVoxel] = usePersisted('nmPerVoxel', 0.5, (v): v is number => typeof v === 'number' && v > 0);
  const [brush, setBrush] = usePersisted<Brush>(
    'brush',
    { mode: 'push', radius: 6, shape: 'round' },
    (v): v is Brush => !!v && typeof v === 'object' && ['push', 'level', 'off'].includes((v as Brush).mode) && ['round', 'square'].includes((v as Brush).shape),
  );
  /** 每一步送 Worker 前先叫它：View3D 在主執行緒用裁切的小塊立刻畫出結果（正式結果幾秒後覆蓋）。 */
  const previewHook = useRef<((op: Op) => void) | null>(null);
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 計算中的說明（例如「計算中…」）；有值時其他改體素的動作先擋下。 */
  const [busy, setBusy] = useState<string | null>(null);
  /** 原始的材質體積帳（載入時 Worker 數一次）。 */
  const [origCounts, setOrigCounts] = useState<Float64Array | null>(null);
  const origCountsRef = useRef<Float64Array | null>(null);
  origCountsRef.current = origCounts;
  const keySeq = useRef(1000);
  const splitSeq = useRef(1);
  /** 2D 編輯的幾何層（plan v8 §6）：每片一份、每個版本留快照；所有拖拉、數值輸入、方向鍵都改它。 */
  const models = useRef(new ModelStore()).current;
  /** 已經算完的步數（不論有沒有改到）：幾何層靠它知道「放開的那一步回來了」。 */
  const [stepSeq, setStepSeq] = useState(0);
  /** 2D 編輯的設定（plan v8 §5.4）：輪廓畫幾何線或階梯；拖拉中跟手（放開才吸附）或邊拖邊吸附。 */
  const [outlineStyle, setOutlineStyle] = usePersisted<'geometry' | 'stairs'>('outlineStyle', 'geometry', (v): v is 'geometry' | 'stairs' => v === 'geometry' || v === 'stairs');
  const [snapMode, setSnapMode] = usePersisted<'release' | 'live'>('snapMode', 'release', (v): v is 'release' | 'live' => v === 'release' || v === 'live');
  const running = useRef(false);
  const newSplitId = () => `s${splitSeq.current++}`;

  const ready = !!origState;
  const orig = origState ?? EMPTY;
  const isBase = activeId === BASE_ID;
  const active = splits.find((s) => s.id === activeId) ?? null;
  const cur = active ? active.cur : orig;
  const vol = cur.vol;
  const L = cur.L;
  const hist = active?.hist ?? [];
  const future = active?.future ?? [];

  const matName = useMemo(() => matNameOf(materials), [materials]);
  const matNames = useMemo(() => Object.fromEntries(materials.map((m) => [m.id, m.name])), [materials]);
  const compByKey = useMemo(() => new Map(L.comps.map((c) => [c.key, c])), [L]);
  const origByKey = useMemo(() => new Map(orig.L.comps.map((c) => [c.key, c])), [orig]);
  const selComps = useMemo(() => L.comps.filter((c) => sel.has(c.key)), [L, sel]);
  /** 選取結構在 L.comps 裡的 index（給 Worker 畫選取層）。 */
  const selIdx = useMemo(() => L.comps.flatMap((c, i) => (sel.has(c.key) ? [i] : [])), [L, sel]);
  const selMask = useMemo(() => maskOf(L, sel), [L, sel]);
  const selBox: BBox | null = useMemo(() => unionBBox(selComps), [selComps]);
  /** 選取結構沿 editAxis 的起止（「整個結構（z 0～127）」的數字）。 */
  const selRange = useMemo<[number, number] | null>(() => (selBox ? boxRange(selBox, editAxis) : null), [selBox, editAxis]);
  /** 實際送進 Op 的範圍：整個結構＝整段（選取本來就只有那段，重播到別的 split 也不會被切掉）。 */
  const scope: Scope = useMemo(() => {
    if (scopeMode === 'slice') {
      const t = cursor[axisIndex(editAxis)];
      return clampScope({ axis: editAxis, lo: t, hi: t }, vol);
    }
    if (scopeMode === 'custom') return clampScope({ axis: editAxis, lo: customRange[0], hi: customRange[1] }, vol);
    return fullScope(vol, editAxis);
  }, [scopeMode, editAxis, cursor, customRange, vol]);
  const setCustom = useCallback(
    (lo: number, hi: number) => {
      const c = clampScope({ axis: editAxis, lo, hi }, vol);
      setCustomRange([c.lo, c.hi]);
    },
    [editAxis, vol],
  );
  // 換結構時，自訂的兩端夾到結構的範圍裡（完全沒交集就用整個結構）；換軸時舊的數字沒有意義，直接用整個結構
  const selKey = [...sel].sort().join(',');
  const rangeAxis = useRef(editAxis);
  useEffect(() => {
    if (!selRange) return;
    if (rangeAxis.current !== editAxis) {
      rangeAxis.current = editAxis;
      setCustomRange([selRange[0], selRange[1]]);
      return;
    }
    setCustomRange(([a, b]) => {
      const lo = Math.max(a, selRange[0]);
      const hi = Math.min(b, selRange[1]);
      return lo <= hi ? [lo, hi] : [selRange[0], selRange[1]];
    });
    // 只在選取或軸改變時夾；長高之後外框變了不必重夾
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey, editAxis]);
  const affMask = useMemo(() => (selMask ? maskInScope(selMask, vol, scope) : null), [selMask, scope, vol]);
  const selCount = useMemo(() => selComps.reduce((s, c) => s + c.count, 0), [selComps]);

  /** 目前 split 的 diff 與體積帳：讀帳簿（cur 每一步換新，所以這裡每一步重算）。 */
  const diff: Diff = useMemo(() => (active ? splitDiff(active) : NO_DIFF), [active, cur]);
  const counts = useMemo(
    () => (origCounts ? { before: Array.from(origCounts), after: Array.from(active?.buf?.counts ?? origCounts) } : null),
    [origCounts, active, cur],
  );

  const changedKeys = useMemo(() => {
    const out = new Set<string>();
    L.comps.forEach((c) => {
      const o = origByKey.get(c.key);
      if (
        !o ||
        o.count !== c.count ||
        o.mat !== c.mat ||
        o.bbox.x0 !== c.bbox.x0 ||
        o.bbox.y0 !== c.bbox.y0 ||
        o.bbox.z0 !== c.bbox.z0 ||
        o.bbox.x1 !== c.bbox.x1 ||
        o.bbox.y1 !== c.bbox.y1 ||
        o.bbox.z1 !== c.bbox.z1
      )
        out.add(c.key);
    });
    return out;
  }, [L, origByKey]);
  /** 各材質體積帳。 */
  const ledger = useMemo(() => {
    if (!counts) return [];
    const ids = new Set<number>();
    counts.before.forEach((n, id) => n && ids.add(id));
    counts.after.forEach((n, id) => n && ids.add(id));
    return [...ids]
      .sort((a, b) => a - b)
      .map((id) => ({ id, name: matName(id), before: counts.before[id], after: counts.after[id] }));
  }, [counts, matName]);

  const describe = useCallback(
    (op: Op, at: Labeled) => opText(op, at, vol, nmPerVoxel, matName),
    [vol, nmPerVoxel, matName],
  );

  const origRef = useRef(origState);
  origRef.current = origState;
  /** 這一步真正改了幾格（補丁裡前後不同的格數）。 */
  const changedCount = (st: Step) => {
    if (!st.data) return 0;
    let n = 0;
    const { before, after } = st.data;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) n++;
    return n;
  };
  const blockedText = (r: OpReport) => blockedPhrase(r, matName);
  /** 「已套用到整根（z 0～127）」「已套用到此片（z = 64）」「已套用到 z 40～80」。 */
  const appliedText = (op: Op, from: EditState) => {
    const a = op.scope.axis;
    if (op.scope.lo === op.scope.hi) return `已套用到此片（${a} = ${op.scope.lo}）`;
    if (isFullScope(op.scope, from.vol)) {
      const keys = new Set(op.keys);
      const b = unionBBox(from.L.comps.filter((c) => keys.has(c.key)));
      const r = b ? boxRange(b, a) : null;
      return `已套用到${op.keys.length > 1 ? '整個結構' : '整根'}${r ? `（${a} ${r[0]}～${r[1]}）` : ''}`;
    }
    return `已套用到 ${a} ${op.scope.lo}～${op.scope.hi}`;
  };
  /** 訊息前半：結構＋動作（範圍放在 appliedText，不重複）。 */
  const headText = (op: Op, from: EditState) => `${describe({ ...op, scope: fullScope(from.vol, op.scope.axis) } as Op, from.L)} · ${appliedText(op, from)}`;
  /** 訊息後半：「· 1,152 格 · 4 片有 12 格被 Poly-Si 擋住 · 3 片沒有這個結構，略過」。 */
  const resultText = (r: StepReport & { changed?: number }) =>
    `${r.changed !== undefined ? ` · ${r.changed.toLocaleString()} 格` : ''}${r.total.blocked ? ` · ${blockedText(r)}` : ''}${
      r.total.skippedSlices ? ` · ${r.total.skippedSlices} 片沒有這個結構，略過` : ''
    }${r.total.fallbackSlices ? ` · ${r.total.fallbackSlices} 片對不到同一個${r.op.kind === 'profile' && Object.values(r.op.gestures ?? {})[0]?.kind === 'node' ? '節點' : '邊'}，用參考片的位置` : ''}`;

  const keepSel = (s: EditState) => setSel((prev) => new Set([...prev].filter((k) => s.L.comps.some((c) => c.key === k))));

  /** 在 Worker 裡從 from 複製出帳簿 owner、重播 ops（含 relabel）；busy 橫條顯示 label。失敗回 null 並提示，不會卡在計算中。 */
  const run = useCallback(
    async (owner: string, from: EditState, ops: Op[], label: string): Promise<{ cur: EditState; buf: SplitBuffers } | null> => {
      setBusy(label);
      running.current = true;
      try {
        const r = await replayIn(owner, from, { ops, matNames, keyCounter: keySeq.current });
        keySeq.current = r.keyCounter;
        const buf: SplitBuffers = { data: r.data, labels: r.labels, diff: r.diff, diffCount: r.diffCount, counts: r.counts };
        return { cur: wrap(owner, buf, r.comps, r.version, from.vol), buf };
      } catch (e) {
        dropOwners([owner]);
        message.error(`計算失敗，這一步沒有套用：${(e as Error)?.message ?? e}`);
        return null;
      } finally {
        setBusy(null);
        running.current = false;
      }
    },
    [matNames, message],
  );

  /**
   * 第一次要改之前：把原始複製進這個 split 的帳簿（主執行緒與 Worker 各一次），之後原地改。
   * 借用中的 split 內容一定是原始（新 split、回到原始、借用中的複本）。
   */
  const own = (sp: Split): Split => {
    if (sp.buf) return sp;
    const o = origRef.current!;
    const oc = origCountsRef.current!;
    const buf: SplitBuffers = { data: o.vol.data.slice(), labels: o.L.labels.slice(), diff: new Uint8Array(o.vol.data.length), diffCount: 0, counts: oc.slice() };
    const version = sidOf(sp.cur);
    void forkIn(sp.id, sp.cur).catch(() => {});
    return { ...sp, buf, cur: wrap(sp.id, buf, sp.cur.L.comps, version, o.vol) };
  };

  /** 一步送 Worker（只在外框裡算），回來後主執行緒原地貼補丁、差量更新 diff 與體積帳。失敗回 null。 */
  const applyOne = async (sp: Split, op: Op) => {
    const from = sp.cur;
    const buf = sp.buf!;
    try {
      const r = await applyIn(from, { op, matNames, keyCounter: keySeq.current });
      keySeq.current = r.keyCounter;
      if (!r.step.data) return { next: null, step: r.step, report: r.report };
      const comps = applyStepInPlace(from.vol, buf.data, buf.labels, r.step, 'fwd');
      buf.diffCount = carryStepStats(from.vol, buf.data, origRef.current!.vol.data, buf.diff, buf.diffCount, buf.counts, r.step, 'fwd');
      const next = wrap(sp.id, buf, comps ?? from.L.comps, r.version, from.vol);
      return { next, step: r.step, report: r.report };
    } catch (e) {
      message.error(`計算失敗，這一步沒有套用：${(e as Error)?.message ?? e}`);
      return null;
    }
  };

  /** 排隊中的一步：接在目前 split 最新的結果後面（從 ref 讀，不用 render 時的舊值）。 */
  const commitOne = async (op: Op) => {
    const o = origRef.current;
    if (!o) return;
    const active = splitsRef.current.find((x) => x.id === activeRef.current) ?? null;
    // 原始保持唯讀：在原始上調整就先開一個新 split（有改到才留下）
    const fresh = !active;
    const sp = own(active ?? { id: newSplitId(), name: '', cur: o, ops: [], hist: [], future: [], buf: null });
    if (active) setSplits((all) => all.map((x) => (x.id === sp.id ? sp : x)));
    const from = sp.cur;
    const r = await applyOne(sp, op);
    if (!r || !r.next) {
      if (fresh) dropOwners([sp.id]);
      if (!r) return;
    }
    const rep: StepReport & { changed: number } = { ...summarize(r.report, op, from.vol), op, changed: changedCount(r.step) };
    setReport(rep);
    if (!r.next) {
      setLast({ text: `${headText(op, from)} · 沒有改到任何體素${rep.total.blocked ? `（${blockedText(rep)}）` : ''}`, at: Date.now() });
      return;
    }
    const next = r.next;
    // 寫進 manifest 的結果摘要（重播時忽略，§11）
    const t = rep.total;
    op = { ...op, report: { filled: t.filled, pushed: t.pushed, blocked: t.blocked, skippedSlices: t.skippedSlices, changed: rep.changed } } as unknown as Op;
    const entry: HistEntry = { step: r.step, ops: sp.ops, version: sidOf(from) };
    if (fresh) {
      const name = `Split ${splitsRef.current.length + 1}`;
      setSplits((all) => [...all, { ...sp, name, cur: next, ops: [op], hist: [entry], future: [] }]);
      setActiveId(sp.id);
      keepSel(next);
      setLast({ text: `原始保持不變，已自動建立 ${name}：${headText(op, o)}${resultText(rep)}`, at: Date.now() });
      return;
    }
    setSplits((all) =>
      all.map((x) => (x.id === sp.id ? { ...x, cur: next, ops: [...x.ops, op], hist: [...x.hist, entry].slice(-HISTORY_LIMIT), future: [] } : x)),
    );
    keepSel(next);
    setLast({ text: `${headText(op, from)}${resultText(rep)}`, at: Date.now() });
  };

  const drain = async () => {
    running.current = true;
    setBusy('計算中…');
    try {
      while (queue.current.length) {
        // 每一步都用最新一次 render 的 commitOne（材質名稱、nm 比例等才是最新的）
        try {
          await latest.current.commitOne(queue.current[0]);
        } finally {
          setStepSeq((n) => n + 1);
        }
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

  /**
   * 所有改體素的路徑都經過 commit：記 Op、可復原、可在別的 split 重播。
   * Worker 忙的時候排隊（最多 QUEUE_MAX 步），依序接在前一步的結果後面；超過就拒絕並提示。
   */
  const enqueue = (op: Op) => {
    if (queue.current.length > QUEUE_MAX) {
      message.warning({ key: 'queue', content: '還在算前面的步驟，請稍等' });
      setStepSeq((n) => n + 1);
      return;
    }
    if (!running.current) previewHook.current?.(op);
    queue.current.push(op);
    setQueued(Math.max(0, queue.current.length - 1));
    if (!running.current) void latest.current.drain();
  };
  /** 這一步大概會動到多少體素（選取外框 ∩ 範圍）。 */
  const opVoxels = (op: Op) => {
    const s = splitsRef.current.find((x) => x.id === activeRef.current)?.cur ?? origRef.current;
    if (!s) return 0;
    const keys = new Set(op.keys);
    const b = unionBBox(s.L.comps.filter((c) => keys.has(c.key)));
    const c = b && clipScopeBox(b, op.scope);
    return c ? boxVoxels(c) : 0;
  };
  const latest = useRef({ enqueue, drain, commitOne });
  latest.current = { enqueue, drain, commitOne };
  const bigRef = useRef(bigOp);
  bigRef.current = bigOp;
  const commit = useCallback(
    (op: Op) => {
      if (!origRef.current) return;
      const n = opVoxels(op);
      if (n > bigRef.current && op.kind !== 'material') {
        const comps = (splitsRef.current.find((x) => x.id === activeRef.current)?.cur ?? origRef.current).L.comps.filter((c) => op.keys.includes(c.key));
        const who = comps.length === 1 ? comps[0].label : `${comps.length} 個結構`;
        modal.confirm({
          title: '這一步範圍很大',
          content: `這一步會改到約 ${Math.round(n / 1e4).toLocaleString()} 萬格（整個 ${who}），可能要幾秒。繼續？`,
          okText: '繼續',
          cancelText: '取消',
          onOk: () => latest.current.enqueue(op),
          // 取消：幾何層回到放開前（當作這一步算完、沒改到）
          onCancel: () => setStepSeq((n) => n + 1),
        });
        return;
      }
      latest.current.enqueue(op);
    },
    // enqueue／drain／commitOne 每次 render 都換新的，經由 latest 取用最新的那一份
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [message, modal],
  );
  // 換選取或換方向時把手失效
  useEffect(() => setHandle(null), [selKey, editAxis]);

  /** 復原／重做的一格：先通知 Worker（它可能要補送改前的內容），再原地貼、差量更新 diff 與體積帳，回傳新的 cur。 */
  const stepInPlace = (act: Split, h: HistEntry, dir: 'fwd' | 'back', o: EditState): EditState => {
    const buf = act.buf!;
    void deriveIn(act.cur, h.version, h.step, dir).catch(() => {});
    const comps = applyStepInPlace(o.vol, buf.data, buf.labels, h.step, dir);
    buf.diffCount = carryStepStats(o.vol, buf.data, o.vol.data, buf.diff, buf.diffCount, buf.counts, h.step, dir);
    return wrap(act.id, buf, comps ?? act.cur.L.comps, h.version, o.vol);
  };

  /** 排隊中按復原：先清掉還沒開始的步驟，正在算的那一步做完再復原它。 */
  const undoAfter = useRef(false);
  const undoRef = useRef<() => void>(() => {});
  const undo = useCallback(() => {
    if (running.current) {
      const dropped = queue.current.length - 1;
      queue.current.length = Math.min(queue.current.length, 1);
      setQueued(0);
      undoAfter.current = true;
      message.info({ key: 'queue', content: dropped > 0 ? `已清掉排隊的 ${dropped} 步，正在算的那一步完成後復原` : '這一步完成後復原' });
      return;
    }
    const act = splitsRef.current.find((x) => x.id === activeRef.current);
    const o = origRef.current;
    if (!act || !act.hist.length || !o || !act.buf) return;
    const h = act.hist[act.hist.length - 1];
    const prev = stepInPlace(act, h, 'back', o);
    setSplits((all) =>
      all.map((x) =>
        x.id === act.id
          ? { ...x, cur: prev, ops: h.ops, hist: x.hist.slice(0, -1), future: [{ step: h.step, ops: x.ops, version: sidOf(x.cur) }, ...x.future] }
          : x,
      ),
    );
    keepSel(prev);
    setReport(null);
    setLast(null);
  }, [message, setSplits]);
  undoRef.current = undo;

  const redo = useCallback(() => {
    if (running.current) return;
    const act = splitsRef.current.find((x) => x.id === activeRef.current);
    const o = origRef.current;
    if (!act || !act.future.length || !o || !act.buf) return;
    const f = act.future[0];
    const next = stepInPlace(act, f, 'fwd', o);
    setSplits((all) =>
      all.map((x) =>
        x.id === act.id
          ? { ...x, cur: next, ops: f.ops, hist: [...x.hist, { step: f.step, ops: x.ops, version: sidOf(x.cur) }].slice(-HISTORY_LIMIT), future: x.future.slice(1) }
          : x,
      ),
    );
    keepSel(next);
    setReport(null);
    setLast(null);
  }, [setSplits]);

  const resetAll = useCallback(() => {
    if (!active || running.current) return;
    // 帳簿釋放，回到借用原始
    dropOwners([active.id]);
    setSplits((all) => all.map((s) => (s.id === active.id ? { ...s, cur: orig, ops: [], hist: [], future: [], buf: null } : s)));
    setReport(null);
    setLast(null);
  }, [active, orig]);

  // ---- split ----

  const addSplit = useCallback(
    async (name?: string, ops: Op[] = []) => {
      if (running.current) return;
      const id = newSplitId();
      const made = ops.length ? await run(id, orig, ops, '重播中…') : { cur: orig, buf: null };
      if (!made) return;
      setSplits((all) => [...all, { id, name: name ?? `Split ${all.length + 1}`, cur: made.cur, buf: made.buf, ops, hist: [], future: [] }]);
      setActiveId(id);
      return id;
    },
    [orig, run],
  );

  const duplicateSplit = useCallback(
    (id: string) => {
      if (running.current) return;
      const src = splitsRef.current.find((s) => s.id === id);
      if (!src) return;
      const nid = newSplitId();
      // 各自一本：有帳簿就複製一份（新版本號，Worker 也 fork 一份），借用中的照樣借用
      let cur = src.cur;
      let buf: SplitBuffers | null = null;
      if (src.buf) {
        buf = { data: src.buf.data.slice(), labels: src.buf.labels.slice(), diff: src.buf.diff.slice(), diffCount: src.buf.diffCount, counts: src.buf.counts.slice() };
        const v = newVersion();
        void forkIn(nid, src.cur, v).catch(() => {});
        cur = wrap(nid, buf, src.cur.L.comps, v, src.cur.vol);
      }
      setSplits((all) => [...all, { ...src, id: nid, name: `${src.name} 複本`, cur, buf, hist: [], future: [] }]);
      setActiveId(nid);
    },
    [],
  );

  const renameSplit = useCallback(
    (id: string, name: string) => setSplits((all) => all.map((s) => (s.id === id ? { ...s, name: name || s.name } : s))),
    [],
  );

  const removeSplit = useCallback(
    (id: string) => {
      if (running.current) return;
      const rest = splitsRef.current.filter((s) => s.id !== id);
      dropOwners([id]);
      setSplits(rest);
      if (activeRef.current === id) setActiveId(rest[0]?.id ?? BASE_ID);
    },
    [],
  );

  /** 一次產生多個 split，接在現有的後面；從原始或接在目前 split 之後。 */
  const addSweep = useCallback(
    async (kind: SweepKind, values: number[], unit: 'nm' | 'vx', nameOf: (v: number) => string, extend: boolean) => {
      if (!sel.size || running.current) return [];
      const keys = [...sel];
      const prefix = extend && active ? active.ops : [];
      const from = extend && active ? active.cur : orig;
      const voxels = values.map((v) => Math.round(unit === 'nm' ? v / nmPerVoxel : v));
      const ops = sweepOps(kind, keys, scope, voxels, follow, backfill);
      const made: Split[] = [];
      for (let i = 0; i < ops.length; i++) {
        const id = newSplitId();
        const r = await run(id, from, [ops[i]], `產生 ${nameOf(values[i])}…`);
        if (!r) break;
        made.push({ id, name: nameOf(values[i]), cur: r.cur, buf: r.buf, ops: [...prefix, ops[i]], hist: [], future: [] });
      }
      if (!made.length) return [];
      setSplits((all) => [...all, ...made]);
      setActiveId(made[0].id);
      setLast({ text: `已產生 ${made.length} 個 split`, at: Date.now() });
      return made.map((s) => s.id);
    },
    [sel, active, orig, scope, nmPerVoxel, follow, backfill, run],
  );

  // ---- 選取 ----

  const selectKeys = useCallback((keys: string[], mode: SelectMode = 'set') => {
    setSel((prev) => {
      if (mode === 'set') return new Set(keys);
      const next = new Set(prev);
      if (mode === 'add') keys.forEach((k) => next.add(k));
      else keys.forEach((k) => (next.has(k) ? next.delete(k) : next.add(k)));
      return next;
    });
  }, []);
  const clearSel = useCallback(() => setSel(new Set()), []);
  const pickVoxel = useCallback(
    (i: number, mode: SelectMode = 'set') => {
      const l = L.labels[i];
      if (l < 0) {
        if (mode === 'set') clearSel();
        return;
      }
      selectKeys([L.comps[l].key], mode);
    },
    [L, selectKeys, clearSel],
  );
  const selectMaterial = useCallback(
    (mat: number, mode: SelectMode = 'set') =>
      selectKeys(
        L.comps.filter((c) => c.mat === mat).map((c) => c.key),
        mode,
      ),
    [L, selectKeys],
  );
  const selectAll = useCallback(
    () => selectKeys(L.comps.filter((c) => !hidden.has(c.mat)).map((c) => c.key)),
    [L, hidden, selectKeys],
  );
  const toggleHidden = useCallback(
    (mat: number) =>
      setHidden((prev) => {
        const next = new Set(prev);
        if (next.has(mat)) next.delete(mat);
        else next.add(mat);
        return next;
      }),
    [],
  );

  // ---- 調整 ----

  const translate = useCallback(
    (d: Vec3, withShell = false) => {
      if (!sel.size || (!d[0] && !d[1] && !d[2])) return;
      commit({ kind: 'translate', keys: [...sel], scope, d, backfill, ...(withShell ? { follow: true } : {}) });
    },
    [sel, scope, backfill, commit],
  );
  const push = useCallback(
    (dir: Vec3, n: number, local?: Local) => {
      if (!sel.size || !n) return;
      commit({ kind: 'push', keys: [...sel], scope, dir, n, follow, backfill, ...(local ? { local } : {}) });
    },
    [sel, scope, follow, backfill, commit],
  );
  const level = useCallback(
    (dir: Vec3, to: number, local: Local) => {
      if (!sel.size) return;
      commit({ kind: 'level', keys: [...sel], scope, dir, to, local, backfill, follow });
    },
    [sel, scope, backfill, follow, commit],
  );
  /** 3D 筆刷的一筆 → Op（即時預覽和正式套用用同一個）；沒選取或 n = 0 回傳 null。 */
  const opFor = useCallback(
    (s: Sculpt): Op | null => {
      if (!sel.size) return null;
      const keys = [...sel];
      if (s.kind === 'level') return { kind: 'level', keys, scope, dir: s.dir, to: s.to, local: s.local, backfill, follow };
      if (!s.n) return null;
      return { kind: 'push', keys, scope, dir: s.dir, n: s.n, follow, backfill, local: s.local };
    },
    [sel, scope, follow, backfill],
  );
  const sculpt = useCallback(
    (s: Sculpt) => {
      const op = opFor(s);
      if (op) commit(op);
    },
    [opFor, commit],
  );
  /**
   * 整個選取沿 dir 補平到最外側那一點：每一排都補到和最高點一樣高（圓頭、斜角變方頭）。
   * 只填空氣與可跟推的襯層，不吃厚的鄰居。回傳目標座標；沒選取回傳 null。
   */
  const levelTarget = useCallback(
    (dir: Vec3) => {
      const b = unionBBox(selComps);
      if (!b) return null;
      const a = dir[0] ? 0 : dir[1] ? 1 : 2;
      const sum = dir[0] + dir[1] + dir[2];
      return sum < 0 ? [b.x0, b.y0, b.z0][a] : [b.x1, b.y1, b.z1][a];
    },
    [selComps],
  );
  const levelWhole = useCallback(
    (dir: Vec3) => {
      const b = unionBBox(selComps);
      const to = levelTarget(dir);
      if (!b || to === null) return;
      const center: Vec3 = [(b.x0 + b.x1) >> 1, (b.y0 + b.y1) >> 1, (b.z0 + b.z1) >> 1];
      commit({ kind: 'level', keys: [...sel], scope, dir, to, local: { center, radius: null }, backfill, follow });
    },
    [selComps, levelTarget, sel, scope, backfill, follow, commit],
  );
  const setMaterial = useCallback(
    (m: number) => {
      if (sel.size) commit({ kind: 'material', keys: [...sel], scope, m });
    },
    [sel, scope, commit],
  );

  // ---- 載入與材質 ----

  /** 載入一個陣列：Worker 標記結構，材質沒給就一律「材質 n」。 */
  const loadVolume = useCallback(async (v: Volume, m: Meta, mats?: Material[]) => {
    if (running.current) return;
    setBusy('分析結構中…');
    running.current = true;
    try {
      const { labels, raw, version, counts: oc } = await loadOrig(v);
      // 每個非 0 編號至少有一塊結構，所以從結構清單就知道有哪些材質
      let table = materialsFor(raw.map((r) => r.mat));
      if (mats) table = table.map((t) => mats.find((x) => x.id === t.id) ?? t);
      setMaterials(table);
      setMeta(m);
      setOrig({ vol: v, L: { labels, comps: nameComponents(raw, matNameOf(table)) }, version, owner: BASE_ID });
      setOrigCounts(oc);
      models.clear();
      keySeq.current = 1000;
      splitSeq.current = 1;
      setSplits([]);
      setActiveId(BASE_ID);
      setSel(new Set());
      setHidden(new Set());
      setLast(null);
      setCustomRange([0, axisLen(v, 'z') - 1]);
      setCursor([v.X >> 1, v.Y >> 1, v.Z >> 1]);
      if (m.spacing) setNmPerVoxel(m.unit === 'um' ? m.spacing[0] * 1000 : m.spacing[0]);
    } finally {
      setBusy(null);
      running.current = false;
    }
  }, []);

  /** 內建範例（只有它自帶名稱表）；scale 放大每一軸。 */
  const demo = useCallback(
    (scale = 1) => loadVolume(demoVolume(scale), { format: 'demo', name: scale > 1 ? `範例 ×${scale}` : undefined }, MATERIALS),
    [loadVolume],
  );

  const renameMaterial = useCallback(
    (id: number, name: string) => {
      if (!name) return;
      const old = matName(id);
      setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)));
      const fixL = (l: Labeled): Labeled => ({
        ...l,
        comps: l.comps.map((c) => (c.mat === id ? { ...c, label: name + c.label.slice(old.length) } : c)),
      });
      const fix = (s: EditState): EditState => ({ ...s, L: fixL(s.L) });
      const fixComps = (comps: Comp[]) => fixL({ labels: new Int32Array(0), comps }).comps;
      const fixEntry = (h: HistEntry): HistEntry =>
        h.step.labels ? { ...h, step: { ...h.step, labels: { ...h.step.labels, compsBefore: fixComps(h.step.labels.compsBefore), compsAfter: fixComps(h.step.labels.compsAfter) } } } : h;
      setOrig((o) => o && fix(o));
      setSplits((all) =>
        all.map((s) => ({
          ...s,
          cur: fix(s.cur),
          hist: s.hist.map(fixEntry),
          future: s.future.map(fixEntry),
        })),
      );
    },
    [matName],
  );

  const setMaterialColor = useCallback(
    (id: number, color: string) => setMaterials((ms) => ms.map((m) => (m.id === id ? { ...m, color } : m))),
    [],
  );

  // ---- 十字 ----

  const stepCursor = useCallback(
    (axis: 'x' | 'y' | 'z', delta: number) =>
      setCursor((c) => {
        const a = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
        const max = axis === 'x' ? vol.X : axis === 'y' ? vol.Y : vol.Z;
        const next: Vec3 = [...c];
        next[a] = Math.max(0, Math.min(max - 1, c[a] + delta));
        return next;
      }),
    [vol],
  );
  const cursorIndex = idx(vol, cursor[0], cursor[1], cursor[2]);
  const voxelCoord = useCallback((i: number) => coordOf(vol, i), [vol]);

  // ---- 鍵盤 ----

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      // Modal／Drawer 開著：Esc 關它、Ctrl+Z 留給輸入框，不動模型
      if (overlayOpen()) return;
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
        selectAll();
        return;
      }
      if (e.key === 'Escape') {
        // 一層一層退：先關選單，再取消選取
        if (menu) setMenu(null);
        else clearSel();
        return;
      }
      if (e.key === '[' || e.key === ']') {
        const ids = [BASE_ID, ...splits.map((s) => s.id)];
        const at = ids.indexOf(activeId);
        setActiveId(ids[(at + (e.key === ']' ? 1 : ids.length - 1)) % ids.length]);
        return;
      }
      // 焦點在按鈕、滑桿、分頁等控制項上時，方向鍵留給它們，不動模型
      const ae = document.activeElement as HTMLElement | null;
      const onControl =
        !!ae && ae !== document.body && !!ae.closest('button,a,[role=slider],[role=radio],[role=tab],[role=switch],[role=menuitem],[role=option],.ant-select,.ant-segmented');
      if (onControl) return;
      const step = e.shiftKey ? 10 : 1;
      const moves: Record<string, Vec3> = {
        ArrowLeft: [-step, 0, 0],
        ArrowRight: [step, 0, 0],
        ArrowUp: [0, -step, 0],
        ArrowDown: [0, step, 0],
        PageUp: [0, 0, -step],
        PageDown: [0, 0, step],
      };
      if (moves[e.key] && sel.size) {
        e.preventDefault();
        translate(moves[e.key]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selectAll, clearSel, translate, sel.size, splits, activeId, menu]);

  return {
    ready,
    materials,
    matName,
    meta,
    cur,
    vol,
    orig,
    L,
    comps: L.comps,
    compByKey,
    origByKey,
    hist,
    future,
    undo,
    redo,
    resetAll,
    busy,
    splits,
    activeId,
    setActiveId,
    active,
    isBase,
    addSplit,
    duplicateSplit,
    renameSplit,
    removeSplit,
    addSweep,
    opText: describe,
    sel,
    selComps,
    selIdx,
    selMask,
    affMask,
    selCount,
    selectKeys,
    clearSel,
    pickVoxel,
    selectMaterial,
    selectAll,
    hidden,
    toggleHidden,
    cursor,
    setCursor,
    stepCursor,
    cursorIndex,
    voxelCoord,
    commit,
    report,
    setReport,
    models,
    stepSeq,
    version: sidOf(cur),
    outlineStyle,
    setOutlineStyle,
    snapMode,
    setSnapMode,
    handle,
    setHandle,
    mirror,
    setMirror,
    bigOp,
    setBigOp,
    queued,
    scope,
    scopeMode,
    setScopeMode,
    editAxis,
    setEditAxis,
    customRange,
    setCustom,
    selBox,
    selRange,
    sculpt3d,
    setSculpt3d,
    autoZoom,
    setAutoZoom,
    follow,
    setFollow,
    backfill,
    setBackfill,
    nmPerVoxel,
    setNmPerVoxel,
    brush,
    setBrush,
    diff,
    changedKeys,
    ledger,
    last,
    setLast,
    menu,
    setMenu,
    translate,
    push,
    level,
    opFor,
    sculpt,
    levelTarget,
    levelWhole,
    previewHook,
    setMaterial,
    loadVolume,
    demo,
    renameMaterial,
    setMaterialColor,
  };
}

export type Editor = ReturnType<typeof useEditor>;

/** 每個 split 和原始的 diff（並排比較、總表用）：直接讀帳簿（§4.4）。 */
export function useSplitDiffs(ed: Editor) {
  const { splits } = ed;
  return useMemo(() => new Map<string, Diff>(splits.map((s) => [s.id, splitDiff(s)])), [splits]);
}
