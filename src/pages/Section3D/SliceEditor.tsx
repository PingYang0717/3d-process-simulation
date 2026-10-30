import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { AimOutlined, ExpandOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Backfill, type Labeled, type Material, type Vec3, type Volume, hexToRgb } from '../../volume/volume';
import type { Preview } from '../../volume/preview';
import type { Op } from '../../volume/ops';
import { type Scope, axisIndex, axisLen, planeAxes, to3D } from '../../volume/scope';
import { type Ring, type XY, traceRings } from '../../slice/trace';
import { editRing } from '../../slice/raster';
import { type GestureCtx, type Handle, type HandleKind, dragDisp, edgeAmount, gestureToOp, groupNormal, hitTest, smoothEdgeGroup, uvWord } from '../../slice/gestures';
import { type SelectMode, selectModeOf } from './editor';
import { drawSlice } from './views';
import { typingIn } from '../../ui/persist';

/** 選到的把手（節點／邊）：右欄數值輸入、方向鍵用。 */
export type PickedHandle = Handle & { axis: Axis; at: number; p: XY };

/** 手勢要的設定（editor 給）。 */
export interface GestureOpts {
  scope: Scope;
  follow: boolean;
  backfill: Backfill;
  nm: number;
}

/** 一片上已選結構的環：每個 key 一組（含使用者刪掉／加的節點）。 */
export function sliceRings(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[], edits?: { del: Set<string>; add: Set<string> }) {
  const out = new Map<string, Ring[]>();
  const a = axisIndex(axis);
  const [ua, va] = planeAxes(axis);
  const dims = [vol.X, vol.Y, vol.Z];
  for (const key of keys) {
    const k = L.comps.findIndex((c) => c.key === key);
    if (k < 0) continue;
    const b = L.comps[k].bbox;
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    if (at < lo[a] || at > hi[a]) continue;
    const inside = (u: number, v: number) => {
      if (u < 0 || v < 0 || u >= dims[ua] || v >= dims[va]) return false;
      const p = to3D(axis, u, v, at);
      return L.labels[(p[2] * vol.Y + p[1]) * vol.X + p[0]] === k;
    };
    const rings = traceRings(inside, lo[ua], lo[va], hi[ua], hi[va]);
    if (!rings.length) continue;
    if (edits) for (const r of rings) applyNodeEdits(r, key, edits);
    out.set(key, rings);
  }
  return out;
}

/** 使用者刪掉的節點不再當把手；雙擊邊加的節點插進環裡（形狀不變）。 */
function applyNodeEdits(r: Ring, key: string, e: { del: Set<string>; add: Set<string> }) {
  r.pts.forEach((p, i) => {
    if (e.del.has(`${key}|${p[0]},${p[1]}`)) r.nodes.delete(i);
  });
  for (const tag of e.add) {
    const [k, rest] = tag.split('|');
    if (k !== key) continue;
    const [u, v] = rest.split(',').map(Number);
    for (let i = 0; i < r.raw.length; i++) {
      const j = r.raw[i].findIndex((q, n) => n > 0 && n < r.raw[i].length - 1 && q[0] === u && q[1] === v);
      if (j < 0) continue;
      const seg = r.raw[i];
      r.raw.splice(i, 1, seg.slice(0, j + 1), seg.slice(j));
      r.pts.splice(i + 1, 0, [u, v]);
      const nodes = [...r.nodes].map((n) => (n > i ? n + 1 : n));
      r.nodes = new Set([...nodes, i + 1]);
      break;
    }
  }
}

/** 縮放＝每個 voxel 幾個 CSS px。 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 32;
const CLICK_PX = 4;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface ViewXf {
  zoom: number;
  tx: number;
  ty: number;
}
/** 每個方向上次的縮放與位置（這個 session 裡記住；回 3D 再進來還原）。 */
const memory = new Map<Axis, ViewXf>();

/** 切面上的 (u, v) 對應哪兩個體素軸：XY 正面 u=x v=y；XZ 上視 u=x v=z；YZ 側面 u=z v=y。 */
export const planeDims = (vol: Volume, axis: Axis): [number, number] => (axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y]);
export const toPlane = (axis: Axis, p: Vec3): [number, number] => (axis === 'z' ? [p[0], p[1]] : axis === 'y' ? [p[0], p[2]] : [p[2], p[1]]);
const boxInPlane = (axis: Axis, b: BBox) => {
  const [u0, v0] = toPlane(axis, [b.x0, b.y0, b.z0]);
  const [u1, v1] = toPlane(axis, [b.x1, b.y1, b.z1]);
  return { u0, v0, u1, v1 };
};

