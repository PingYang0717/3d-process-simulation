import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { AimOutlined, ExpandOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Backfill, type Labeled, type Material, type Vec3, type Volume, hexToRgb } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { type Scope, axisIndex, axisLen, planeAxes, to3D } from '../../volume/scope';
import { type Ring, type XY, boundaryLoops, traceRings } from '../../slice/trace';
import { editRing } from '../../slice/raster';
import { type Handle, type HandleKind, dragDisp, groupNormal, hitTest, smoothEdgeGroup, uvWord } from '../../slice/gestures';
import { dragDispFloat, snapAmount } from '../../slice/snap';
import { type ModelStore, type VId, insertNode, locate, removeHandle, ringsOf, sliceOfKey, vidOf } from '../../slice/model';
import { type ModelHost, commitGesture, opOfGesture, sliceContext } from './handleOps';
import { type SlicePreview, SlicePreviewLayer } from './SlicePreviewLayer';
import { type SelectMode, selectModeOf } from './editor';
import { drawSlice } from './views';
import { typingIn, usePersisted } from '../../ui/persist';

/**
 * 選到的把手（節點／邊）：右欄數值輸入、方向鍵用。vid＝幾何層的頂點 id（節點＝那個頂點，邊＝段的起點），
 * 幾何沒有重描就一直找得到同一個（plan v8 §5.1）；p 是畫面上的位置（找不到 id 時退回用位置找）。
 */
export type PickedHandle = Handle & { axis: Axis; at: number; p: XY; origin: XY; vid?: VId };

/** 幾何層與 2D 編輯設定（editor 給）。 */
export interface GeoOpts {
  models: ModelStore;
  version: number;
  stepSeq: number;
  /** 輪廓畫幾何線（預設）或 v7 的階梯。 */
  outline: 'geometry' | 'stairs';
  /** 拖拉中跟手、放開才吸附（預設）或邊拖邊吸附（v7）。 */
  snap: 'release' | 'live';
}

/** 手勢要的設定（editor 給）。 */
export interface GestureOpts {
  scope: Scope;
  follow: boolean;
  backfill: Backfill;
  nm: number;
}

/** 一片上已選結構的環（v7：每次從 voxel 重描）。v8 的主切面改用幾何層；這個留給沒有幾何層的地方與黃金測試對照。 */
export function sliceRings(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[]) {
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
    out.set(key, rings);
  }
  return out;
}

