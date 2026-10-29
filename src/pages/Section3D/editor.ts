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
  diffMask,
  directionName,
  growMask,
  idx,
  initialLabeled,
  maskOf,
  materialCounts,
  materialsFor,
  relabel,
  setMaskMaterial,
  translateMask,
} from '../../volume/volume';

// ---- 操作與 split（純函式，可單獨測試） ----

export type Op =
  | { kind: 'push'; keys: string[]; zRange: ZRange; dir: Vec3; n: number; follow: boolean; backfill: Backfill }
  | { kind: 'translate'; keys: string[]; zRange: ZRange; d: Vec3; backfill: Backfill }
  | { kind: 'material'; keys: string[]; zRange: ZRange; m: number };

export interface EditState {
  vol: Volume;
  L: Labeled;
}

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

export interface OpContext {
  orig: Volume;
  matName: (id: number) => string;
  newKey: () => string;
}

export const BASE_ID = 'base';
const HISTORY_LIMIT = 30;

export const matNameOf = (materials: Material[]) => (id: number) =>
  materials.find((m) => m.id === id)?.name ?? `材質 ${id}`;

export function applyOp(s: EditState, op: Op, ctx: OpContext): EditState {
  const mask = maskOf(s.L, new Set(op.keys));
  if (!mask) return s;
  let vol: Volume;
  let shift: Vec3 = [0, 0, 0];
  if (op.kind === 'push') vol = growMask(s.vol, ctx.orig, mask, op.zRange, op.dir, op.n, op.backfill, op.follow);
  else if (op.kind === 'translate') {
    vol = translateMask(s.vol, ctx.orig, mask, op.zRange, op.d, op.backfill);
    shift = op.d;
  } else vol = setMaskMaterial(s.vol, mask, op.zRange, op.m);
  return { vol, L: relabel(s.vol, s.L, mask, shift, vol, ctx.matName, ctx.newKey) };
}

/** 從原始重播一串操作。 */
export const replay = (base: EditState, ops: Op[], ctx: OpContext) => ops.reduce((s, op) => applyOp(s, op, ctx), base);

/** 操作的白話描述，例如「Poly-Si ×3 往上長 2 vx（1.0 nm）」。 */
export function opText(op: Op, L: Labeled, Z: number, nmPerVoxel: number, matName: (id: number) => string) {
  const comps = op.keys.map((k) => L.comps.find((c) => c.key === k)).filter((c) => !!c);
  const mats = new Set(comps.map((c) => c.mat));
  const who =
    comps.length === 1
      ? comps[0].label
      : mats.size === 1 && comps.length
        ? `${matName([...mats][0])} ×${comps.length}`
        : `${op.keys.length} 個結構`;
  const part = op.zRange[0] === 0 && op.zRange[1] === Z - 1 ? '' : `（z ${op.zRange[0]}～${op.zRange[1]}）`;
  if (op.kind === 'push') {
    const n = Math.abs(op.n);
    return `${who}${part} ${directionName(op.dir)}${op.n > 0 ? '長' : '縮'} ${n} vx（${(n * nmPerVoxel).toFixed(1)} nm）`;
  }
  if (op.kind === 'translate') {
    const parts = ['x', 'y', 'z']
      .map((a, i) => (op.d[i] ? `${a}${op.d[i] > 0 ? '+' : ''}${op.d[i]}` : ''))
      .filter(Boolean)
      .join(' ');
    return `${who}${part} 移動 ${parts}`;
  }
  return `${who}${part} 換成 ${matName(op.m)}`;
}

export type SweepKind = { kind: 'push'; dir: Vec3 } | { kind: 'translate'; axis: 0 | 1 | 2 };