/**
 * 主切面（2D 編輯狀態）：滾輪朝游標縮放、右鍵／中鍵／空白鍵＋左鍵／Alt＋左鍵拖＝平移、雙擊空白＝適合視窗、
 * Ctrl＋滾輪換片。左鍵點一下＝選取（Shift 加選、Ctrl 切換）。底圖和下方小切面同一個 drawSlice。
 */
export function SliceEditor({
  vol,
  axis,
  at,
  materials,
  hidden,
  selMask,
  cursor,
  scope,
  diff,
  preview,
  selBox,
  focusKey,
  autoZoom,
  onPick,
  onStep,
  onHover,
  L,
  selKeys,
  gesture,
  onCommit,
  onLive,
  blocked,
  handle,
  setHandle,
  onDragState,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  materials: Material[];
  hidden: Set<number>;
  /** 選取 ∩ 範圍（混藍）。 */
  selMask: Uint8Array | null;
  cursor: Vec3;
  scope: Scope | null;
  diff: Uint8Array | null;
  preview?: Preview | null;
  /** 選取外框（對準選取、自動放大用）。 */
  selBox: BBox | null;
  /** 選取改變時換值（自動放大的觸發）。 */
  focusKey: string;
  autoZoom: boolean;
  onPick: (p: Vec3, mode: SelectMode) => void;
  onStep: (delta: number) => void;
  onHover?: (p: Vec3 | null) => void;
  /** 結構標記（描輪廓用）。 */
  L?: Labeled;
  /** 已選結構（描它們的輪廓、可以拖）。 */
  selKeys?: string[];
  gesture?: GestureOpts;
  /** 放開＝一步。 */
  onCommit?: (op: Op) => void;
  /** 拖動中：即時預覽（null = 收掉）。 */
  onLive?: (op: Op | null) => void;
  /** 上一步被擋住的格子（整個陣列的 index），這一片的標紅。 */
  blocked?: number[] | null;
  handle?: PickedHandle | null;
  setHandle?: (h: PickedHandle | null) => void;
  onDragState?: (dragging: boolean) => void;
}) {
  const [W, H] = planeDims(vol, axis);
  const hostRef = useRef<HTMLDivElement>(null);
  // ---- 輪廓與手勢 ----
  const [nodeEdits, setNodeEdits] = useState({ del: new Set<string>(), add: new Set<string>() });
  const keysTag = (selKeys ?? []).join(',');
  useEffect(() => setNodeEdits({ del: new Set(), add: new Set() }), [axis, at, keysTag]);
  const rings = useMemo(
    () => (L && selKeys?.length ? sliceRings(L, vol, axis, at, selKeys, nodeEdits) : new Map<string, Ring[]>()),
    // 只看已選結構；vol 是同一個狀態的體素（labels 已涵蓋）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [L, keysTag, axis, at, nodeEdits],
  );
  const insideKey = useCallback(
    (key: string, u: number, v: number) => {
      if (!L) return false;
      const k = L.comps.findIndex((c) => c.key === key);
      const [ua, va] = planeAxes(axis);
      const dims = [vol.X, vol.Y, vol.Z];
      if (k < 0 || u < 0 || v < 0 || u >= dims[ua] || v >= dims[va]) return false;
      const p = to3D(axis, u, v, at);
      return L.labels[(p[2] * vol.Y + p[1]) * vol.X + p[0]] === k;
    },
    [L, axis, at, vol],
  );
  const sliceBox = useCallback(
    (key: string) => {
      const rs = rings.get(key);
      if (!rs) return null;
      let u0 = Infinity;
      let v0 = Infinity;
      let u1 = -Infinity;
      let v1 = -Infinity;
      for (const r of rs)
        if (!r.hole)
          for (const [u, v] of r.pts) {
            u0 = Math.min(u0, u);
            v0 = Math.min(v0, v);
            u1 = Math.max(u1, u - 1);
            v1 = Math.max(v1, v - 1);
          }
      return u0 <= u1 ? { u0, v0, u1, v1 } : null;
    },
    [rings],
  );
  const gctx = (): GestureCtx | null =>
    gesture ? { axis, at, scope: gesture.scope, follow: gesture.follow, backfill: gesture.backfill, nm: gesture.nm, selKeys: selKeys ?? [], inside: insideKey, sliceBox } : null;
  const [hover, setHover] = useState<Handle | null>(null);
  /** 拖動中：抓到的把手、位移（切面格）、Shift。 */
  const [drag, setDrag] = useState<{ h: Handle; delta: XY; shift: boolean; op: Op | null } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  /** 按住 V／E／R：只抓節點／邊／區域。 */
  const only = useRef<HandleKind | undefined>(undefined);
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [xf, setXf] = useState<ViewXf | null>(null);
  const xfRef = useRef(xf);
  xfRef.current = xf;
  const [hoverUV, setHoverUV] = useState<[number, number] | null>(null);
  const space = useRef(false);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);
  const toVoxel = useCallback((u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]), [axis, at]);

  useEffect(() => {
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff, preview);
  }, [vol, axis, at, rgb, hidden, selMask, diff, preview]);

  const size = () => {
    const r = hostRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const fit = useCallback(() => {
    const { w, h } = size();
    const zoom = clampZoom(Math.min(w / W, h / H) * 0.94);
    setXf({ zoom, tx: (w - W * zoom) / 2, ty: (h - H * zoom) / 2 });
  }, [W, H]);
  const aim = useCallback(() => {
    if (!selBox) return fit();
    const { u0, v0, u1, v1 } = boxInPlane(axis, selBox);
    const { w, h } = size();
    const bw = u1 - u0 + 1;
    const bh = v1 - v0 + 1;
    // 四周留 30%，看得到旁邊的結構
    const zoom = clampZoom(Math.min(w / (bw * 1.6 + 4), h / (bh * 1.6 + 4)));
    const cu = (u0 + u1 + 1) / 2;
    const cv = (v0 + v1 + 1) / 2;
    setXf({ zoom, tx: w / 2 - cu * zoom, ty: h / 2 - cv * zoom });
  }, [selBox, axis, fit]);
  const zoomAt = (zoom: number, px?: number, py?: number) =>
    setXf((p) => {
      if (!p) return p;
      const { w, h } = size();
      const cx = px ?? w / 2;
      const cy = py ?? h / 2;
      const z = clampZoom(zoom);
      return { zoom: z, tx: cx - ((cx - p.tx) * z) / p.zoom, ty: cy - ((cy - p.ty) * z) / p.zoom };
    });

  // 第一次：自動放大到選取，否則還原這個方向上次的縮放，再不然適合視窗
  useLayoutEffect(() => {
    const m = memory.get(axis);
    if (autoZoom && selBox) aim();
    else if (m) setXf(m);
    else fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);
  // 換選取：自動放大
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (autoZoom && selBox) aim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  useEffect(() => {
    if (xf) memory.set(axis, xf);
  }, [xf, axis]);

  // 滾輪＝縮放；Ctrl＋滾輪＝換片（要非 passive 才能擋掉頁面捲動與瀏覽器縮放）
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useEffect(() => {
    const el = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        stepRef.current(e.deltaY > 0 ? 1 : -1);
        return;
      }
      const p = xfRef.current;
      if (!p) return;
      const r = el.getBoundingClientRect();
      zoomAt(p.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // 空白鍵按住＋左鍵拖＝平移
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || (e.target as HTMLElement | null)?.closest?.('input,textarea,select,button,[contenteditable]')) return;
      if (!hostRef.current?.matches(':hover')) return;
      e.preventDefault();
      space.current = true;
      hostRef.current.style.cursor = 'grab';
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      space.current = false;
      if (hostRef.current) hostRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  // 視窗大小改變：保持中心
  useEffect(() => {
    let last = size();
    const ro = new ResizeObserver(() => {
      const now = size();
      setXf((p) => (p ? { ...p, tx: p.tx + (now.w - last.w) / 2, ty: p.ty + (now.h - last.h) / 2 } : p));
      last = now;
    });
    ro.observe(hostRef.current!);
    return () => ro.disconnect();
  }, []);

  const uvAt = (clientX: number, clientY: number): [number, number] | null => {
    const p = xfRef.current;
    const r = hostRef.current?.getBoundingClientRect();
    if (!p || !r) return null;
    const u = Math.floor((clientX - r.left - p.tx) / p.zoom);
    const v = Math.floor((clientY - r.top - p.ty) / p.zoom);
    return u >= 0 && v >= 0 && u < W && v < H ? [u, v] : null;
  };
  const press = useRef<{ x: number; y: number; pan: boolean; tx: number; ty: number; id: number; hit: Handle | null; dragging: boolean } | null>(null);
  /** 螢幕座標 → 切面座標（格子角＝整數，可以有小數）。 */
  const planeAt = (clientX: number, clientY: number): XY | null => {
    const p = xfRef.current;
    const r = hostRef.current?.getBoundingClientRect();
    if (!p || !r) return null;
    return [(clientX - r.left - p.tx) / p.zoom, (clientY - r.top - p.ty) / p.zoom];
  };
  const hitAt = (clientX: number, clientY: number) => {
    const q = planeAt(clientX, clientY);
    const p = xfRef.current;
    if (!q || !p || !rings.size) return null;
    return hitTest(rings, q, p.zoom, insideKey, only.current);
  };
  /** 拖動中的提示文字。 */
  const tipText = (h: Handle, delta: XY, shift: boolean, op: Op | null) => {
    const nm = gesture?.nm ?? 0.5;
    if (h.kind === 'node') {
      const r = rings.get(h.key)?.[h.ring];
      const p = r?.pts[h.index];
      return p ? `(${p[0] + Math.round(delta[0])}, ${p[1] + Math.round(delta[1])})${shift ? ' · 只動這一點' : ''}` : '';
    }
    if (h.kind === 'edge') {
      const r = rings.get(h.key)![h.ring];
      const n = edgeAmount(r, h, delta, shift);
      const nrm = groupNormal(r, smoothEdgeGroup(r, h.index, shift));
      const word = n >= 0 ? uvWord(nrm[0], nrm[1]) : uvWord(-nrm[0], -nrm[1]);
      const kind = op?.kind === 'push' ? '推面' : '剖面';
      return `${word} ${Math.abs(n)} vx（${(Math.abs(n) * nm).toFixed(1)} nm）· ${kind}${gesture?.follow ? ' · 襯層一起推' : ' · 防穿層'}${shift ? ' · 只推這一段' : ''}`;
    }
    return `Δ${axis === 'x' ? 'z' : 'x'} ${Math.round(delta[0])}　Δ${axis === 'y' ? 'z' : 'y'} ${Math.round(delta[1])}`;
  };
  const cancelDrag = () => {
    press.current = null;
    setDrag(null);
    setTip(null);
    onLive?.(null);
    onDragState?.(false);
  };
  // 鍵盤：V／E／R 按住只抓一種；拖到一半 Esc 取消；選到把手時方向鍵推 1 格（Shift 10）、Delete 刪節點
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'e' || k === 'r') only.current = k === 'v' ? 'node' : k === 'e' ? 'edge' : 'region';
      if (e.key === 'Escape' && dragRef.current) {
        e.stopImmediatePropagation();
        cancelDrag();
        return;
      }
      if (e.key === 'Escape' && handle) {
        e.stopImmediatePropagation();
        setHandle?.(null);
        return;
      }
      if (!handle || handle.axis !== axis || handle.at !== at) return;
      const step = e.shiftKey ? 10 : 1;
      const arrows: Record<string, XY> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (arrows[e.key]) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const g = gctx();
        const r = rings.get(handle.key)?.[handle.ring];
        if (!g || !r) return;
        let delta = arrows[e.key];
        if (handle.kind === 'edge') {
          // 邊：沿它的法線推；按跟法線同側的方向鍵＝往外
          const nrm = groupNormal(r, smoothEdgeGroup(r, handle.index));
          const sgn = delta[0] * nrm[0] + delta[1] * nrm[1] >= 0 ? 1 : -1;
          delta = [nrm[0] * step * sgn, nrm[1] * step * sgn];
        }
        const op = gestureToOp(rings, handle, delta, false, g);
        if (op) {
          onCommit?.(op);
          // 把手跟著走：下一次方向鍵還抓得到同一個節點／邊
          setHandle?.({ ...handle, p: [handle.p[0] + Math.round(delta[0]), handle.p[1] + Math.round(delta[1])] });
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && handle.kind === 'node') {
        e.preventDefault();
        e.stopImmediatePropagation();
        const p = rings.get(handle.key)?.[handle.ring]?.pts[handle.index];
        if (p) setNodeEdits((x) => ({ ...x, del: new Set([...x.del, `${handle.key}|${p[0]},${p[1]}`]) }));
        setHandle?.(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'e' || k === 'r') only.current = undefined;
    };
    window.addEventListener('keydown', down, { capture: true });
    window.addEventListener('keyup', up, { capture: true });
    return () => {
      window.removeEventListener('keydown', down, { capture: true });
      window.removeEventListener('keyup', up, { capture: true });
    };
  });
  // 輪廓重描後（套用了一步）重新找把手：同一種、在記下的位置附近
  useEffect(() => {
    if (!handle || handle.axis !== axis || handle.at !== at || !rings.size) return;
    const h2 = hitTest(rings, handle.p, 8 / 3, insideKey, handle.kind);
    if (!h2) setHandle?.(null);
    else if (h2.key !== handle.key || h2.ring !== handle.ring || h2.index !== handle.index) setHandle?.({ ...h2, axis, at, p: handle.p });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rings]);
  const cursorFor = (h: Handle | null) => {
    if (!h) return '';
    if (h.kind === 'node') return 'move';
    if (h.kind === 'region') return 'grab';
    const r = rings.get(h.key)?.[h.ring];
    if (!r) return '';
    const n = groupNormal(r, smoothEdgeGroup(r, h.index));
    return Math.abs(n[0]) > Math.abs(n[1]) ? 'ew-resize' : 'ns-resize';
  };

  const [cu, cv] = toPlane(axis, cursor);
  const partial = !!scope && scope.axis !== axis && (scope.lo > 0 || scope.hi < axisLen(vol, scope.axis) - 1);
  const vertical = !!scope && (axis === 'y' ? scope.axis === 'z' : scope.axis === 'y');
  const frame = { fill: 'var(--c-primary)', fillOpacity: 0.06, stroke: 'var(--c-primary)', strokeWidth: 1, strokeDasharray: '4 3', vectorEffect: 'non-scaling-stroke' } as const;
  const sb = selBox ? boxInPlane(axis, selBox) : null;
  const outOfScope = !!gesture && gesture.scope.axis === axis && (at < gesture.scope.lo || at > gesture.scope.hi);
  /** 一組頂點（或整個環）→ SVG path。 */
  const pathOf = (pts: XY[], close = true) => (pts.length ? `M${pts.map((p) => `${p[0]},${p[1]}`).join('L')}${close ? 'Z' : ''}` : '');
  const groupPts = (h: Handle | null, shift = false): XY[] | null => {
    if (!h || h.kind !== 'edge') return null;
    const r = rings.get(h.key)?.[h.ring];
    if (!r) return null;
    const g = smoothEdgeGroup(r, h.index, shift);
    const out: XY[] = [];
    for (let k = 0; k + 1 < g.length; k++) out.push(...r.raw[g[k]].slice(k ? 1 : 0));
    return out;
  };
  const hoverGroup = groupPts(hover);
  const handleGroup = handle && handle.axis === axis && handle.at === at ? groupPts(handle) : null;
  /** 拖動中的新輪廓（橘色虛線）。 */
  const ghost: XY[][] | null = (() => {
    if (!drag) return null;
    if (drag.h.kind === 'region') {
      const du = Math.round(drag.delta[0]);
      const dv = Math.round(drag.delta[1]);
      return [...rings.values()].flat().map((x) => x.raw.flatMap((seg) => seg.slice(0, -1).map((p) => [p[0] + du, p[1] + dv] as XY)));
    }
    const r = rings.get(drag.h.key)?.[drag.h.ring];
    return r ? [editRing(r, dragDisp(r, drag.h, drag.delta, drag.shift))] : null;
  })();
  /** 上一步在這一片被擋住的格子。 */
  const blockedHere = useMemo(() => {
    if (!blocked?.length) return [] as XY[];
    const a = axisIndex(axis);
    const [ua, va] = planeAxes(axis);
    const out: XY[] = [];
    for (const i of blocked) {
      const x = i % vol.X;
      const y = ((i - x) / vol.X) % vol.Y;
      const z = (i - x - y * vol.X) / (vol.X * vol.Y);
      const c = [x, y, z];
      if (c[a] === at) out.push([c[ua], c[va]]);
      if (out.length > 4000) break;
    }
    return out;
  }, [blocked, axis, at, vol]);

  return (
    <div
      className="sedit"
      ref={hostRef}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const p = xfRef.current;
        if (!p) return;
        const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (space.current || e.altKey));
        if (e.button !== 0 && !pan) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { x: e.clientX, y: e.clientY, pan, tx: p.tx, ty: p.ty, id: e.pointerId, hit: pan ? null : hitAt(e.clientX, e.clientY), dragging: false };
        if (pan) e.currentTarget.style.cursor = 'grabbing';
      }}
      onPointerMove={(e) => {
        const pr = press.current;
        if (pr?.pan) {
          setXf((p) => (p ? { ...p, tx: pr.tx + e.clientX - pr.x, ty: pr.ty + e.clientY - pr.y } : p));
          return;
        }
        if (pr?.hit) {
          // 拖動：過了 4px 才算；每動一下算這一片的新形狀、送即時預覽
          if (!pr.dragging && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < CLICK_PX) return;
          if (!pr.dragging) {
            pr.dragging = true;
            onDragState?.(true);
          }
          const z = xfRef.current!.zoom;
          const delta: XY = [(e.clientX - pr.x) / z, (e.clientY - pr.y) / z];
          const g = gctx();
          const op = g ? gestureToOp(rings, pr.hit, delta, e.shiftKey, g) : null;
          setDrag({ h: pr.hit, delta, shift: e.shiftKey, op });
          onLive?.(op);
          const r = hostRef.current!.getBoundingClientRect();
          setTip({ text: tipText(pr.hit, delta, e.shiftKey, op), x: e.clientX - r.left + 14, y: e.clientY - r.top + 16 });
          return;
        }
        if (!pr) {
          const h = hitAt(e.clientX, e.clientY);
          setHover(h);
          e.currentTarget.style.cursor = space.current ? 'grab' : cursorFor(h);
        }
        const uv = uvAt(e.clientX, e.clientY);
        setHoverUV(uv);
        onHover?.(uv ? toVoxel(uv[0], uv[1]) : null);
      }}
      onPointerUp={(e) => {
        const pr = press.current;
        press.current = null;
        e.currentTarget.style.cursor = space.current ? 'grab' : '';
        if (!pr || pr.pan) return;
        if (pr.dragging) {
          // 放開＝一步（立刻套用到範圍）
          const d = dragRef.current;
          setDrag(null);
          setTip(null);
          onLive?.(null);
          onDragState?.(false);
          if (d?.op) onCommit?.(d.op);
          return;
        }
        if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) >= CLICK_PX) return;
        // 點一下：節點／邊 → 選把手；區域或別的結構 → 選結構；空白 → 先清把手、再清選取
        if (pr.hit && pr.hit.kind !== 'region') {
          const r = rings.get(pr.hit.key)![pr.hit.ring];
          const q = pr.hit.kind === 'node' ? r.pts[pr.hit.index] : planeAt(e.clientX, e.clientY)!;
          setHandle?.({ ...pr.hit, axis, at, p: [q[0], q[1]] });
          return;
        }
        if (!pr.hit && handle) {
          setHandle?.(null);
          return;
        }
        const uv = uvAt(e.clientX, e.clientY);
        if (uv) onPick(toVoxel(uv[0], uv[1]), selectModeOf(e));
      }}
      onPointerLeave={() => {
        setHoverUV(null);
        setHover(null);
        onHover?.(null);
      }}
      onDoubleClick={(e) => {
        // 雙擊邊＝在那裡加一個節點（形狀不變）
        const h = hitAt(e.clientX, e.clientY);
        const q = planeAt(e.clientX, e.clientY);
        if (h?.kind === 'edge' && q) {
          const seg = rings.get(h.key)![h.ring].raw[h.index];
          let best = seg[1] ?? seg[0];
          let bd = Infinity;
          seg.slice(1, -1).forEach((p) => {
            const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
            if (d < bd) {
              bd = d;
              best = p;
            }
          });
          if (seg.length > 2) setNodeEdits((x) => ({ ...x, add: new Set([...x.add, `${h.key}|${best[0]},${best[1]}`]) }));
          return;
        }
        // 雙擊空白（空氣或圖外）＝適合視窗
        const uv = uvAt(e.clientX, e.clientY);
        if (!uv) return fit();
        const [x, y, z] = toVoxel(uv[0], uv[1]);
        if (!vol.data[(z * vol.Y + y) * vol.X + x]) fit();
      }}
    >
      {/* canvas 一直是同一個元素（畫圖的 effect 只跑在它上面），還沒量好大小前先藏起來 */}
      <div className="sedit-img" style={xf ? { left: xf.tx, top: xf.ty, width: W * xf.zoom, height: H * xf.zoom } : { visibility: 'hidden' }}>
          <canvas ref={canvasRef} />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {partial &&
              (vertical ? (
                <rect x={0} y={scope!.lo} width={W} height={scope!.hi - scope!.lo + 1} {...frame} />
              ) : (
                <rect x={scope!.lo} y={0} width={scope!.hi - scope!.lo + 1} height={H} {...frame} />
              ))}
            {sb && (
              <rect
                x={sb.u0}
                y={sb.v0}
                width={sb.u1 - sb.u0 + 1}
                height={sb.v1 - sb.v0 + 1}
                fill="none"
                stroke="var(--c-primary)"
                strokeOpacity={0.6}
                strokeWidth={1}
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <line x1={cu + 0.5} y1={0} x2={cu + 0.5} y2={H} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={cv + 0.5} x2={W} y2={cv + 0.5} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {hoverUV && xf && xf.zoom >= 4 && (
              <rect x={hoverUV[0]} y={hoverUV[1]} width={1} height={1} fill="none" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
            {blockedHere.map(([u, v]) => (
              <rect key={`b${u},${v}`} x={u} y={v} width={1} height={1} fill="#ff4d4f" fillOpacity={0.55} stroke="#cf1322" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            ))}
            {[...rings].map(([key, rs]) =>
              rs.map((r, ri) => (
                <path
                  key={`o${key}${ri}`}
                  d={pathOf(r.raw.flatMap((seg) => seg.slice(0, -1)))}
                  fill="none"
                  stroke={outOfScope ? '#8c8c8c' : 'var(--c-primary)'}
                  strokeWidth={1.5}
                  strokeDasharray={outOfScope ? '4 3' : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              )),
            )}
            {hoverGroup && !drag && <path d={pathOf(hoverGroup, false)} fill="none" stroke="#fa8c16" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
            {handleGroup && <path d={pathOf(handleGroup, false)} fill="none" stroke="#fa541c" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
            {ghost?.map((g, k) => (
              <path key={`g${k}`} d={pathOf(g)} fill="rgba(250,84,28,0.08)" stroke="#fa541c" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
            ))}
            {xf &&
              [...rings].map(([key, rs]) =>
                rs.map((r, ri) =>
                  [...r.nodes].map((i) => {
                    const [u, v] = r.pts[i];
                    const sz = 7 / xf.zoom;
                    const on = (hover?.kind === 'node' && hover.key === key && hover.ring === ri && hover.index === i) || (handle?.kind === 'node' && handle.key === key && handle.ring === ri && handle.index === i && handle.at === at && handle.axis === axis);
                    return (
                      <rect
                        key={`n${key}${ri}-${i}`}
                        x={u - sz / 2}
                        y={v - sz / 2}
                        width={sz}
                        height={sz}
                        fill={on ? '#fa541c' : '#fff'}
                        stroke={on ? '#fa541c' : 'var(--c-primary)'}
                        strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke"
                      />
                    );
                  }),
                ),
              )}
          </svg>
      </div>
      <div className="sedit-zoombar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span className="sedit-zoom">{xf ? `${xf.zoom >= 10 ? xf.zoom.toFixed(0) : xf.zoom.toFixed(1)}×` : ''}</span>
        <Tooltip title="1 voxel = 1 px">
          <Button size="small" type="text" onClick={() => zoomAt(1)}>
            1:1
          </Button>
        </Tooltip>
        <Tooltip title="1 voxel = 8 px">
          <Button size="small" type="text" onClick={() => zoomAt(8)}>
            8×
          </Button>
        </Tooltip>
        <Tooltip title="整張切面放進視窗（雙擊空白也可以）">
          <Button size="small" type="text" icon={<ExpandOutlined />} onClick={fit}>
            適合
          </Button>
        </Tooltip>
        <Tooltip title="放大到選取的結構">
          <Button size="small" type="text" icon={<AimOutlined />} disabled={!selBox} onClick={aim}>
            對準選取
          </Button>
        </Tooltip>
      </div>
      {tip && (
        <div className="drag-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
      <div className="sedit-hint">滾輪縮放 · 右鍵拖或空白鍵＋拖平移 · Ctrl＋滾輪、<kbd>,</kbd> <kbd>.</kbd> 換片 · 雙擊空白＝適合視窗</div>
    </div>
  );
}