type DragLive = { h: Handle; delta: XY; shift: boolean; op: Op | null; missed: string[] };
/** +1.6／−2.3（正負號一律寫出來）。 */
const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Number.isInteger(x) ? Math.abs(x) : Math.abs(x).toFixed(1)}`;

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

/** 同一個把手（滑過時只在換了把手才更新 state）。 */
const sameHandle = (a: Handle | null, b: Handle | null) =>
  a === b || (!!a && !!b && a.kind === b.kind && a.key === b.key && a.ring === b.ring && a.index === b.index);

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
  mirror = false,
  onNote,
  overlay,
  onMenu,
  geo,
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
  preview?: SlicePreview | null;
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
  /** 多選時對應到長得一樣的結構。 */
  mirror?: boolean;
  /** 「Si fin 3 找不到對應的邊，未改」之類的提醒。 */
  onNote?: (text: string) => void;
  /** 貼在選取外框右上角的浮動工具列。 */
  overlay?: ReactNode;
  /** 右鍵（沒有拖）：選單。 */
  onMenu?: (p: Vec3 | null, clientX: number, clientY: number) => void;
  /** 幾何層（plan v8）；沒給就每次從 voxel 重描（v7 行為）。 */
  geo?: GeoOpts;
}) {
  const [W, H] = planeDims(vol, axis);
  const hostRef = useRef<HTMLDivElement>(null);
  // ---- 輪廓與手勢 ----
  const keysTag = (selKeys ?? []).join(',');
  /** 幾何層在這個元件裡被改了（加／刪節點、放開）：重新取環。 */
  const [geomRev, setGeomRev] = useState(0);
  const bump = () => setGeomRev((n) => n + 1);
  // 幾何層（§6）：這一片、這個版本的幾何；Worker 回來時驗證，對不上的結構重描（節點 id 保留）
  const got = useMemo(
    () => (L && geo && selKeys?.length ? geo.models.get(L, vol, axis, at, selKeys, geo.version, geo.stepSeq) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [L, keysTag, axis, at, geo?.version, geo?.stepSeq, geomRev],
  );
  const model = got?.model ?? null;
  const rings = useMemo(
    () => (model ? ringsOf(model, selKeys ?? []) : L && selKeys?.length ? sliceRings(L, vol, axis, at, selKeys) : new Map<string, Ring[]>()),
    // 只看已選結構；vol 是同一個狀態的體素（labels 已涵蓋）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, model?.rev, L, keysTag, axis, at],
  );
  const host: ModelHost | null = L && geo && onCommit ? { L, vol, models: geo.models, version: geo.version, stepSeq: geo.stepSeq, commit: onCommit } : null;
  /** voxel 真正的邊界（≥ 8× 疊在幾何線下面，§5.1）。 */
  const stairs = useMemo(() => {
    if (!L || !selKeys?.length) return [] as XY[][];
    return selKeys.flatMap((key) => {
      const sl = sliceOfKey(L, vol, axis, at, key);
      return sl ? boundaryLoops((u, v) => u >= sl.u0 && v >= sl.v0 && u <= sl.u1 && v <= sl.v1 && sl.inside(u, v), sl.u0, sl.v0, sl.u1, sl.v1) : [];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, keysTag, axis, at]);
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
  const sctx = useMemo(
    () => (L && gesture ? { ...sliceContext(L, vol, axis, at, selKeys ?? [], gesture, rings), model: model ?? undefined } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [L, vol, axis, at, rings, model, gesture?.scope, gesture?.follow, gesture?.backfill, gesture?.nm],
  );
  /** 放開＝一步：幾何層先更新（不等 Worker），再送 Op。 */
  const commitOp = (h: Handle, delta: XY, shift: boolean, op: Op) => {
    if (host && sctx) {
      commitGesture(host, sctx, h, delta, shift, op);
      bump();
    } else onCommit?.(op);
  };
  // 驗證時重描了（被擋住、別的路徑改了這一片）：說一聲
  const lastFixed = useRef<unknown>(null);
  useEffect(() => {
    if (!got?.fixed.length || lastFixed.current === got.fixed) return;
    lastFixed.current = got.fixed;
    const lost = got.fixed.reduce((n, f) => n + f.lost, 0);
    const custom = got.fixed.reduce((n, f) => n + f.lostCustom, 0);
    onNote?.(
      `${got.fixed.map((f) => labelOf(f.key)).join('、')} 幾何已對齊到實際結果${lost - custom > 0 ? ` · ${lost - custom} 個節點對不到，已移除` : ''}${custom ? ` · ${custom} 個自訂節點已移除` : ''}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [got]);
  /** 手勢 → Op（多選＋對應時一起改長得一樣的結構）。 */
  const opFor = (h: Handle, delta: XY, shift: boolean) => (sctx ? opOfGesture(sctx, h, delta, shift, mirror) : { op: null, missed: [] as string[] });
  const labelOf = (key: string) => L?.comps.find((c) => c.key === key)?.label ?? key;
  const noteMissed = (missed: string[], h: Handle) => {
    if (missed.length) onNote?.(`${missed.map(labelOf).join('、')} 找不到對應的${h.kind === 'node' ? '節點' : '邊'}，未改`);
  };
  /** 第一次用：選到結構後左下角三行提示，成功拖一次之後不再顯示。 */
  const [hintsSeen, setHintsSeen] = usePersisted('hintsSeen', false);
  /** 浮動工具列的實際寬度（貼右邊時不要超出畫面）。 */
  const tbRef = useRef<HTMLDivElement>(null);
  const [tbW, setTbW] = useState(520);
  useLayoutEffect(() => {
    const w = tbRef.current?.offsetWidth;
    if (w && Math.abs(w - tbW) > 2) setTbW(w);
  });
  const [hover, setHover] = useState<Handle | null>(null);
  /**
   * 拖動中（§8.1）：每一幀的位移、Op 放在 dragRef，ghost 與提示文字直接寫 SVG／DOM（不經 React state）；
   * drag state 只在開始與結束時更新（藏起工具列、提示）。
   */
  const [drag, setDrag] = useState<DragLive | null>(null);
  const dragRef = useRef<DragLive | null>(null);
  const ghostRef = useRef<SVGPathElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /** pointermove 只記最新的位置；requestAnimationFrame 每幀最多算一次。 */
  const latestMove = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const raf = useRef(0);
  /** 按住 V／E／R：只抓節點／邊／區域。按住 V 時也顯示所有頂點（不只節點）。 */
  const only = useRef<HandleKind | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [xf, setXf] = useState<ViewXf | null>(null);
  const xfRef = useRef(xf);
  xfRef.current = xf;
  /** 滑鼠所在格子的白框：直接改 SVG 屬性（plan v9 P7，不經 React state）。 */
  const hoverRectRef = useRef<SVGRectElement>(null);
  const showHoverUV = (uv: [number, number] | null) => {
    const r = hoverRectRef.current;
    if (!r) return;
    if (!uv || (xfRef.current?.zoom ?? 0) < 4) r.setAttribute('display', 'none');
    else {
      r.setAttribute('x', String(uv[0]));
      r.setAttribute('y', String(uv[1]));
      r.removeAttribute('display');
    }
  };
  const space = useRef(false);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);
  const toVoxel = useCallback((u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]), [axis, at]);

  useEffect(() => {
    // 底圖不看預覽（預覽層只重畫那一塊，§8.2）
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff, null);
  }, [vol, axis, at, rgb, hidden, selMask, diff]);

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
  const press = useRef<{ x: number; y: number; pan: boolean; tx: number; ty: number; id: number; hit: Handle | null; dragging: boolean; button: number } | null>(null);
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
  /** 拖動中的提示文字（§5.2）：浮點 → 放開後取的整數。 */
  const tipText = (h: Handle, delta: XY, shift: boolean, op: Op | null) => {
    const nm = gesture?.nm ?? 0.5;
    const r = rings.get(h.key)?.[h.ring];
    const sn = snapAmount(r, h, delta, shift);
    const pair = (p: XY) => `(${signed(p[0])}, ${signed(p[1])})`;
    if (h.kind === 'node')
      return `${pair(sn.raw)} → 取 ${pair(sn.snapped)}　${(Math.hypot(...sn.snapped) * nm).toFixed(1)} nm${shift ? ' · 只動這一點' : ''}`;
    if (h.kind === 'edge' && r && sn.amount) {
      const { raw, snapped } = sn.amount;
      const nrm = groupNormal(r, smoothEdgeGroup(r, h.index, shift));
      const word = snapped >= 0 ? `${uvWord(nrm[0], nrm[1])}（往外）` : `${uvWord(-nrm[0], -nrm[1])}（往內）`;
      const kind = op?.kind === 'push' ? '推面' : '剖面';
      return `邊${word} ${Math.abs(raw).toFixed(1)} → 取 ${Math.abs(snapped)} vx（${(Math.abs(snapped) * nm).toFixed(1)} nm）· ${kind}${gesture?.follow ? ' · 襯層一起推' : ' · 防穿層'}${shift ? ' · 只推這一段' : ''}`;
    }
    return `搬 ${pair(sn.raw)} → 取 ${pair(sn.snapped)}`;
  };
  /** 拖動中的新輪廓：放開才吸附＝浮點位移（跟手）；邊拖邊吸附＝整數位移（v7）。幾何線＝頂點連線，階梯＝原始折線內插。 */
  const ghostD = (h: Handle, delta: XY, shift: boolean) => {
    const float = geo?.snap !== 'live';
    const stairs = geo?.outline === 'stairs' || !geo;
    if (h.kind === 'region') {
      const d: XY = float ? delta : [Math.round(delta[0]), Math.round(delta[1])];
      return [...rings.values()]
        .flat()
        .map((x) => pathOf((stairs ? x.raw.flatMap((seg) => seg.slice(0, -1)) : x.pts).map((p) => [p[0] + d[0], p[1] + d[1]] as XY)))
        .join('');
    }
    const r = rings.get(h.key)?.[h.ring];
    if (!r) return '';
    const disp = float ? dragDispFloat(r, h, delta, shift) : dragDisp(r, h, delta, shift);
    return pathOf(stairs ? editRing(r, disp) : r.pts.map((p, i) => [p[0] + disp[i][0], p[1] + disp[i][1]] as XY));
  };
  /** 一幀（§7.2）：Op（＝snap 後的格子，給第二層預覽與 3D）＋浮點 ghost＋提示文字。 */
  const tick = () => {
    raf.current = 0;
    const pr = press.current;
    const mv = latestMove.current;
    if (!pr?.hit || !pr.dragging || !mv) return;
    const z = xfRef.current!.zoom;
    const delta: XY = [(mv.x - pr.x) / z, (mv.y - pr.y) / z];
    const { op, missed } = opFor(pr.hit, delta, mv.shift);
    dragRef.current = { h: pr.hit, delta, shift: mv.shift, op, missed };
    ghostRef.current?.setAttribute('d', ghostD(pr.hit, delta, mv.shift));
    const t = tipRef.current;
    const host = hostRef.current?.getBoundingClientRect();
    if (t && host) {
      t.textContent = tipText(pr.hit, delta, mv.shift, op);
      t.style.left = `${mv.x - host.left + 14}px`;
      t.style.top = `${mv.y - host.top + 16}px`;
      t.style.display = '';
    }
    onLive?.(op);
  };
  const cancelDrag = () => {
    press.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
    dragRef.current = null;
    if (tipRef.current) tipRef.current.style.display = 'none';
    setDrag(null);
    onLive?.(null);
    onDragState?.(false);
  };
  // 鍵盤：V／E／R 按住只抓一種；拖到一半 Esc 取消；選到把手時方向鍵推 1 格（Shift 10）、Delete 刪節點
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'e' || k === 'r') only.current = k === 'v' ? 'node' : k === 'e' ? 'edge' : 'region';
      if (k === 'v' && !showAll) setShowAll(true);
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
        const hh = currentHandle(handle);
        const r = hh && rings.get(hh.key)?.[hh.ring];
        if (!sctx || !r || !hh) return;
        let delta = arrows[e.key];
        if (handle.kind === 'edge') {
          // 邊：沿它的法線推；按跟法線同側的方向鍵＝往外
          const nrm = groupNormal(r, smoothEdgeGroup(r, hh.index));
          const sgn = delta[0] * nrm[0] + delta[1] * nrm[1] >= 0 ? 1 : -1;
          delta = [nrm[0] * step * sgn, nrm[1] * step * sgn];
        }
        const { op, missed } = opFor(hh, delta, false);
        if (op) {
          noteMissed(missed, hh);
          commitOp(hh, delta, false, op);
          // 把手跟著走：幾何層的頂點 id 不變；畫面位置跟著更新
          const v = handle.vid && model?.vertices[handle.vid];
          setHandle?.({ ...handle, ...hh, p: v && handle.kind === 'node' ? [v.u, v.v] : [handle.p[0] + Math.round(delta[0]), handle.p[1] + Math.round(delta[1])] });
        }
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && handle.kind === 'node') {
        e.preventDefault();
        e.stopImmediatePropagation();
        // 幾何層的操作：這個頂點不再是節點（形狀不變）
        if (model && handle.vid) {
          removeHandle(model, handle.vid);
          bump();
        }
        setHandle?.(null);
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'e' || k === 'r') only.current = undefined;
      if (k === 'v') setShowAll(false);
    };
    window.addEventListener('keydown', down, { capture: true });
    window.addEventListener('keyup', up, { capture: true });
    return () => {
      window.removeEventListener('keydown', down, { capture: true });
      window.removeEventListener('keyup', up, { capture: true });
    };
  });
  /** 選到的把手在目前的環上：先用頂點 id（幾何沒重描就是同一個），沒有 id 才用位置找。 */
  const currentHandle = (h: PickedHandle): Handle | null => {
    if (h.vid && model) {
      const at2 = locate(model, h.vid);
      if (at2 && rings.get(at2.key)?.[at2.ring]) return { kind: h.kind, ...at2 };
    }
    // id 不在了（重描時對不到，例如被擋住的邊退回原位）：用記下的位置附近找同一種
    return hitTest(rings, h.p, 8 / 3, insideKey, h.kind);
  };
  // 幾何改了（套用了一步、重描、加刪節點）：把手的索引跟著頂點 id 走；id 不在了（重描對不到）才放掉
  useEffect(() => {
    if (!handle || handle.axis !== axis || handle.at !== at || !rings.size) return;
    const h2 = currentHandle(handle);
    if (!h2) setHandle?.(null);
    else {
      const vid = model ? (vidOf(model, h2.key, h2.ring, h2.index) ?? undefined) : undefined;
      if (h2.key !== handle.key || h2.ring !== handle.ring || h2.index !== handle.index || vid !== handle.vid) setHandle?.({ ...handle, ...h2, vid });
    }
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
  /** 拖拉中第二層：單片預覽 report 裡會被擋住的格子（這一片）。 */
  const blockedLive = useMemo(() => {
    if (!drag || !preview?.blocked?.length) return [] as XY[];
    const a = axisIndex(axis);
    const [ua, va] = planeAxes(axis);
    const out: XY[] = [];
    for (const i of preview.blocked) {
      const x = i % vol.X;
      const y = ((i - x) / vol.X) % vol.Y;
      const z = (i - x - y * vol.X) / (vol.X * vol.Y);
      const c = [x, y, z];
      if (c[a] === at) out.push([c[ua], c[va]]);
      if (out.length > 4000) break;
    }
    return out;
  }, [drag, preview, axis, at, vol]);
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

  /** 被擋住的格子合成一條 path（plan v9 P8：拖拉中每幀不再 reconcile 幾千個 rect）。 */
  const cellsPath = (cells: XY[]) => (cells.length ? cells.map(([u, v]) => `M${u},${v}h1v1h-1z`).join('') : '');
  const blockedLivePath = useMemo(() => cellsPath(blockedLive), [blockedLive]);
  const blockedHerePath = useMemo(() => cellsPath(blockedHere), [blockedHere]);
  // 輪廓、階梯的 path 字串只在環變了才重算（plan v9 P7）
  const stairsPath = useMemo(() => stairs.map((l) => pathOf(l)).join(''), [stairs]);
  const ringPaths = useMemo(
    () =>
      [...rings].flatMap(([key, rs]) =>
        rs.map((r, ri) => ({ k: `o${key}${ri}`, d: pathOf(geo?.outline === 'stairs' || !geo ? r.raw.flatMap((seg) => seg.slice(0, -1)) : r.pts) })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rings, model?.rev, geo?.outline, !geo],
  );
  const zoom = xf?.zoom ?? 0;
  const nodes = useMemo(
    () => (
      xf &&
              [...rings].map(([key, rs]) =>
                rs.map((r, ri) =>
                  (showAll ? r.pts.map((_, i) => i) : [...r.nodes]).map((i) => {
                    const [u, v] = r.pts[i];
                    // 節點 7 px；按住 V 時其他頂點小一點
                    const sz = (r.nodes.has(i) ? 7 : 4) / zoom;
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
              )
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rings, model?.rev, showAll, zoom, !!xf, hover, handle, at, axis],
  );

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
        press.current = { x: e.clientX, y: e.clientY, pan, tx: p.tx, ty: p.ty, id: e.pointerId, hit: pan ? null : hitAt(e.clientX, e.clientY), dragging: false, button: e.button };
        if (pan) e.currentTarget.style.cursor = 'grabbing';
      }}
      onPointerMove={(e) => {
        const pr = press.current;
        if (pr?.pan) {
          setXf((p) => (p ? { ...p, tx: pr.tx + e.clientX - pr.x, ty: pr.ty + e.clientY - pr.y } : p));
          return;
        }
        if (pr?.hit) {
          // 拖動：過了 4px 才算；pointermove 只記位置，每一幀算一次（rAF 合併，§8.1）
          if (!pr.dragging && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < CLICK_PX) return;
          latestMove.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
          if (!pr.dragging) {
            pr.dragging = true;
            onDragState?.(true);
            setDrag({ h: pr.hit, delta: [0, 0], shift: e.shiftKey, op: null, missed: [] });
          }
          if (!raf.current) raf.current = requestAnimationFrame(tick);
          return;
        }
        if (!pr) {
          const h = hitAt(e.clientX, e.clientY);
          // 把手沒變就不 set（同一個節點／邊上移動不重 render）
          setHover((p) => (sameHandle(p, h) ? p : h));
          e.currentTarget.style.cursor = space.current ? 'grab' : cursorFor(h);
        }
        const uv = uvAt(e.clientX, e.clientY);
        showHoverUV(uv);
        onHover?.(uv ? toVoxel(uv[0], uv[1]) : null);
      }}
      onPointerUp={(e) => {
        const pr = press.current;
        press.current = null;
        e.currentTarget.style.cursor = space.current ? 'grab' : '';
        if (pr?.pan && pr.button === 2 && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) < CLICK_PX) {
          // 右鍵沒拖＝選單
          const uv = uvAt(e.clientX, e.clientY);
          onMenu?.(uv ? toVoxel(uv[0], uv[1]) : null, e.clientX, e.clientY);
          return;
        }
        if (!pr || pr.pan) return;
        if (pr.dragging) {
          // 放開＝一步（立刻套用到範圍）。還沒算的那一幀先同步算掉：commit 的就是最後看到的格子
          press.current = pr;
          latestMove.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
          if (raf.current) cancelAnimationFrame(raf.current);
          tick();
          press.current = null;
          const d = dragRef.current;
          dragRef.current = null;
          if (tipRef.current) tipRef.current.style.display = 'none';
          setDrag(null);
          onLive?.(null);
          onDragState?.(false);
          if (d?.op) {
            noteMissed(d.missed, d.h);
            commitOp(d.h, d.delta, d.shift, d.op);
            setHintsSeen(true);
          }
          return;
        }
        if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) >= CLICK_PX) return;
        // 點一下：節點／邊 → 選把手；區域或別的結構 → 選結構；空白 → 先清把手、再清選取
        if (pr.hit && pr.hit.kind !== 'region') {
          const r = rings.get(pr.hit.key)![pr.hit.ring];
          const q = pr.hit.kind === 'node' ? r.pts[pr.hit.index] : planeAt(e.clientX, e.clientY)!;
          const vid = model ? (vidOf(model, pr.hit.key, pr.hit.ring, pr.hit.index) ?? undefined) : undefined;
          setHandle?.({ ...pr.hit, axis, at, p: [q[0], q[1]], origin: [q[0], q[1]], vid });
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
        showHoverUV(null);
        setHover(null);
        onHover?.(null);
      }}
      onDoubleClick={(e) => {
        // 雙擊邊＝在那裡加一個節點（形狀不變）
        const h = hitAt(e.clientX, e.clientY);
        const q = planeAt(e.clientX, e.clientY);
        if (h?.kind === 'edge' && q) {
          const seg = rings.get(h.key)![h.ring].raw[h.index];
          let best = 1;
          let bd = Infinity;
          for (let j = 1; j < seg.length - 1; j++) {
            const d = Math.hypot(seg[j][0] - q[0], seg[j][1] - q[1]);
            if (d < bd) {
              bd = d;
              best = j;
            }
          }
          // 幾何層的操作：在 exact seg 的那一點插一個節點（形狀不變）
          if (seg.length > 2 && model && insertNode(model, h.key, h.ring, h.index, best)) bump();
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
          <SlicePreviewLayer vol={vol} axis={axis} at={at} W={W} H={H} preview={preview} selMask={selMask} rgb={rgb} hidden={hidden} />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <pattern id="sedit-hatch" width={0.5} height={0.5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width={0.5} height={0.5} fill="rgba(255,77,79,0.25)" />
                <line x1={0} y1={0} x2={0} y2={0.5} stroke="#cf1322" strokeWidth={0.2} />
              </pattern>
            </defs>
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
            <rect ref={hoverRectRef} display="none" width={1} height={1} fill="none" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {blockedHerePath && <path d={blockedHerePath} fill="#ff4d4f" fillOpacity={0.55} stroke="#cf1322" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
            {geo?.outline !== 'stairs' && xf && xf.zoom >= 8 && (
              // voxel 真正的邊界（淡淡的階梯）：隨時看得到真相
              <path d={stairsPath} fill="none" stroke={outOfScope ? '#8c8c8c' : 'var(--c-primary)'} strokeOpacity={0.4} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
            {ringPaths.map(({ k, d }) => (
              <path
                key={k}
                d={d}
                fill="none"
                stroke={outOfScope ? '#8c8c8c' : 'var(--c-primary)'}
                strokeWidth={1.5}
                strokeDasharray={outOfScope ? '4 3' : undefined}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hoverGroup && !drag && <path d={pathOf(hoverGroup, false)} fill="none" stroke="#fa8c16" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
            {handleGroup && <path d={pathOf(handleGroup, false)} fill="none" stroke="#fa541c" strokeWidth={3} vectorEffect="non-scaling-stroke" />}
            {/* 第二層之一：會被擋住的格子（斜線） */}
            {blockedLivePath && <path d={blockedLivePath} fill="url(#sedit-hatch)" stroke="#cf1322" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />}
            {/* 第一層：浮點 ghost（tick 直接寫 d，不經 React） */}
            <path ref={ghostRef} d="" display={drag ? undefined : 'none'} fill="rgba(250,84,28,0.08)" fillRule="evenodd" stroke="#fa541c" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {nodes}
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
      <div className="drag-tip" ref={tipRef} style={{ display: 'none' }} />
      {overlay && xf && sb && !drag && (
        <div
          className="float-tb"
          ref={tbRef}
          style={(() => {
            // 先放外框右上角；右邊放不下就放到外框上方（右緣對齊），不要蓋住結構
            const hw = hostRef.current?.clientWidth ?? 600;
            const hh = hostRef.current?.clientHeight ?? 400;
            const right = xf.tx + (sb.u1 + 1) * xf.zoom + 10;
            const fits = right + tbW + 8 <= hw;
            const left = fits ? right : Math.max(8, Math.min(hw - tbW - 8, xf.tx + (sb.u1 + 1) * xf.zoom - tbW));
            const top = fits ? xf.ty + sb.v0 * xf.zoom : xf.ty + sb.v0 * xf.zoom - 44;
            return { left, top: Math.max(8, Math.min(hh - 48, top)) };
          })()}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {overlay}
        </div>
      )}
      {!hintsSeen && !!selKeys?.length && !drag && (
        <div className="sedit-first">
          <div>靠近<b>點</b>可以拖</div>
          <div>靠近<b>邊</b>可以推</div>
          <div>在<b>裡面</b>可以搬</div>
        </div>
      )}
      <div className="sedit-hint">滾輪縮放 · 右鍵拖或空白鍵＋拖平移 · Ctrl＋滾輪、<kbd>,</kbd> <kbd>.</kbd> 換片 · 雙擊空白＝適合視窗</div>
    </div>
  );
}
