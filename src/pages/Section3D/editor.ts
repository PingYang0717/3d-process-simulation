import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type Backfill,
  type Labeled,
  type Material,
  type Vec3,
  type Volume,
  type ZRange,
  MATERIALS,
  coordOf,
  demoVolume,
  idx,
  maskOf,
  materialsFor,
  nameComponents,
} from '../../volume/volume';
import { type EditState, type Local, type Op, type SweepKind, matNameOf, opText, sweepOps } from '../../volume/ops';
import type { BrushShape } from '../../volume/volume';

/** 3D 筆刷：推拉（沿法線長／縮 n 格）或補平（補到／削到點到的那一面）；半徑 null = 整面。 */
export interface Brush {
  mode: 'push' | 'level';
  radius: number | null;
  shape: BrushShape;
}
import { call, ensure, loadOrig, replayIn, retain } from '../../volume/client';

export { type EditState, type Op, type SweepKind, applyOp, matNameOf, opText, replay, sweepOps } from '../../volume/ops';

export interface Snapshot {
  snap: EditState;
  ops: Op[];
}

export interface Split {
  id: string;
  name: string;
  ops: Op[];
  cur: EditState;
  hist: Snapshot[];
  future: Snapshot[];
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
/** 每個 split 留幾步 Undo（大陣列一步就是幾十 MB）。 */
const HISTORY_LIMIT = 10;
const EMPTY: EditState = { vol: { X: 1, Y: 1, Z: 1, data: new Uint8Array(1) }, L: { labels: new Int32Array([-1]), comps: [] } };

// diff 與各材質體積依體素陣列快取：同一個 split 的結果不重算
const diffCache = new WeakMap<Uint8Array, Promise<Diff>>();
const countCache = new WeakMap<Uint8Array, Promise<number[]>>();
const countOf = (s: EditState) => {
  let p = countCache.get(s.vol.data);
  if (!p) {
    p = call('count', { sid: ensure(s) });
    countCache.set(s.vol.data, p);
  }
  return p;
};

// ---- useEditor ----

export type SelectMode = 'set' | 'add' | 'toggle';
export const selectModeOf = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode =>
  e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set';

export interface MenuState {
  x: number;
  y: number;
  key: string | null;
}

export function useEditor() {
  const [materials, setMaterials] = useState<Material[]>([]);
  const [meta, setMeta] = useState<Meta>({ format: 'demo' });
  const [origState, setOrig] = useState<EditState | null>(null);
  // 一開始只有「原始」；第一次在原始上調整會自動建立 Split 1
  const [splits, setSplits] = useState<Split[]>([]);
  const [activeId, setActiveId] = useState(BASE_ID);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  const [zRange, setZRangeRaw] = useState<ZRange>([0, 0]);
  const [follow, setFollow] = useState(true);
  const [backfill, setBackfill] = useState<Backfill>('orig');
  const [nmPerVoxel, setNmPerVoxel] = useState(0.5);
  const [brush, setBrush] = useState<Brush>({ mode: 'push', radius: 6, shape: 'round' });
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 計算中的說明（例如「計算中…」）；有值時其他改體素的動作先擋下。 */
  const [busy, setBusy] = useState<string | null>(null);
  const [diff, setDiff] = useState<Diff>({ mask: new Uint8Array(0), count: 0 });
  const [counts, setCounts] = useState<{ before: number[]; after: number[] } | null>(null);
  const keySeq = useRef(1000);
  const splitSeq = useRef(1);
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
  /** 選取 ∩ z 範圍：所見即會被改。 */
  const affMask = useMemo(() => {
    if (!selMask) return null;
    if (zRange[0] === 0 && zRange[1] === vol.Z - 1) return selMask;
    const out = new Uint8Array(selMask.length);
    const plane = vol.X * vol.Y;
    out.set(selMask.subarray(zRange[0] * plane, (zRange[1] + 1) * plane), zRange[0] * plane);
    return out;
  }, [selMask, zRange, vol]);
  const selCount = useMemo(() => selComps.reduce((s, c) => s + c.count, 0), [selComps]);

  /** 和原始逐體素比對（Worker），依陣列快取。 */
  const diffOf = useCallback(
    (s: EditState): Promise<Diff> => {
      const v = s.vol;
      if (v.data === orig.vol.data) return Promise.resolve({ mask: new Uint8Array(v.data.length), count: 0 });
      let p = diffCache.get(v.data);
      if (!p) {
        p = call('diff', { sid: ensure(s) });
        diffCache.set(v.data, p);
      }
      return p;
    },
    [orig],
  );

  // Worker 只留原始與每個 split 目前的結果；復原用的舊步驟要用時再補送
  useEffect(() => {
    if (origState) retain([origState, ...splits.map((s) => s.cur)]);
  }, [origState, splits]);

  // 目前 split 的 diff 與各材質體積
  useEffect(() => {
    if (!origState) return;
    let alive = true;
    (async () => {
      // 三個請求一次送出（之後才發現過期也不會再補送陣列）
      const [d, before, after] = await Promise.all([diffOf(cur), countOf(origState), countOf(cur)]);
      if (!alive) return;
      setDiff(d);
      setCounts({ before, after });
    })();
    return () => {
      alive = false;
    };
  }, [cur, origState, diffOf]);

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

  const setZRange = useCallback(
    (r: ZRange) => setZRangeRaw([Math.max(0, Math.min(r[0], r[1])), Math.min(vol.Z - 1, Math.max(r[0], r[1]))]),
    [vol.Z],
  );

  const describe = useCallback(
    (op: Op, at: Labeled) => opText(op, at, vol.Z, nmPerVoxel, matName),
    [vol.Z, nmPerVoxel, matName],
  );

  const keepSel = (s: EditState) => setSel((prev) => new Set([...prev].filter((k) => s.L.comps.some((c) => c.key === k))));

  /** 在 Worker 裡從 from 重播 ops（含 relabel）；busy 橫條顯示 label。 */
  const run = useCallback(
    async (from: EditState, ops: Op[], label: string): Promise<EditState> => {
      setBusy(label);
      running.current = true;
      try {
        const r = await replayIn(from, { ops, matNames, keyCounter: keySeq.current });
        keySeq.current = r.keyCounter;
        const next: EditState = { vol: { X: from.vol.X, Y: from.vol.Y, Z: from.vol.Z, data: r.data }, L: { labels: r.labels, comps: r.comps } };
        // 先排 diff 與計數，讓「改動」數字比重畫 3D 早出來
        diffOf(next);
        countOf(next);
        return next;
      } finally {
        setBusy(null);
        running.current = false;
      }
    },
    [orig, matNames, diffOf],
  );

  /** 所有改體素的路徑都經過 commit：記 Op、可復原、可在別的 split 重播。 */
  const commit = useCallback(
    async (op: Op) => {
      if (!origState || running.current) return;
      if (!active) {
        // 原始保持唯讀：自動開一個新 split 來放這一步，復原可回到原始
        const next = await run(orig, [op], '計算中…');
        const id = newSplitId();
        const name = `Split ${splits.length + 1}`;
        setSplits((all) => [...all, { id, name, cur: next, ops: [op], hist: [{ snap: orig, ops: [] }], future: [] }]);
        setActiveId(id);
        keepSel(next);
        setLast({ text: `原始保持不變，已自動建立 ${name}：${describe(op, orig.L)}`, at: Date.now() });
        return;
      }
      const next = await run(active.cur, [op], '計算中…');
      setSplits((all) =>
        all.map((s) =>
          s.id === active.id
            ? {
                ...s,
                cur: next,
                ops: [...s.ops, op],
                hist: [...s.hist.slice(-HISTORY_LIMIT), { snap: s.cur, ops: s.ops }],
                future: [],
              }
            : s,
        ),
      );
      keepSel(next);
      setLast({ text: describe(op, active.cur.L), at: Date.now() });
    },
    [origState, active, orig, splits.length, run, describe],
  );

  const undo = useCallback(() => {
    if (!active || !active.hist.length || running.current) return;
    const h = active.hist[active.hist.length - 1];
    setSplits((all) =>
      all.map((s) =>
        s.id === active.id
          ? {
              ...s,
              cur: h.snap,
              ops: h.ops,
              hist: s.hist.slice(0, -1),
              future: [{ snap: s.cur, ops: s.ops }, ...s.future],
            }
          : s,
      ),
    );
    keepSel(h.snap);
    setLast(null);
  }, [active]);

  const redo = useCallback(() => {
    if (!active || !active.future.length || running.current) return;
    const f = active.future[0];
    setSplits((all) =>
      all.map((s) =>
        s.id === active.id
          ? { ...s, cur: f.snap, ops: f.ops, hist: [...s.hist, { snap: s.cur, ops: s.ops }], future: s.future.slice(1) }
          : s,
      ),
    );
    keepSel(f.snap);
    setLast(null);
  }, [active]);

  const resetAll = useCallback(() => {
    if (!active || running.current) return;
    setSplits((all) => all.map((s) => (s.id === active.id ? { ...s, cur: orig, ops: [], hist: [], future: [] } : s)));
    setLast(null);
  }, [active, orig]);

  // ---- split ----

  const addSplit = useCallback(
    async (name?: string, ops: Op[] = []) => {
      if (running.current) return;
      const state = ops.length ? await run(orig, ops, '重播中…') : orig;
      const id = newSplitId();
      setSplits((all) => [...all, { id, name: name ?? `Split ${all.length + 1}`, cur: state, ops, hist: [], future: [] }]);
      setActiveId(id);
      return id;
    },
    [orig, run],
  );

  const duplicateSplit = useCallback(
    (id: string) => {
      const src = splits.find((s) => s.id === id);
      if (!src) return;
      const nid = newSplitId();
      setSplits((all) => [...all, { ...src, id: nid, name: `${src.name} 複本`, hist: [], future: [] }]);
      setActiveId(nid);
    },
    [splits],
  );

  const renameSplit = useCallback(
    (id: string, name: string) => setSplits((all) => all.map((s) => (s.id === id ? { ...s, name: name || s.name } : s))),
    [],
  );

  const removeSplit = useCallback(
    (id: string) => {
      const rest = splits.filter((s) => s.id !== id);
      setSplits(rest);
      if (activeId === id) setActiveId(rest[0]?.id ?? BASE_ID);
    },
    [splits, activeId],
  );

  /** 一次產生多個 split，接在現有的後面；從原始或接在目前 split 之後。 */
  const addSweep = useCallback(
    async (kind: SweepKind, values: number[], unit: 'nm' | 'vx', nameOf: (v: number) => string, extend: boolean) => {
      if (!sel.size || running.current) return [];
      const keys = [...sel];
      const prefix = extend && active ? active.ops : [];
      const from = extend && active ? active.cur : orig;
      const voxels = values.map((v) => Math.round(unit === 'nm' ? v / nmPerVoxel : v));
      const ops = sweepOps(kind, keys, zRange, voxels, follow, backfill);
      const made: Split[] = [];
      for (let i = 0; i < ops.length; i++) {
        const cur = await run(from, [ops[i]], `產生 ${nameOf(values[i])}…`);
        made.push({ id: newSplitId(), name: nameOf(values[i]), cur, ops: [...prefix, ops[i]], hist: [], future: [] });
      }
      setSplits((all) => [...all, ...made]);
      setActiveId(made[0].id);
      setLast({ text: `已產生 ${made.length} 個 split`, at: Date.now() });
      return made.map((s) => s.id);
    },
    [sel, active, orig, zRange, nmPerVoxel, follow, backfill, run],
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
    (d: Vec3) => {
      if (!sel.size || (!d[0] && !d[1] && !d[2])) return;
      commit({ kind: 'translate', keys: [...sel], zRange, d, backfill });
    },
    [sel, zRange, backfill, commit],
  );
  const push = useCallback(
    (dir: Vec3, n: number, local?: Local) => {
      if (!sel.size || !n) return;
      commit({ kind: 'push', keys: [...sel], zRange, dir, n, follow, backfill, ...(local ? { local } : {}) });
    },
    [sel, zRange, follow, backfill, commit],
  );
  const level = useCallback(
    (dir: Vec3, to: number, local: Local) => {
      if (!sel.size) return;
      commit({ kind: 'level', keys: [...sel], zRange, dir, to, local, backfill });
    },
    [sel, zRange, backfill, commit],
  );
  const setMaterial = useCallback(
    (m: number) => {
      if (sel.size) commit({ kind: 'material', keys: [...sel], zRange, m });
    },
    [sel, zRange, commit],
  );

  // ---- 載入與材質 ----

  /** 載入一個陣列：Worker 標記結構，材質沒給就一律「材質 n」。 */
  const loadVolume = useCallback(async (v: Volume, m: Meta, mats?: Material[]) => {
    if (running.current) return;
    setBusy('分析結構中…');
    running.current = true;
    try {
      const { labels, raw } = await loadOrig(v);
      // 每個非 0 編號至少有一塊結構，所以從結構清單就知道有哪些材質
      let table = materialsFor(raw.map((r) => r.mat));
      if (mats) table = table.map((t) => mats.find((x) => x.id === t.id) ?? t);
      setMaterials(table);
      setMeta(m);
      setOrig({ vol: v, L: { labels, comps: nameComponents(raw, matNameOf(table)) } });
      keySeq.current = 1000;
      splitSeq.current = 1;
      setSplits([]);
      setActiveId(BASE_ID);
      setSel(new Set());
      setHidden(new Set());
      setLast(null);
      setZRangeRaw([0, v.Z - 1]);
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
      setOrig((o) => o && fix(o));
      setSplits((all) =>
        all.map((s) => ({
          ...s,
          cur: fix(s.cur),
          hist: s.hist.map((h) => ({ ...h, snap: fix(h.snap) })),
          future: s.future.map((h) => ({ ...h, snap: fix(h.snap) })),
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
      if ((e.target as HTMLElement | null)?.closest?.('input,select,textarea,[contenteditable]')) return;
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
        setMenu(null);
        clearSel();
        return;
      }
      if (e.key === '[' || e.key === ']') {
        const ids = [BASE_ID, ...splits.map((s) => s.id)];
        const at = ids.indexOf(activeId);
        setActiveId(ids[(at + (e.key === ']' ? 1 : ids.length - 1)) % ids.length]);
        return;
      }
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
  }, [undo, redo, selectAll, clearSel, translate, sel.size, splits, activeId]);

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
    diffOf,
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
    zRange,
    setZRange,
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
    setMaterial,
    loadVolume,
    demo,
    renameMaterial,
    setMaterialColor,
  };
}

export type Editor = ReturnType<typeof useEditor>;

/** 每個 split 和原始的 diff（並排比較、總表用），非同步算好後回傳。 */
export function useSplitDiffs(ed: Editor) {
  const [out, setOut] = useState<Map<string, Diff>>(new Map());
  const { splits, diffOf } = ed;
  useEffect(() => {
    let alive = true;
    Promise.all(splits.map((s) => diffOf(s.cur))).then((ds) => {
      if (alive) setOut(new Map(splits.map((s, i) => [s.id, ds[i]])));
    });
    return () => {
      alive = false;
    };
  }, [splits, diffOf]);
  return out;
}