/** 掃描：同一個操作、不同數值，每個數值一個 op。 */
export function sweepOps(
  kind: SweepKind,
  keys: string[],
  zRange: ZRange,
  voxels: number[],
  follow: boolean,
  backfill: Backfill,
): Op[] {
  return voxels.map((n) =>
    kind.kind === 'push'
      ? { kind: 'push', keys, zRange, dir: kind.dir, n, follow, backfill }
      : {
          kind: 'translate',
          keys,
          zRange,
          d: [kind.axis === 0 ? n : 0, kind.axis === 1 ? n : 0, kind.axis === 2 ? n : 0],
          backfill,
        },
  );
}

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
  const [materials, setMaterials] = useState<Material[]>(MATERIALS);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [orig, setOrig] = useState<EditState>(() => {
    const vol = demoVolume();
    return { vol, L: initialLabeled(vol, matNameOf(MATERIALS)) };
  });
  // 一開始只有「原始」；第一次在原始上調整會自動建立 Split 1
  const [splits, setSplits] = useState<Split[]>([]);
  const [activeId, setActiveId] = useState(BASE_ID);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [cursor, setCursor] = useState<Vec3>([80, 50, 64]);
  const [zRange, setZRangeRaw] = useState<ZRange>([0, 127]);
  const [follow, setFollow] = useState(true);
  const [backfill, setBackfill] = useState<Backfill>('orig');
  const [nmPerVoxel, setNmPerVoxel] = useState(0.5);
  const [last, setLast] = useState<{ text: string; at: number } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const keySeq = useRef(1000);
  const splitSeq = useRef(1);
  const newKey = useCallback(() => `c${keySeq.current++}`, []);
  const newSplitId = () => `s${splitSeq.current++}`;

  const isBase = activeId === BASE_ID;
  const active = splits.find((s) => s.id === activeId) ?? null;
  const cur = active ? active.cur : orig;
  const vol = cur.vol;
  const L = cur.L;
  const hist = active?.hist ?? [];
  const future = active?.future ?? [];

  const matName = useMemo(() => matNameOf(materials), [materials]);
  const ctx = useMemo<OpContext>(() => ({ orig: orig.vol, matName, newKey }), [orig, matName, newKey]);
  const compByKey = useMemo(() => new Map(L.comps.map((c) => [c.key, c])), [L]);
  const origByKey = useMemo(() => new Map(orig.L.comps.map((c) => [c.key, c])), [orig]);
  const selComps = useMemo(() => L.comps.filter((c) => sel.has(c.key)), [L, sel]);
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

  const diffOf = useCallback((v: Volume) => diffMask(v, orig.vol), [orig]);
  const diff = useMemo(() => diffOf(vol), [vol, diffOf]);
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
    const before = materialCounts(orig.vol);
    const after = materialCounts(vol);
    return [...new Set([...before.keys(), ...after.keys()])]
      .sort((a, b) => a - b)
      .map((id) => ({ id, name: matName(id), before: before.get(id) ?? 0, after: after.get(id) ?? 0 }));
  }, [vol, orig, matName]);

  const setZRange = useCallback(
    (r: ZRange) => setZRangeRaw([Math.max(0, Math.min(r[0], r[1])), Math.min(vol.Z - 1, Math.max(r[0], r[1]))]),
    [vol.Z],
  );

  const describe = useCallback(
    (op: Op, at: Labeled) => opText(op, at, vol.Z, nmPerVoxel, matName),
    [vol.Z, nmPerVoxel, matName],
  );

  const keepSel = (s: EditState) => setSel((prev) => new Set([...prev].filter((k) => s.L.comps.some((c) => c.key === k))));

  /** 所有改體素的路徑都經過 commit：記 Op、可復原、可在別的 split 重播。 */
  const commit = useCallback(
    (op: Op) => {
      if (!active) {
        // 原始保持唯讀：自動開一個新 split 來放這一步，復原可回到原始
        const next = applyOp(orig, op, ctx);
        const id = newSplitId();
        const name = `Split ${splits.length + 1}`;
        setSplits((all) => [...all, { id, name, cur: next, ops: [op], hist: [{ snap: orig, ops: [] }], future: [] }]);
        setActiveId(id);
        keepSel(next);
        setLast({ text: `原始保持不變，已自動建立 ${name}：${describe(op, orig.L)}`, at: Date.now() });
        return;
      }
      const next = applyOp(active.cur, op, ctx);
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
    [active, orig, splits.length, ctx, describe],
  );

  const undo = useCallback(() => {
    if (!active || !active.hist.length) return;
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
    if (!active || !active.future.length) return;
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
    if (!active) return;
    setSplits((all) => all.map((s) => (s.id === active.id ? { ...s, cur: orig, ops: [], hist: [], future: [] } : s)));
    setLast(null);
  }, [active, orig]);

  // ---- split ----

  const addSplit = useCallback(
    (name?: string, ops: Op[] = []) => {
      const id = newSplitId();
      const state = ops.length ? replay(orig, ops, ctx) : orig;
      setSplits((all) => [...all, { id, name: name ?? `Split ${all.length + 1}`, cur: state, ops, hist: [], future: [] }]);
      setActiveId(id);
      return id;
    },
    [orig, ctx],
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

  /** 一次產生多個 split，接在現有的後面。 */
  const addSweep = useCallback(
    (kind: SweepKind, values: number[], unit: 'nm' | 'vx', nameOf: (v: number) => string, extend: boolean) => {
      if (!sel.size) return [];
      const keys = [...sel];
      const prefix = extend && active ? active.ops : [];
      const voxels = values.map((v) => Math.round(unit === 'nm' ? v / nmPerVoxel : v));
      const ops = sweepOps(kind, keys, zRange, voxels, follow, backfill);
      const made: Split[] = ops.map((op, i) => {
        const all = [...prefix, op];
        return { id: newSplitId(), name: nameOf(values[i]), cur: replay(orig, all, ctx), ops: all, hist: [], future: [] };
      });
      setSplits((all) => [...all, ...made]);
      setActiveId(made[0].id);
      setLast({ text: `已產生 ${made.length} 個 split`, at: Date.now() });
      return made.map((s) => s.id);
    },
    [sel, active, zRange, nmPerVoxel, follow, backfill, orig, ctx],
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
    (dir: Vec3, n: number) => {
      if (!sel.size || !n) return;
      commit({ kind: 'push', keys: [...sel], zRange, dir, n, follow, backfill });
    },
    [sel, zRange, follow, backfill, commit],
  );
  const setMaterial = useCallback(
    (m: number) => {
      if (sel.size) commit({ kind: 'material', keys: [...sel], zRange, m });
    },
    [sel, zRange, commit],
  );

  // ---- 載入與材質 ----

  const loadVolume = useCallback((v: Volume, name?: string) => {
    const mats = materialsFor(v);
    setMaterials(mats);
    const state = { vol: v, L: initialLabeled(v, matNameOf(mats)) };
    setOrig(state);
    splitSeq.current = 1;
    setSplits([]);
    setActiveId(BASE_ID);
    setSel(new Set());
    setHidden(new Set());
    setLast(null);
    setZRangeRaw([0, v.Z - 1]);
    setCursor([v.X >> 1, v.Y >> 1, v.Z >> 1]);
    setSource(name);
  }, []);

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
      setOrig(fix);
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
    materials,
    setMaterials,
    matName,
    source,
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
    diff,
    changedKeys,
    ledger,
    last,
    setLast,
    menu,
    setMenu,
    translate,
    push,
    setMaterial,
    loadVolume,
    renameMaterial,
  };
}

export type Editor = ReturnType<typeof useEditor>;
