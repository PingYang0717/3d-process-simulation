import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { App, Badge, Button, Divider, Drawer, Dropdown, Flex, InputNumber, Menu, Modal, Popover, Segmented, Slider, Space, Switch, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  ExpandOutlined,
  LeftOutlined,
  RightOutlined,
  SwapOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  ScissorOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  RedoOutlined,
  LockOutlined,
  UnlockOutlined,
  CloseOutlined,
  SettingOutlined,
  SlidersOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { type Axis, type BBox, type Vec3, directionName, hexToRgb, unionBBox } from '../../volume/volume';
import { zipStore } from '../../volume/zip';
import { download } from '../../ui/download';
import { MatLabel } from '../../ui/Swatch';
import { type Op, type SelectMode, type Split, changedOf, slicesWith, useEditor } from './editor';
import { AXIS_TAB, PositionBar, longestAxis, nearestSlice } from './PositionBar';
import { FloatingToolbar } from './FloatingToolbar';
import { type CardHost, CardHostCtx, PushCard, ShapeCard } from './OpCard';
import { type EditTab, EditToolbar } from './EditToolbar';
import { roundFrame } from './RoundCard';
import { type CornerId, type RoundGesture, roundOp } from '../../slice/round';
import { axisIndex, clipBox } from '../../volume/scope';
import { type Preview, boxVoxels, previewBox, previewOp } from '../../volume/preview';
import { newReport } from '../../volume/kernel';
import { type CellCloud, cellCloud, globalIndex } from './cellCloud';
import { previewIn, sidOf } from '../../volume/client';
import { hiddenTable, palette } from './tables';
import { type LiveValue, useLive, useLiveValue } from '../../ui/liveValue';

const sameVec = (a: Vec3 | null, b: Vec3 | null) => a === b || (!!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);

/** 主切面標題列：滑鼠所在的體素與材質（自己訂閱，整頁不 render）。 */
function HoverReadout({ live, data, vol, matName }: { live: LiveValue<Vec3 | null>; data: Uint8Array; vol: { X: number; Y: number }; matName: (id: number) => string }) {
  const hov = useLive(live);
  if (!hov) return null;
  return (
    <Text type="secondary" style={{ fontSize: 11 }}>
      ({hov[0]}, {hov[1]}, {hov[2]}) {matName(data[(hov[2] * vol.Y + hov[1]) * vol.X + hov[0]])}
    </Text>
  );
}
/**
 * 拖拉中的第 2 級預覽（Worker 每幀回一次）不進整頁的 state：放在 live value，只有 3D 與小切面重 render（plan v9 P7）。
 * 沒有拖拉預覽時用整頁的 pv（放開／按鈕的預覽）。
 */
function WithLivePv<P>({ live, pv, children }: { live: LiveValue<P | null>; pv: P | null; children: (p: P | null) => ReactNode }) {
  const l = useLive(live);
  return <>{children(l ?? pv)}</>;
}
/** 頁尾：剛套用的訊息（fallback）優先，其次 3D 上滑過的說明，再其次一般提示。 */
function HoverText({ live, fallback, idle }: { live: LiveValue<string | null>; fallback: string | null; idle: string }) {
  const h = useLive(live);
  return <>{fallback ?? (h || idle)}</>;
}
import type { MeshData } from '../../volume/volume';
import type { Clip, ViewMode, ViewPreset, View3DHandle } from './views';
import { SliceEditor, SliceView, View3D } from './views.lazy';
import { overlayOpen, typingIn, usePersisted } from '../../ui/persist';
import { Inspector, matOf } from './Inspector';
import { ChangesTab } from './ChangesTab';
import { buildManifest } from './matrix';
import { SplitPicker } from './SplitPicker';
import { AXIS_NAME } from './CompareView';
import { ExperimentPage } from './ExperimentPage';
import { StructureList } from './StructureList';
import { SettingsDrawer } from './SettingsDrawer';
import { UploadPanel } from './UploadPanel';
import { HelpDrawer } from './HelpDrawer';

const { Text } = Typography;

function useMedia(query: string) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** 左右欄寬度的分隔線：滑鼠拖，或 Tab 到它用左右鍵（一次 16px，Shift 48px）。 */
function Resizer({ onDrag, label, value, min, max }: { onDrag: (dx: number) => void; label: string; value: number; min: number; max: number }) {
  return (
    <div
      className="resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        onDrag((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 48 : 16));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let x = e.clientX;
        const move = (ev: PointerEvent) => {
          onDrag(ev.clientX - x);
          x = ev.clientX;
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}

const voxelCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${(n / 1e3).toFixed(0)} K`);

/**
 * 即時預覽的上限（裁切範圍的體素數）：拖拉中每改一格就算一次，要在幾十毫秒內；
 * 放開／按鈕套用只算一次，幾百毫秒也比等 Worker 幾秒好。超過就只畫橘色塊、等正式結果。
 */
const LIVE_PREVIEW_CAP = 400_000;
// 正式結果現在只在外框裡算（§8.2），幾百毫秒就到；放開後的預覽只在範圍小時做（§7.5 第 2 級）
const COMMIT_PREVIEW_CAP = 400_000;
/** base = 預覽根據的狀態版本號。 */
type PV = Preview & { base: number; committed: boolean; blocked?: number[]; mesh?: MeshData };


/** 浮動卡片：右鍵「長／縮…」「圓頭…」、3D 角把手點一下開的。 */
const CORNER_NAME: Record<CornerId, string> = { ul: '左上', ur: '右上', ll: '左下', lr: '右下' };
type CardAt = { kind: 'push' | 'shape'; x: number; y: number; dir?: Vec3; round?: Partial<RoundGesture> };

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.6">
          <path d="M2 13h12M4 13V8a4 4 0 0 1 8 0v5" />
        </svg>
      </span>
      <h1 className="brand-name">Section Editor</h1>
      <Tag bordered={false}>3D</Tag>
    </div>
  );
}

export default function Section3DPage() {
  const ed = useEditor();
  // 開發模式：e2e（scripts/e2e/m9.cjs、perf.cjs）讀編輯器狀態
  if (import.meta.env.DEV) (window as unknown as { __ed?: unknown }).__ed = ed;
  // 開發模式：整頁 render 次數（perf.cjs 量主切面上滑鼠移動時整頁 render 幾次，plan v9 P7）
  if (import.meta.env.DEV) (window as unknown as { __renders?: number }).__renders = ((window as unknown as { __renders?: number }).__renders ?? 0) + 1;
  // 開發模式：e2e 腳本從 window.__ed 讀狀態（正式打包不會有）
  if (import.meta.env.DEV) (window as unknown as { __ed?: unknown }).__ed = ed;
  // 開發模式：整頁 render 次數（perf.cjs 量主切面上滑鼠移動時整頁 render 幾次，plan v9 P7）
  if (import.meta.env.DEV) (window as unknown as { __renders?: number }).__renders = ((window as unknown as { __renders?: number }).__renders ?? 0) + 1;
  const { message, modal } = App.useApp();
  const [leftW, setLeftW] = usePersisted('leftW', 240);
  const [rightW, setRightW] = usePersisted('rightW', 350);
  const narrow = useMedia('(max-width: 1199px)');
  const tiny = useMedia('(max-width: 799px)');
  /** 實驗頁：寬度 < 1100 px 時設計區變抽屜（plan v12 §5.4）。 */
  const labNarrow = useMedia('(max-width: 1099px)');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  /** 3D 上滑過的說明（plan v9 P7：放在 live value，只有頁尾那一小段文字重 render）。 */
  const hover = useLiveValue<string | null>(null);
  const [tab, setTab] = useState('props');
  /** 從右鍵、角把手開的卡片（頁面座標）。 */
  const [cardAt, setCardAt] = useState<CardAt | null>(null);
  const selSig = [...ed.sel].sort().join(',');
  useEffect(() => setCardAt(null), [selSig, ed.orig]);
  /** 剖面：軸、留哪一半、每軸各自的位置（和十字分開，點選結構不會讓剖面跳走）。 */
  const [clipOn, setClipOn] = useState(false);
  const [clipAxis, setClipAxis] = useState<Axis>('z');
  const [clipSide, setClipSide] = useState<1 | -1>(1);
  const [clipPos, setClipPos] = useState<Record<Axis, number>>({ x: 0, y: 0, z: 0 });
  /** 剖面跟著十字（plan v10 §4.7：位置只有一個概念）；解開鎖頭才和十字分開。 */
  const [clipFollow, setClipFollow] = useState(true);
  /** 改後／改前／差異（plan v10 §4.3：改後不染色，要看差異切「差異」）。 */
  const [mode, setMode] = useState<ViewMode>('now');
  /**
   * 2D 編輯：主畫面換成 editAxis 方向的切面編輯器，3D 與另外兩張切面縮到小窗。
   * 預設（false）主畫面是 3D；每次載入新檔案都從 3D 開始。
   */
  const editing = ed.focus?.view === '2d';
  /** 這個 session 裡使用者自己挑過切面方向：之後進入 2D 編輯沿用，不再自動選。 */
  const axisPicked = useRef(false);
  const focus: Axis | null = editing ? ed.editAxis : null;
  /** 主切面上滑鼠所在的體素（plan v9 P7：同上，只有標題列的座標重 render）。 */
  const sliceHover = useLiveValue<Vec3 | null>(null, sameVec);
  const [xray, setXray] = useState(false);
  const [translucent, setTranslucent] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 「在 3D 看」回到編輯頁後要對準差異（View3D 掛載、網格換上之後）。 */
  /** 切到編輯頁後要對準什麼：'diff'＝目前 split 的差異外框、BBox＝某個結構（設計區的「在 3D 看」）。 */
  const pendingFocus = useRef<false | 'diff' | BBox>(false);
  /** 實驗頁的「在 3D 看」（plan v12 §5.4、§10 D10）：設為目前（parked 先載入）→ 切到編輯頁 → 對準差異。 */
  const open3D = async (id: string) => {
    await ed.setActiveId(id);
    pendingFocus.current = 'diff';
    ed.setPage('edit');
  };
  const openStructure3D = () => {
    pendingFocus.current = ed.selBox ?? 'diff';
    ed.setPage('edit');
  };
  useEffect(() => {
    if (ed.page !== 'edit' || !pendingFocus.current) return;
    let tries = 0;
    let t: ReturnType<typeof setTimeout>;
    // View3D 是 lazy 載入、剛掛載：等它的 handle 出現再對準
    const go = () => {
      const v = view.current;
      const want = pendingFocus.current;
      const b = want === 'diff' ? look.current.ed.diffBox : want || null;
      if (v && b) {
        pendingFocus.current = false;
        v.focusBox(b);
      } else if (v && !b) pendingFocus.current = false;
      else if (++tries < 40) t = setTimeout(go, 100);
    };
    t = setTimeout(go, 150);
    return () => clearTimeout(t);
  }, [ed.page, ed.activeId, ed.diffBox]);
  const tagRef = useRef<HTMLDivElement>(null);
  const view = useRef<View3DHandle | null>(null);
  /** 即時預覽：這一步在主執行緒裁切重算的結果；3D 與切面先畫它，Worker 的正式結果到了再換掉。 */
  const [pv, setPv] = useState<PV | null>(null);
  /**
   * 第 2 級預覽（plan v9 §4.5）搬到 Worker：同時最多一個拖拉預覽在飛、永遠送最新的 op、拖拉結束後晚到的丟掉；
   * 放開／按鈕的預覽（committed）在 apply 之前送出（Worker 依序處理，先回預覽再算正式結果）。
   */
  const livePv = useLiveValue<PV | null>(null);
  const live2 = useRef({ inflight: false, pending: null as Op | null, sent: null as Op | null, seq: 0, dragging: false });
  const look = useRef({ ed });
  look.current = { ed };
  const sendPreview = (op: Op, committed: boolean, cap: number) => {
    const L = live2.current;
    const { ed: e } = look.current;
    const cur = e.cur;
    const base = sidOf(cur);
    const seq = ++L.seq;
    if (!committed) {
      L.inflight = true;
      L.sent = op;
    }
    const done = () => {
      if (committed) return;
      L.inflight = false;
      if (L.dragging && L.pending && L.pending !== L.sent) sendPreview(L.pending, false, cap);
    };
    previewIn(cur, { op, cap, hidden: hiddenTable(e.hidden), palette: palette(e.materials), showDiff: false, seq, mesh: true }).then(
      (r) => {
        const fresh = r.seq === L.seq && sidOf(look.current.ed.cur) === base && (committed || L.dragging);
        if (fresh) {
          if ('none' in r) {
            livePv.set(null);
            setPv((p) => (committed || (p && !p.committed) ? null : p));
            if (!committed) setLiveCells(cellCloud(op, look.current.ed.vol));
          } else if (committed) {
            livePv.set(null);
            setPv({ box: r.box, data: r.data, mesh: r.mesh ?? undefined, base, committed });
          } else {
            livePv.set({ box: r.box, data: r.data, mesh: r.mesh ?? undefined, base, committed });
            setLiveCells(null);
          }
        }
        done();
      },
      () => done(),
    );
  };
  /**
   * 預覽一步：沒有 profile 的 Op 在主執行緒先用 previewBox 判斷上限（同步回傳畫不畫得出來，3D 筆刷用它收掉橘色塊）；
   * profile 的外框要描襯層，交給 Worker 判斷，超過上限回 none 再畫點雲。
   */
  const makePreview = (op: Op, cap: number, committed: boolean) => {
    if (mode !== 'now' || op.kind === 'material') return false;
    if (op.kind !== 'profile') {
      const box = previewBox(ed.cur, op);
      if (!box || boxVoxels(box) > cap) {
        if (committed) setPv(null);
        else setPv((p) => (p && !p.committed ? null : p));
        return false;
      }
    }
    if (committed) {
      live2.current.dragging = false;
      sendPreview(op, true, cap);
      return true;
    }
    const L = live2.current;
    L.dragging = true;
    L.pending = op;
    if (!L.inflight) sendPreview(op, false, cap);
    return true;
  };
  /** 六面小方塊滑過的方向：主切面那條邊亮起（live value，整頁不 render）。 */
  const faceHi = useLiveValue<Vec3 | null>(null, sameVec);
  /** 卡片（plan v10 §4.4）用的畫面功能：身分不變，裡面呼叫最新一次 render 的函式。 */
  const hostFns = useRef({ makePreview: (_op: Op) => false as boolean, endLive: () => {}, changeMaterial: (_id: number) => {} });
  const cardHost = useMemo<CardHost>(
    () => ({
      preview: (op) => {
        if (!op) {
          hostFns.current.endLive();
          return false;
        }
        return hostFns.current.makePreview(op);
      },
      highlight: (d) => {
        view.current?.highlightFace(d);
        faceHi.set(d);
      },
      onMaterial: (id) => hostFns.current.changeMaterial(id),
    }),
    [],
  );
  // 開發模式：e2e（scripts/e2e/m10.cjs）讀卡片的預覽
  if (import.meta.env.DEV) (window as unknown as { __livePv?: unknown }).__livePv = livePv;
  /** 拖拉結束或取消：之後晚到的拖拉預覽一律丟掉。 */
  const endLive = () => {
    live2.current.dragging = false;
    live2.current.pending = null;
    livePv.set(null);
    setPv((p) => (p && !p.committed ? null : p));
  };
  // 每一步送 Worker 前先預覽（按鈕、方向鍵、筆刷放開都走 commit）
  useEffect(() => {
    ed.previewHook.current = (op) => void makePreview(op, COMMIT_PREVIEW_CAP, true);
  });
  // 計算結束但狀態沒變（失敗或沒改到）：預覽收掉；換檔案也收掉
  useEffect(() => {
    if (!ed.busy && pv?.committed && pv.base === sidOf(ed.cur)) setPv(null);
  }, [ed.busy, ed.cur, pv]);
  useEffect(() => {
    setPv(null);
    livePv.set(null);
  }, [ed.orig, mode, livePv]);
  /** 切面要畫的預覽：只有根據的陣列還是現在這份才有效（正式結果到了切面本來就會重畫）。 */
  const slicePv = pv && pv.base === sidOf(ed.cur) && mode === 'now' ? pv : null;

  const cursorAt = (a: Axis) => (a === 'x' ? ed.cursor[0] : a === 'y' ? ed.cursor[1] : ed.cursor[2]);
  const axisMax = (a: Axis) => (a === 'x' ? ed.vol.X : a === 'y' ? ed.vol.Y : ed.vol.Z) - 1;
  const setCursorAxis = (a: Axis, v: number) => {
    const next: Vec3 = [...ed.cursor];
    next[a === 'x' ? 0 : a === 'y' ? 1 : 2] = Math.max(0, Math.min(axisMax(a), Math.round(v)));
    ed.setCursor(next);
  };
  const setClipAt = (a: Axis, v: number) => {
    if (clipFollow) setCursorAxis(a, v);
    else setClipPos((p) => ({ ...p, [a]: Math.max(0, Math.min(axisMax(a), Math.round(v))) }));
  };
  const toggleClip = () => {
    // 開啟時從十字的位置開始
    if (!clipOn) setClipPos((p) => ({ ...p, [clipAxis]: cursorAt(clipAxis) }));
    setClipOn(!clipOn);
  };

  // B：改後 ⇄ 改前；D：改後 ⇄ 差異；, .：剖面前後一片；F 對準選取、H 全貌、1/2/3/4 視角；Esc：還原放大的切面
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (typingIn(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 實驗頁沒有 3D：單鍵只留 ?
      if (ed.page === 'lab') {
        if (e.key === '?' && !overlayOpen()) setHelpOpen(true);
        return;
      }
      // 說明、設定、Modal 開著時單鍵留給它們，不動 3D
      if (overlayOpen()) return;
      const k = e.key.toLowerCase();
      const views: Record<string, ViewPreset> = { f: 'fit', h: 'home', home: 'home', '1': 'front', '2': 'top', '3': 'side', '4': 'iso' };
      if (editing && (e.key === ',' || e.key === '.' || e.key === 'PageUp' || e.key === 'PageDown')) {
        // 2D 編輯：換主切面的片（PgUp／PgDn 不再是整塊前後移動）
        e.preventDefault();
        e.stopImmediatePropagation();
        ed.stepCursor(ed.editAxis, e.key === '.' || e.key === 'PageDown' ? (e.shiftKey ? 10 : 1) : e.shiftKey ? -10 : -1);
        return;
      }
      if (k === 'e') {
        // E（D9）：瀏覽 → 3D 把手 → 2D 剖面 → 瀏覽。2D 剖面裡 E 點一下＝回瀏覽；按住＝只抓邊（放開時判斷）
        if (editing) {
          if (!e.repeat) {
            eDownAt.current = Date.now();
            draggedSinceE.current = false;
          }
        } else if (!ed.sel.size) message.info({ key: 'edit', content: '先選一個結構，再按 E 進入聚焦編輯' });
        else if (ed.focus) enterEdit();
        else enterFocus();
        return;
      }
      if (k === 'g') {
        // 對準差異（plan v12 §5.4）
        if (ed.diffBox) view.current?.focusBox(ed.diffBox);
        else message.info({ key: 'aim', content: '這個 split 還沒有改動' });
        return;
      }
      if (k === 'b') setMode((m) => (m === 'orig' ? 'now' : 'orig'));
      else if (k === 'd') setMode((m) => (m === 'diff' ? 'now' : 'diff'));
      else if ((e.key === ',' || e.key === '.') && clipOn) setClipAt(clipAxis, (clipFollow ? cursorAt(clipAxis) : clipPos[clipAxis]) + (e.key === '.' ? 1 : -1));
      else if (views[k]) view.current?.setView(views[k]);
      else if (e.key === '?') setHelpOpen(true);
      else if (e.key === 'Escape' && cardAt && !ed.menu) {
        // 先關卡片
        e.stopImmediatePropagation();
        setCardAt(null);
      } else if (e.key === 'Escape' && ed.focus && !ed.menu) {
        // 離開聚焦編輯，選取與範圍留著（右鍵選單開著時先關選單）
        e.stopImmediatePropagation();
        leaveFocus();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'e' || !editing || typingIn(e.target)) return;
      if (Date.now() - eDownAt.current < 300 && !draggedSinceE.current) leaveFocus();
    };
    window.addEventListener('keydown', down, { capture: true });
    window.addEventListener('keyup', up, { capture: true });
    return () => {
      window.removeEventListener('keydown', down, { capture: true });
      window.removeEventListener('keyup', up, { capture: true });
    };
  });
  const eDownAt = useRef(0);
  const draggedSinceE = useRef(false);

  /** 拖動中：主切面只算這一片（第 1 級）；範圍小的話 3D 與小切面也即時（第 2 級）。 */
  // 第 1 級（主切面這一片）每一幀都換：同樣不進整頁的 state，只有主切面重 render（plan v9 P7）
  const dragPv = useLiveValue<PV | null>(null);
  const setDragPv = dragPv.set;
  const onLive = (op: Op | null) => {
    if (!op) {
      setDragPv(null);
      setLiveCells(null);
      endLive();
      return;
    }
    const a = ed.editAxis;
    const t = cursorAt(a);
    if (op.scope.axis === a && t >= op.scope.lo && t <= op.scope.hi) {
      // 第 1 級：主切面這一片（第二層的加／拿格子與「會被擋住」都從這裡來）
      const rep = newReport();
      const p = previewOp(ed.cur, ed.orig.vol, { ...op, scope: { axis: a, lo: t, hi: t } } as Op, 2_000_000, rep);
      setDragPv(p ? { ...p, base: sidOf(ed.cur), committed: false, blocked: globalIndex(p.box, ed.vol, rep.blockedAt) } : null);
    } else setDragPv(null);
    // 第 2 級：3D 與小切面（Worker）；範圍太大就畫加／拿格子的點雲（§8.3，Worker 回 none 時）
    if (!makePreview(op, LIVE_PREVIEW_CAP, false)) setLiveCells(cellCloud(op, ed.vol));
  };
  /** 超過即時預覽上限時，3D 畫的加／拿格子（沿範圍擠出；不算 kernel，被擋的不會顯示）。 */
  // 拖拉中每幀都換：同樣不進整頁的 state，只有 3D 重 render（plan v9 P7）
  const liveCells = useLiveValue<CellCloud | null>(null);
  const setLiveCells = liveCells.set;
  /** 「看這些片」：跳到下一個有被擋住的片（循環）。 */
  const jumpBlocked = () => {
    const r = ed.report;
    if (!r?.slices.length) return;
    const a = r.axis;
    const cur = cursorAt(a);
    const next = r.slices.find((s) => s.at > cur) ?? r.slices[0];
    if (!editing || ed.editAxis !== a) {
      ed.setEditAxis(a);
      ed.setFocus({ view: '2d', tool: ed.focus?.tool ?? 'handles' });
    }
    setCursorAxis(a, next.at);
  };

  /**
   * 進入 2D 編輯：方向＝使用者挑過的，否則選取最長的那一軸當法線；
   * 主切面跳到十字那一片，那一片沒有選取就跳到最近有的一片。
   */
  const enterEdit = (pick?: Axis) => {
    let axis = ed.editAxis;
    if (pick) {
      axis = pick;
      axisPicked.current = true;
    } else if (!axisPicked.current) axis = longestAxis(ed) ?? axis;
    ed.setEditAxis(axis);
    if (ed.selMask) {
      const t = nearestSlice(slicesWith(ed.selMask, ed.vol, axis, ed.selBox), ed.cursor[axisIndex(axis)]);
      if (t !== null && t !== ed.cursor[axisIndex(axis)]) setCursorAxis(axis, t);
    }
    ed.setFocus({ view: '2d', tool: ed.focus?.tool ?? 'handles' });
  };
  /** 2D 剖面 → 3D（還在聚焦編輯，把手）。 */
  const leaveEdit = () => ed.setFocus({ view: '3d', tool: 'handles' });
  /**
   * 進入聚焦編輯（plan v10 §4.5）：3D 把手、相機對準、範圍設成整根、其他結構半透明。
   * 入口：E、雙擊已選結構、右鍵「編輯 {結構}」、工具列頁籤。
   */
  const enterFocus = (tool: 'handles' | 'brush' = 'handles') => {
    if (!ed.sel.size) return;
    const first = !ed.focus;
    ed.setScopeMode('whole');
    ed.setFocus({ view: '3d', tool });
    if (first) setTimeout(() => view.current?.setView('fit'), 0);
    if (!seenFocusHint) {
      setSeenFocusHint(true);
      message.info({ key: 'focus-hint', duration: 8, content: '聚焦編輯：拖箭頭＝整面長縮 · 拖角＝圓頭 · 其他地方拖＝轉視角（E 切到 2D 剖面，Esc 離開）' });
    }
  };
  const leaveFocus = () => ed.setFocus(null);
  const onTab = (t: EditTab) => {
    if (t === 'browse') leaveFocus();
    else if (t === '2d') enterEdit();
    else enterFocus(t);
  };
  const [seenFocusHint, setSeenFocusHint] = usePersisted('seenFocusHint', false);
  // 改名後舊使用者找不到（plan v10 §8）：第一次開新版本提示一次，? 裡有對照表
  const [seenRename, setSeenRename] = usePersisted('seenV10Rename', false);
  useEffect(() => {
    if (!ed.ready || seenRename) return;
    setSeenRename(true);
    message.info({ key: 'rename', duration: 10, content: '改名了：長高／縮短 → 長／縮、補平 → 方頭、現在／原始 → 改後／改前、2D 編輯 → 聚焦編輯（E）。按 ? 看對照表' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.ready]);
  /** 頁籤換方向（記住，之後進入沿用）。 */
  const pickAxis = (a: Axis) => {
    axisPicked.current = true;
    ed.setEditAxis(a);
    if (ed.selMask) {
      const t = nearestSlice(slicesWith(ed.selMask, ed.vol, a, ed.selBox), ed.cursor[axisIndex(a)]);
      if (t !== null && t !== ed.cursor[axisIndex(a)]) setCursorAxis(a, t);
    }
  };
  // 載入新檔案：回到 3D、重新自動選方向
  useEffect(() => {
    axisPicked.current = false;
  }, [ed.orig]);
  /** 選取沿主切面法線每一片有沒有（位置列「這一片沒有…跳到最近的一片」）。 */
  const selSlices = useMemo(
    () => (editing && ed.selMask ? slicesWith(ed.selMask, ed.vol, ed.editAxis, ed.selBox) : null),
    [editing, ed.selMask, ed.vol, ed.editAxis],
  );

  // 剛套用一步：訊息＋「復原」，3D 選取框閃一下
  useEffect(() => {
    // 實驗頁的訊息（已產生、撤銷這次產生）由設計區自己顯示
    if (!ed.last || ed.page === 'lab') return;
    view.current?.flash();
    // 改後不標色（plan v12 §5.1 D1）：只在改到的外框畫橘色虛線，1.5 秒淡出
    if (ed.last.box && ed.stepFlash && mode === 'now') view.current?.stepBox(ed.last.box);
    message.open({
      key: 'last',
      type: 'success',
      duration: 4,
      content: (
        <span>
          {ed.last.text}
          {!!ed.report?.slices.length && (
            <Typography.Link style={{ marginLeft: 10 }} onClick={jumpBlocked}>
              看這些片
            </Typography.Link>
          )}
          {ed.hist.length > 0 && (
            <Typography.Link style={{ marginLeft: 10 }} onClick={() => (ed.undo(), message.destroy('last'))}>
              復原
            </Typography.Link>
          )}
        </span>
      ),
    });
  }, [ed.last]);

  useEffect(() => {
    if (mode === 'diff' && !ed.diff.count) setMode('now');
  }, [mode, ed.diff.count]);

  // 有還沒匯出的改動時，關閉或重新整理前先問一下（全部狀態都只在記憶體）
  const dirty = ed.splits.some((s) => s.ops.length > 0);
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  const peek = mode === 'orig';
  const shown = peek ? ed.orig.vol : ed.vol;
  const clip: Clip | null = clipOn ? { axis: clipAxis, at: Math.min(axisMax(clipAxis), clipFollow ? cursorAt(clipAxis) : clipPos[clipAxis]), side: clipSide } : null;
  const selBBox = useMemo(() => {
    const b = unionBBox(ed.selComps);
    if (!b) return null;
    return clipBox(b, ed.scope) ?? b;
  }, [ed.selComps, ed.scope]);
  /** 只有差異模式描邊（plan v10 §4.3）。 */
  const diffShown = mode === 'diff' && ed.diff.count ? ed.diff.mask : null;

  // ---- 匯出：.vti（同 Extent／Spacing／Origin）或 .npy ----

  /** vti＝和輸入同格式（輸入是比例陣列時照原檔寫回，plan v11 §4.0）；vti1＝單一 UInt8 編號；npy。 */
  type Fmt = 'vti' | 'vti1' | 'npy';
  const ext = (fmt: Fmt) => (fmt === 'npy' ? 'npy' : 'vti');
  const stem = (ed.meta.name ?? 'tcad').replace(/\.(npy|vti)$/i, '');
  const spacing = ed.meta.spacing ?? [ed.nmPerVoxel, ed.nmPerVoxel, ed.nmPerVoxel];
  const origin = ed.meta.origin ?? [0, 0, 0];
  const like = !!(ed.meta.raw && ed.meta.fractions);
  /** 編碼在 Worker 裡做（plan v12 §5.3）：live 用帳簿、parked 用補丁，一個一個來。 */
  const encode = (s: Split | null, fmt: Fmt): Promise<Uint8Array> =>
    ed.exportBytes(s, { format: fmt, spacing, origin, arrayName: ed.meta.arrayName && !like ? ed.meta.arrayName : 'material' });
  const exportOne = (fmt: Fmt = 'vti') => {
    const name = ed.isBase || !ed.active ? `${stem}.${ext(fmt)}` : `${stem}__${safeName(ed.active.name)}.${ext(fmt)}`;
    encode(ed.isBase ? null : ed.active, fmt)
      .then((data) => download(data, name))
      .then((saved) => message.success(`已匯出 ${saved}`))
      .catch((e: { code?: string }) => e?.code !== 'declined' && message.error('匯出失敗'));
  };
  /** 全部匯出前先列出會打包哪些 split（名稱、步數、檔名），確認了才寫檔。 */
  const confirmExportAll = (fmt: Fmt = 'vti', only?: string[]) => {
    const fileOf = (s: { name: string }) => `${stem}__${safeName(s.name)}.${ext(fmt)}`;
    const chosen = ed.splits.filter((s) => (only ? only.includes(s.id) : !ed.exportOff.has(s.id)));
    modal.confirm({
      title: `打包 ${chosen.length} 個 split 成 zip（.${ext(fmt)}${fmt === 'vti1' ? '，單一編號' : ''}）`,
      icon: <DownloadOutlined style={{ color: 'var(--c-primary)' }} />,
      width: 520,
      okText: '匯出 zip',
      cancelText: '取消',
      content: (
        <Flex vertical gap={6} style={{ marginTop: 8 }}>
          {chosen.map((s) => (
            <Flex key={s.id} justify="space-between" gap={12} style={{ fontSize: 13 }}>
              <span>
                {s.name}
                <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                  {s.ops.length ? `${s.ops.length} 步` : '沒有改動'}
                </Text>
              </span>
              <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                {fileOf(s)}
              </Text>
            </Flex>
          ))}
          <Text type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
            另附 manifest.json（材質名稱與顏色、每個 split 的步驟）；shape、spacing、origin 都和原始相同。
          </Text>
        </Flex>
      ),
      onOk: () => exportAll(fmt, only),
    });
  };
  const exportAll = async (fmt: Fmt = 'vti', only?: string[]) => {
    const fileOf = (s: { name: string }) => `${stem}__${safeName(s.name)}.${ext(fmt)}`;
    const files: { name: string; data: Uint8Array }[] = [];
    const chosen = ed.splits.filter((s) => (only ? only.includes(s.id) : !ed.exportOff.has(s.id)));
    try {
      for (let k = 0; k < chosen.length; k++) {
        message.open({ key: 'export', type: 'loading', duration: 0, content: `匯出中 ${k + 1}／${chosen.length}：${chosen[k].name}` });
        files.push({ name: fileOf(chosen[k]), data: await encode(chosen[k], fmt) });
      }
      message.destroy('export');
    } catch (e) {
      message.destroy('export');
      message.error(`匯出失敗：${(e as Error)?.message ?? e}`);
      return;
    }
    const manifest = buildManifest({
      source: ed.meta.name ?? 'demo',
      format: ext(fmt),
      ...(ed.meta.input ? { input: { ...ed.meta.input, output: fmt === 'vti' && like ? 'same-as-input' : fmt === 'npy' ? 'npy-uint8' : 'CellData-uint8' } } : {}),
      materials: ed.materials.map((m) => ({ ...m, source: ed.meta.materialSource ?? 'auto' })),
      shape: [ed.vol.Z, ed.vol.Y, ed.vol.X],
      spacing,
      origin,
      nmPerVoxel: ed.nmPerVoxel,
      designs: ed.designs,
      splits: chosen.map((s) => ({ ...s, changedVoxels: changedOf(s) })),
      fileOf,
      opText: (op) => ed.opText(op, ed.orig.L),
    });
    files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    const name = `${stem}__splits.zip`;
    download(zipStore(files), name, 'application/zip')
      .then((saved) => message.success(`已匯出 ${saved}`))
      .catch((e: { code?: string }) => e?.code !== 'declined' && message.error('匯出失敗'));
  };

  // ---- 右鍵選單：選取相關；聚焦編輯中點在結構上多編輯項（plan v10 §4.5） ----

  const menuComp = ed.menu?.key ? ed.compByKey.get(ed.menu.key) : undefined;
  const closeMenu = () => ed.setMenu(null);
  const behind = (ed.menu?.along ?? []).filter((k) => k !== menuComp?.key).map((k) => ed.compByKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
  const openCard = (c: CardAt) => {
    closeMenu();
    setCardAt(c);
  };
  /** 選單開在哪（頁面座標）：卡片也開在那裡。 */
  const menuPage = () => ({ x: menuAt?.x ?? 200, y: menuAt?.y ?? 200 });
  const mn = ed.menu?.n ?? null;
  const editable = !!menuComp && ed.sel.has(menuComp.key) && !peek;
  /** 2D 剖面右鍵點在選取外框的角附近（各邊 30% 以內）：那個角（「圓角…」預先勾好）。 */
  const corner2d = ((): CornerId | null => {
    const b = ed.selBox;
    const v = ed.menu?.voxel;
    if (!editing || !b || v == null) return null;
    const p = ed.voxelCoord(v);
    const [ua, va] = ed.editAxis === 'z' ? [0, 1] : ed.editAxis === 'y' ? [0, 2] : [2, 1];
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    const fu = (p[ua] - lo[ua] + 0.5) / (hi[ua] - lo[ua] + 1);
    const fv = (p[va] - lo[va] + 0.5) / (hi[va] - lo[va] + 1);
    const nu = fu < 0.3 ? 'l' : fu > 0.7 ? 'r' : null;
    const nv = fv < 0.3 ? 'u' : fv > 0.7 ? 'l' : null;
    return nu && nv ? ((nv + nu) as CornerId) : null;
  })();
  const editItems: NonNullable<MenuProps['items']> =
    menuComp && editable && ed.focus
      ? [
          ...(ed.menu?.voxel != null
            ? [{ key: 'aim', icon: <AimOutlined />, label: '對準這裡', onClick: () => (view.current?.lookAt(ed.voxelCoord(ed.menu!.voxel!)), closeMenu()) }]
            : []),
          ...(mn
            ? [
                { key: 'push', label: `${directionName(mn)}長／縮…`, onClick: () => openCard({ kind: 'push', dir: mn, ...menuPage() }) },
                { key: 'level', label: `方頭（往${directionName(mn).slice(1)}）`, disabled: !!ed.busy, onClick: () => (ed.levelWhole(mn), closeMenu()) },
              ]
            : []),
          ...(editing && corner2d
            ? [{ key: 'corner', label: `圓角（${CORNER_NAME[corner2d]}）…`, onClick: () => openCard({ kind: 'shape', round: { corners: [{ id: corner2d }] }, ...menuPage() }) }]
            : []),
          { key: 'round', label: '圓頭…', onClick: () => openCard({ kind: 'shape', ...menuPage() }) },
          {
            key: 'mat',
            label: '換材質',
            children: ed.materials
              .filter((m) => m.id !== 0)
              .map((m) => ({ key: `mat-${m.id}`, label: <MatLabel mat={m} />, onClick: () => (changeMaterial(m.id), closeMenu()) })),
          },
          ...(mn && ed.menu?.voxel != null
            ? [
                {
                  key: 'slice2d',
                  label: '在這個面上看 2D 剖面',
                  onClick: () => {
                    const a: Axis = mn[0] ? 'x' : mn[1] ? 'y' : 'z';
                    ed.setCursor(ed.voxelCoord(ed.menu!.voxel!));
                    closeMenu();
                    enterEdit(a);
                  },
                },
              ]
            : []),
          { type: 'divider' as const },
        ]
      : menuComp && editable && !ed.focus
        ? [{ key: 'focus', icon: <EditOutlined />, label: `編輯 ${menuComp.label}（E）`, onClick: () => (closeMenu(), enterFocus()) }, { type: 'divider' as const }]
        : menuComp && !peek
          ? [{ key: 'focus', icon: <EditOutlined />, label: `編輯 ${menuComp.label}`, onClick: () => (ed.selectKeys([menuComp.key]), closeMenu(), setTimeout(() => enterFocus(), 0)) }, { type: 'divider' as const }]
          : [];
  const menuItems: MenuProps['items'] = menuComp
    ? [
        ...editItems,
        { key: 'only', label: `只選 ${menuComp.label}`, onClick: () => (ed.selectKeys([menuComp.key]), closeMenu()) },
        {
          key: 'add',
          label: ed.sel.has(menuComp.key) && ed.sel.size > 1 ? '從選取中移除' : '加入選取（同 Shift＋點）',
          onClick: () => (ed.selectKeys([menuComp.key], 'toggle'), closeMenu()),
        },
        { key: 'samemat', label: `選全部的 ${ed.matName(menuComp.mat)}`, onClick: () => (ed.selectMaterial(menuComp.mat), closeMenu()) },
        ...(behind.length
          ? [
              {
                key: 'behind',
                label: `選它後面的結構（${behind.length}）`,
                children: behind.map((c) => ({
                  key: `b-${c.key}`,
                  label: <MatLabel mat={matOf(ed, c.mat)} />,
                  extra: c.label,
                  onClick: () => (ed.selectKeys([c.key]), closeMenu()),
                })),
              },
            ]
          : []),
        { type: 'divider' as const },
        {
          key: 'hide',
          icon: <EyeInvisibleOutlined />,
          label: `隱藏 ${ed.matName(menuComp.mat)}（看裡面）`,
          onClick: () => (ed.toggleHidden(menuComp.mat), closeMenu()),
        },
        { key: 'clear', label: '取消選取', onClick: () => (ed.clearSel(), closeMenu()) },
      ]
    : [
        { key: 'all', label: '全選（Ctrl+A）', onClick: () => (ed.selectAll(), closeMenu()) },
        {
          key: 'show',
          label: '顯示全部材質',
          disabled: !ed.hidden.size,
          onClick: () => ([...ed.hidden].forEach((m) => ed.toggleHidden(m)), closeMenu()),
        },
        { key: 'clear', label: '取消選取', onClick: () => (ed.clearSel(), closeMenu()) },
      ];

  useEffect(() => {
    if (!ed.menu) return;
    const away = (e: PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ctxmenu')) ed.setMenu(null);
    };
    window.addEventListener('pointerdown', away, { capture: true });
    return () => window.removeEventListener('pointerdown', away, { capture: true });
  }, [ed.menu]);

  // 「剛做了什麼」顯示 4 秒
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ed.last) return;
    const t = setTimeout(() => tick((n) => n + 1), 4100);
    return () => clearTimeout(t);
  }, [ed.last]);
  const hot = !!ed.last && Date.now() - ed.last.at < 4000;

  /** 換材質：先在 GPU 上把選取的面改色（幾十毫秒），再送 Worker；正式網格幾秒後覆蓋。 */
  const changeMaterial = (id: number) => {
    const m = ed.materials.find((x) => x.id === id);
    if (m && ed.affMask) view.current?.recolor(ed.affMask, hexToRgb(m.color));
    ed.setMaterial(id);
  };
  hostFns.current = { makePreview: (op) => makePreview(op, LIVE_PREVIEW_CAP, false), endLive, changeMaterial };

  const pickInSlice = (p: [number, number, number], mode: SelectMode) => {
    ed.setCursor(p);
    ed.pickVoxel((p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0], mode);
  };
  const selKey = [...ed.sel].sort().join(',');
  /** 頁籤提示：這個方向可以改什麼（例如「上視 XZ · TiN 可改 x、z」）。 */
  const tabHint = (a: Axis) => {
    const [u, v] = a === 'z' ? ['x', 'y'] : a === 'y' ? ['x', 'z'] : ['z', 'y'];
    const dims: Record<string, string> = { x: '寬 W', y: '高 H', z: '深 D' };
    const who = ed.selComps.length === 1 ? ed.selComps[0].label : ed.selComps.length ? `已選的 ${ed.selComps.length} 個` : '結構';
    return `${AXIS_TAB[a]}：${who} 可改 ${u}、${v}（${dims[u]}、${dims[v]}），沿 ${a} 套用到範圍`;
  };
  /** 編輯狀態的主切面：頁籤、位置列、可縮放的切面編輯器。 */
  const mainSlice = (axis: Axis) => {
    const at = cursorAt(axis);
    return (
      <div className="pane slice-pane big main-slice" key={axis} data-axis={axis}>
        <div className="pane-head">
          <Tooltip title="回到 3D 把手；E 回瀏覽、Esc 離開聚焦，選取與範圍會留著">
            <Button size="small" icon={<LeftOutlined />} onClick={leaveEdit}>
              回 3D
            </Button>
          </Tooltip>
          <Segmented
            size="small"
            value={axis}
            onChange={(v) => pickAxis(v as Axis)}
            options={(['z', 'y', 'x'] as Axis[]).map((a) => ({ label: <Tooltip title={tabHint(a)}>{AXIS_TAB[a]}</Tooltip>, value: a }))}
          />
          <span className="grow" />
          <HoverReadout live={sliceHover} data={shown.data} vol={ed.vol} matName={ed.matName} />
        </div>
        <PositionBar ed={ed} axis={axis} has={selSlices} onJumpBlocked={jumpBlocked} />
        <div className="slice-body">
          <WithLivePv key={axis} live={dragPv} pv={null}>
            {(dp) => (
              <WithLivePv live={livePv} pv={null}>
                {(lp) => (
                  <WithLivePv live={faceHi} pv={null}>
                    {(fh) => (
              <SliceEditor
                freeform={ed.freeform}
                vol={shown}
                axis={axis}
                at={at}
                materials={ed.materials}
                hidden={ed.hidden}
                selMask={peek ? null : ed.affMask}
                cursor={ed.cursor}
                scope={ed.sel.size ? ed.scope : null}
                diff={diffShown}
                preview={dp ?? (lp && lp.base === sidOf(ed.cur) && mode === 'now' ? lp : null) ?? slicePv}
                selBox={peek ? null : (unionBBox(ed.selComps) ?? null)}
                faceHi={fh}
                focusKey={selKey}
                autoZoom={ed.autoZoom}
                onPick={pickInSlice}
                onStep={(d) => ed.stepCursor(axis, d)}
                onHover={sliceHover.set}
                L={peek ? undefined : ed.L}
                selKeys={peek ? [] : [...ed.sel]}
                gesture={{ scope: ed.scope, follow: ed.follow, backfill: ed.backfill, nm: ed.nmPerVoxel }}
                onCommit={ed.commit}
                onLive={onLive}
                blocked={ed.report?.cells ?? null}
                handle={ed.handle}
                setHandle={ed.setHandle}
                onDragState={(d) => {
                  if (d) draggedSinceE.current = true;
                }}
                mirror={ed.mirror && ed.sel.size > 1}
                onNote={(t) => message.warning({ key: 'mirror', content: t })}
                overlay={!peek && ed.sel.size ? <FloatingToolbar ed={ed} axis={axis} /> : undefined}
                geo={{ models: ed.models, version: ed.version, stepSeq: ed.stepSeq, outline: ed.outlineStyle, snap: ed.snapMode }}
                onMenu={(p, x, y) => {
                  const l = p ? ed.L.labels[(p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0]] : -1;
                  setMenuAt({ x, y });
                  ed.setMenu({ x, y, key: l >= 0 ? ed.L.comps[l].key : null, voxel: p ? (p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0] : null });
                }}
              />
                    )}
                  </WithLivePv>
                )}
              </WithLivePv>
            )}
          </WithLivePv>
        </div>
      </div>
    );
  };
  const slice = (axis: Axis) => {
    if (editing && axis === ed.editAxis) return mainSlice(axis);
    const at = cursorAt(axis);
    return (
      <div className="pane slice-pane" key={axis} data-axis={axis}>
        <div className="pane-head">
          <Text strong style={{ fontSize: 12 }}>
            {AXIS_NAME[axis]}
          </Text>
          <Space.Compact size="small" className="slice-pos">
            <Button icon={<LeftOutlined />} onClick={() => ed.stepCursor(axis, -1)} aria-label="上一片" />
            <InputNumber
              size="small"
              min={0}
              max={axisMax(axis)}
              value={at}
              onChange={(v) => v !== null && setCursorAxis(axis, v)}
              precision={0}
              prefix={<span style={{ color: 'var(--c-text-3)' }}>{axis} =</span>}
              style={{ width: 84 }}
            />
            <Button icon={<RightOutlined />} onClick={() => ed.stepCursor(axis, 1)} aria-label="下一片" />
          </Space.Compact>
          <Text type="secondary" className="slice-hint" style={{ fontSize: 11 }}>
            {(at * ed.nmPerVoxel).toFixed(1)} nm
          </Text>
          <span className="grow" />
          <Tooltip title={ed.sel.size ? '用這個方向進 2D 剖面' : '先選一個結構，再用這個方向進 2D 剖面'}>
            <Button
              type="text"
              size="small"
              className="slice-zoom"
              icon={<ExpandOutlined />}
              disabled={!ed.sel.size}
              onClick={() => (editing ? pickAxis(axis) : enterEdit(axis))}
              aria-label="用這個方向進 2D 剖面"
            />
          </Tooltip>
        </div>
        <div className="slice-body">
          <WithLivePv live={livePv} pv={pv}>
            {(p) => (
              <SliceView
                vol={shown}
                axis={axis}
                at={at}
                materials={ed.materials}
                hidden={ed.hidden}
                selMask={peek ? null : ed.affMask}
                cursor={ed.cursor}
                scope={ed.sel.size ? ed.scope : null}
                diff={diffShown}
                preview={p && p.base === sidOf(ed.cur) && mode === 'now' ? p : null}
                onPick={pickInSlice}
                onStep={(d) => ed.stepCursor(axis, d)}
              />
            )}
          </WithLivePv>
        </div>
      </div>
    );
  };

  // ---- 顯示（plan v10 §4.7：標題列一個彈窗收所有「怎麼看」的選項） ----
  const showPop = (
    <Flex vertical gap={10} style={{ width: 300 }}>
      <Flex align="center" justify="space-between" gap={8}>
        <span style={{ fontSize: 13 }}>空洞透視（VOID 永遠畫在最上面）</span>
        <Switch size="small" checked={xray} onChange={setXray} />
      </Flex>
      <Flex align="center" justify="space-between" gap={8}>
        <span style={{ fontSize: 13 }}>材質半透明（看得到內部）</span>
        <Switch size="small" checked={translucent} onChange={setTranslucent} />
      </Flex>
      <Divider style={{ margin: '2px 0' }} />
      <Flex align="center" justify="space-between" gap={8}>
        <Tooltip title="幾何線：拖過的斜邊是一條直線，放大到 8× 以上下面淡淡疊著真正的格子邊界；階梯：一直畫格子邊界">
          <span style={{ fontSize: 13 }}>2D 輪廓</span>
        </Tooltip>
        <Segmented
          size="small"
          value={ed.outlineStyle}
          onChange={(v) => ed.setOutlineStyle(v as 'geometry' | 'stairs')}
          options={[
            { label: '幾何線', value: 'geometry' },
            { label: '階梯', value: 'stairs' },
          ]}
        />
      </Flex>
      <Flex align="center" justify="space-between" gap={8}>
        <Tooltip title="放開才吸附：輪廓跟手、旁邊同時標出放開後會變成的格子；邊拖邊吸附：一格一格跳">
          <span style={{ fontSize: 13 }}>2D 吸附</span>
        </Tooltip>
        <Segmented
          size="small"
          value={ed.snapMode}
          onChange={(v) => ed.setSnapMode(v as 'release' | 'live')}
          options={[
            { label: '放開才吸附', value: 'release' },
            { label: '邊拖邊吸附', value: 'live' },
          ]}
        />
      </Flex>
    </Flex>
  );

  const selName = ed.selComps.length === 1 ? ed.selComps[0].label : `${ed.selComps.length} 個結構`;
  /** Worker 計算中：改體素的按鈕先 disabled，點了不會無聲被吞掉。 */
  const working = !!ed.busy;
  const whole = ed.scopeMode === 'whole';
  /** 3D 上的工具：只有聚焦在 3D 時才有（2D 剖面時小窗的 3D 只看）。 */
  const tool3d = ed.focus?.view === '3d' ? ed.focus.tool : null;
  const frame = ed.sel.size ? roundFrame(ed) : null;

  // 3D 標題列只放「怎麼看」（plan v10 §4.7）
  const pane3d = (
    <div className="pane pane-3d">
      <div className="pane-head">
        <Text strong style={{ fontSize: 12 }}>
          3D
        </Text>
        <Text type="secondary" ellipsis className="pane-sub" style={{ fontSize: 12, maxWidth: 240 }}>
          {ed.isBase ? '原始模型' : ed.active?.name}
          {ed.sel.size ? ` · 已選 ${selName}` : ' · 點一塊選取，Shift 多選'}
        </Text>
        <span className="grow" />
        {editing && (
          <Tooltip title="3D 放大成主畫面（3D 把手）">
            <Button type="text" size="small" className="pane-expand" icon={<ExpandOutlined />} onClick={leaveEdit} aria-label="回 3D" />
          </Tooltip>
        )}
        <Tooltip title={ed.diff.count > 0 ? 'B：改後 ⇄ 改前；D：改後 ⇄ 差異（沒改的半透明、改過的實色＋深藍邊、拿掉的紅）' : '還沒有改動；改了之後可以切到「改前」「差異」對照'}>
          <Segmented
            size="small"
            className="tb"
            value={mode}
            disabled={!ed.diff.count}
            onChange={(v) => setMode(v as ViewMode)}
            options={[
              { label: '改後', value: 'now' },
              { label: '改前', value: 'orig' },
              { label: '差異', value: 'diff' },
            ]}
          />
        </Tooltip>
        <Space.Compact size="small" className="tb">
          <Tooltip title="沿一個軸剖開 3D，剖口貼上切面圖；預設跟著十字，用滑桿或 , . 鍵移動">
            <Button type={clipOn ? 'primary' : 'default'} icon={<ScissorOutlined />} onClick={toggleClip} aria-label="剖面">
              <span className="tb-text">剖面</span>
            </Button>
          </Tooltip>
          <Popover content={showPop} trigger="click" placement="bottomRight" title="顯示">
            <Button icon={<EyeOutlined />} aria-label="顯示">
              <span className="tb-text">顯示</span>
            </Button>
          </Popover>
        </Space.Compact>
        <Space.Compact size="small" className="tb">
          <Tooltip title="復原上一步（Ctrl+Z）">
            <Button icon={<UndoOutlined />} disabled={!ed.hist.length || working} onClick={ed.undo} aria-label="復原">
              <span className="tb-text">復原</span>
            </Button>
          </Tooltip>
          <Tooltip title="重做（Ctrl+Y）">
            <Button icon={<RedoOutlined />} disabled={!ed.future.length || working} onClick={ed.redo} aria-label="重做">
              <span className="tb-text">重做</span>
            </Button>
          </Tooltip>
        </Space.Compact>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <WithLivePv live={liveCells} pv={null}>
          {(cells) => (
        <WithLivePv live={livePv} pv={pv}>
          {(p) => (
            <View3D
              state={peek ? ed.orig : ed.cur}
              materials={ed.materials}
              hidden={ed.hidden}
              selMask={peek ? null : ed.affMask}
              selComps={peek ? null : ed.selIdx}
              selBBox={peek ? null : selBBox}
              scope={ed.scope}
              cursor={ed.cursor}
              clip={clip}
              diffMask={diffShown}
              mode={mode}
              brush={ed.brush}
              tool={peek ? null : tool3d}
              dimOthers={!!ed.focus && !peek}
              cornerAxis={frame?.axis}
              faceOp={ed.pushOp}
              roundOp={(id: CornerId, r: number) =>
                frame ? roundOp(ed.L, ed.vol, [...ed.sel], frame.scope, frame.at, { kind: 'round', corners: [{ id }], r, n: 2, mode: 'match' }, ed.follow, ed.backfill, ed.nmPerVoxel) : null
              }
              onCommit={ed.commit}
              onCornerClick={(id, x, y) => {
                const r = wrapRef.current?.getBoundingClientRect();
                setCardAt({ kind: 'shape', x: (r?.left ?? 0) + x, y: (r?.top ?? 0) + y, round: { corners: [{ id }] } });
              }}
              onFocusSel={() => enterFocus()}
              nmPerVoxel={ed.nmPerVoxel}
              orig={ed.orig.vol}
              preview={p}
              cells={cells}
              onPreview={(op) => {
                if (op) return makePreview(op, LIVE_PREVIEW_CAP, false);
                endLive();
                return false;
              }}
              toOp={ed.opFor}
              onPick={(v, m) => {
                if (v === null) {
                  if (m === 'set') ed.clearSel();
                  return;
                }
                ed.pickVoxel(v, m);
                ed.setCursor(ed.voxelCoord(v));
              }}
              onMenu={(h, x, y) => {
                const r = wrapRef.current?.getBoundingClientRect();
                setMenuAt({ x: (r?.left ?? 0) + x, y: (r?.top ?? 0) + y });
                const l = h.voxel !== null ? ed.L.labels[h.voxel] : -1;
                ed.setMenu({ x, y, key: l >= 0 ? ed.L.comps[l].key : null, along: h.along });
              }}
              onSculpt={ed.sculpt}
              onHover={hover.set}
              floatRef={tagRef}
              handle={view}
              xray={xray}
              translucent={translucent}
              busy={!!ed.busy}
            />
          )}
        </WithLivePv>
          )}
        </WithLivePv>
        <div className="viewbar">
          {(
            [
              ['front', '正視', 'XY 正面（和下方第一張切面同方向）'],
              ['top', '上視', 'XZ 上視'],
              ['side', '側視', 'YZ 側面'],
              ['iso', '等角', '斜 45° 看全貌'],
              ['home', '全貌', '回到載入時的視角（雙擊空白也可以）'],
              ['fit', '對準選取', '把選取的結構放到畫面中央（雙擊模型＝繞著點到的地方轉）'],
            ] as [ViewPreset, string, string][]
          ).map(([k, label, tip]) => (
            <Tooltip key={k} title={tip}>
              <Button size="small" type="text" icon={k === 'fit' ? <AimOutlined /> : undefined} disabled={k === 'fit' && !ed.sel.size} onClick={() => view.current?.setView(k)}>
                {label}
              </Button>
            </Tooltip>
          ))}
          <Tooltip title="把這個 split 改到的地方放到畫面中央（G）">
            <Button size="small" type="text" icon={<AimOutlined />} disabled={!ed.diffBox} onClick={() => ed.diffBox && view.current?.focusBox(ed.diffBox)}>
              對準差異
            </Button>
          </Tooltip>
        </div>
        {clipOn && (
          <div className="sectionbar">
            <Segmented
              size="small"
              value={clipAxis}
              onChange={(v) => setClipAxis(v as Axis)}
              options={(['x', 'y', 'z'] as Axis[]).map((a) => ({ label: a.toUpperCase(), value: a }))}
            />
            <Slider
              min={0}
              max={axisMax(clipAxis)}
              value={clip!.at}
              onChange={(v) => setClipAt(clipAxis, v)}
              tooltip={{ formatter: (v) => `${clipAxis} = ${v}` }}
              style={{ flex: 1, margin: '0 10px' }}
            />
            <InputNumber size="small" min={0} max={axisMax(clipAxis)} value={clip!.at} onChange={(v) => v !== null && setClipAt(clipAxis, v)} precision={0} style={{ width: 72 }} />
            <Text type="secondary" className="sb-nm" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              {(clip!.at * ed.nmPerVoxel).toFixed(1)} nm
            </Text>
            <Tooltip title={`現在留 ${clipAxis} ${clipSide > 0 ? '≤' : '≥'} ${clip!.at} 的那一半；按一下翻面`}>
              <Button size="small" icon={<SwapOutlined />} onClick={() => setClipSide(clipSide > 0 ? -1 : 1)} aria-label="翻面">
                <span className="sb-text">翻面</span>
              </Button>
            </Tooltip>
            <Tooltip title={clipFollow ? '剖面跟著十字走（移剖面＝移十字）；點一下解開，剖面固定在這裡' : '剖面固定、和十字分開；點一下鎖回十字'}>
              <Button
                size="small"
                type={clipFollow ? 'primary' : 'default'}
                ghost={clipFollow}
                icon={clipFollow ? <LockOutlined /> : <UnlockOutlined />}
                onClick={() => {
                  if (clipFollow) setClipPos((p) => ({ ...p, [clipAxis]: clip!.at }));
                  setClipFollow(!clipFollow);
                }}
                aria-label={clipFollow ? '跟著十字' : '不跟十字'}
              >
                <span className="sb-text">{clipFollow ? '跟著十字' : '固定'}</span>
              </Button>
            </Tooltip>
            <Text type="secondary" className="sb-hint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              <kbd>,</kbd>
              <kbd>.</kbd> 前後一片
            </Text>
          </div>
        )}
        <div ref={tagRef} className="sel-tag" style={{ display: 'none' }}>
          {selName}
        </div>
        {ed.menu &&
          menuAt &&
          createPortal(
            <div
              className="ctxmenu"
              style={{ position: 'fixed', left: Math.min(menuAt.x, window.innerWidth - 240), top: Math.min(menuAt.y, window.innerHeight - 260) }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="ctx-title">{menuComp ? `${menuComp.label} · ${ed.matName(menuComp.mat)}` : '空白處'}</div>
              <Menu items={menuItems} selectable={false} style={{ border: 0, minWidth: 220 }} />
            </div>,
            document.body,
          )}
        {cardAt &&
          createPortal(
            <div
              className="float-card"
              style={{ position: 'fixed', left: Math.max(8, Math.min(cardAt.x, window.innerWidth - 420)), top: Math.max(8, Math.min(cardAt.y, window.innerHeight - 520)) }}
            >
              <Flex align="center" style={{ marginBottom: 6 }}>
                <Text strong style={{ fontSize: 13 }}>
                  {cardAt.kind === 'push' ? '長／縮' : '方頭／圓頭'} · {selName}
                </Text>
                <span className="grow" />
                <Button type="text" size="small" icon={<CloseOutlined />} aria-label="關閉" onClick={() => setCardAt(null)} />
              </Flex>
              {cardAt.kind === 'push' ? (
                <PushCard ed={ed} compact initialDir={cardAt.dir} />
              ) : (
                <ShapeCard ed={ed} compact initial={cardAt.round} plane={editing ? ed.editAxis : undefined} />
              )}
            </div>,
            document.body,
          )}
        {mode === 'orig' ? (
          <div className="peek">改前（原始陣列，唯讀；B 或上方切換回到改後）</div>
        ) : mode === 'diff' ? (
          <div className="peek">差異：沒改的半透明、改過的實色＋深藍邊、拿掉的紅（D 切回改後）</div>
        ) : null}
      </div>
      <div className={'pane-foot' + (hot ? ' hot' : '')}>
        <span>
          <HoverText
            live={hover}
            fallback={
              hot
                ? ed.last!.text
                : null
            }
            idle={
              (ed.sel.size
                ? `${selName} · ${ed.selCount.toLocaleString()} voxels${whole ? '' : ` · 只改 ${ed.scope.axis} ${ed.scope.lo}～${ed.scope.hi}`}${
                    !ed.focus
                      ? ' · 按 E（或雙擊它）進入聚焦編輯；現在 3D 上拖拉只轉視角'
                      : tool3d === 'brush'
                        ? ' · 在它的面上拖＝筆刷；其他地方拖＝轉視角'
                        : ' · 拖箭頭＝整面長縮 · 拖角＝圓頭 · 其他地方拖＝轉視角'
                  }`
                : '點一塊結構開始；Shift 多選；滾輪朝游標縮放；雙擊模型＝對準那點；F 對準、H 全貌')
            }
          />
        </span>
        <span className="grow" />
        <span>
          十字 ({ed.cursor[0]}, {ed.cursor[1]}, {ed.cursor[2]})
        </span>
      </div>
    </div>
  );

  const inspector = (
    <>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        className="insp-tabs"
        items={[
          {
            key: 'props',
            label: '選取與調整',
            children: (
              <div className="insp-body">
                <Inspector ed={ed} />
              </div>
            ),
          },
          {
            key: 'changes',
            label: (
              <Flex align="center" gap={6}>
                改了哪些
                {ed.changedKeys.size > 0 && <Badge count={ed.changedKeys.size} size="small" color="var(--c-primary)" />}
              </Flex>
            ),
            children: (
              <div className="insp-body">
                <ChangesTab ed={ed} />
              </div>
            ),
          },
        ]}
      />
      <div className="insp-foot">
        <span className={'dot' + (ed.diff.count ? ' warn' : '')} />
        {ed.diff.count ? `已改動 ${ed.diff.count.toLocaleString()} 個 voxel` : '尚未改動，輸出與原始相同'}
        {ed.diff.count > 0 && tab !== 'changes' && (
          <Typography.Link style={{ marginLeft: 'auto' }} onClick={() => setTab('changes')}>
            查看
          </Typography.Link>
        )}
      </div>
    </>
  );

  if (!ed.ready)
    return (
      <div className="app">
        <header className="topbar">
          <Brand />
        </header>
        <div className="welcome">
          <div className="welcome-inner">
            <Typography.Title level={3} style={{ margin: 0 }}>
              開始編輯 3D 模型
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ margin: '8px 0 24px' }}>
              上傳 TCAD 輸出的 .vti（VTK ImageData，材質編號放 CellData），系統會自動分出各個結構。原始陣列不會被改動；每一種情境是一個 split，匯出的陣列 shape 與 dtype 和原始相同。
            </Typography.Paragraph>
            <UploadPanel ed={ed} onDone={() => {}} />
          </div>
        </div>
      </div>
    );

  return (
    <CardHostCtx.Provider value={cardHost}>
    <div className="app">
      <header className="topbar">
        {narrow && ed.page === 'edit' && (
          <Tooltip title="結構清單">
            <Button type="text" icon={<MenuOutlined />} onClick={() => setLeftOpen(true)} aria-label="結構清單" />
          </Tooltip>
        )}
        <Brand />
        <Divider type="vertical" />
        <Text type="secondary" ellipsis style={{ maxWidth: 300 }}>
          {ed.meta.name ?? '內建範例'} · {ed.vol.X}×{ed.vol.Y}×{ed.vol.Z}（{voxelCount(ed.vol.data.length)} voxels）
          {ed.meta.spacing ? ` · spacing ${ed.meta.spacing.join('×')} ${ed.meta.unit === 'um' ? 'µm' : 'nm'}` : ''}
        </Text>
        <div className="grow" />
        <Segmented
          className="page-switch"
          value={ed.page}
          onChange={(v) => ed.setPage(v as 'edit' | 'lab')}
          options={[
            { label: <Tooltip title="編輯頁：3D、切面、改結構（Ctrl+1）">編輯</Tooltip>, value: 'edit' },
            {
              label: (
                <Tooltip title="實驗頁：定義變數、一次產生多個 split、縮圖與比較（Ctrl+2）">
                  <span>
                    實驗{ed.splits.length > 0 && <span className="page-count">{ed.splits.length}</span>}
                  </span>
                </Tooltip>
              ),
              value: 'lab',
            },
          ]}
          aria-label="頁面"
        />
        <div className="grow" />
        <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)} aria-label="上傳 .vti">
          <span className="btn-text">上傳 .vti</span>
        </Button>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'one', label: `匯出目前（${ed.isBase ? '原始' : ed.active?.name}）.vti${like ? '（和輸入同格式）' : ''}`, onClick: () => exportOne('vti') },
              ...(like ? [{ key: 'one-vti1', label: '匯出目前 .vti（單一 UInt8 編號）', onClick: () => exportOne('vti1') }] : []),
              { key: 'one-npy', label: '匯出目前 .npy', onClick: () => exportOne('npy') },
              { type: 'divider' },
              {
                key: 'all',
                label: ed.splits.length > 1 ? `全部 ${ed.splits.length} 個 split 打包 zip（.vti ＋ manifest）` : '打包 zip（.vti ＋ manifest.json）',
                disabled: !ed.splits.length,
                onClick: () => confirmExportAll('vti'),
              },
              ...(like ? [{ key: 'all-vti1', label: '打包 zip（單一編號 .vti ＋ manifest）', disabled: !ed.splits.length, onClick: () => confirmExportAll('vti1') }] : []),
              { key: 'all-npy', label: '打包 zip（.npy ＋ manifest.json）', disabled: !ed.splits.length, onClick: () => confirmExportAll('npy') },
            ],
          }}
        >
          <Button type="primary" icon={<DownloadOutlined />} aria-label="匯出">
            <span className="btn-text">匯出</span>
          </Button>
        </Dropdown>
        {tiny && ed.page === 'edit' && (
          <Badge count={ed.sel.size} size="small" color="var(--c-primary)">
            <Button icon={<SlidersOutlined />} onClick={() => setRightOpen(true)}>
              調整
            </Button>
          </Badge>
        )}
        <Tooltip title="設定">
          <Button type="text" icon={<SettingOutlined />} onClick={() => setSettingsOpen(true)} aria-label="設定" />
        </Tooltip>
        <Tooltip title="怎麼操作">
          <Button type="text" icon={<QuestionCircleOutlined />} onClick={() => setHelpOpen(true)} aria-label="怎麼操作" />
        </Tooltip>
      </header>
      <div className="body">
        {ed.page === 'lab' ? (
          <ExperimentPage ed={ed} onOpen3D={(id) => void open3D(id)} onOpenStructure={openStructure3D} onExport={(ids) => confirmExportAll('vti', ids)} narrow={labNarrow} stem={stem} />
        ) : (
        <>
        {narrow ? (
          <Drawer placement="left" open={leftOpen} onClose={() => setLeftOpen(false)} width={280} styles={{ body: { padding: 0 } }} title={null} closeIcon={null}>
            <StructureList ed={ed} width={280} />
          </Drawer>
        ) : (
          <>
            <StructureList ed={ed} width={leftW} />
            <Resizer label="左欄寬度" value={leftW} min={180} max={420} onDrag={(dx) => setLeftW((w) => Math.max(180, Math.min(420, w + dx)))} />
          </>
        )}
        <main className="stage" id="stage">
          <SplitPicker ed={ed} />
          {ed.sel.size > 0 && <EditToolbar ed={ed} onTab={onTab} />}
          {ed.busy && (
            <div className="busy-bar" role="status">
              <span className="busy-dot" />
              {ed.busy}
            </div>
          )}
          <div className={'canvas-area' + (focus ? ` editing focus-${focus}` : '')}>
            {pane3d}
            <div className="slices">{(['z', 'y', 'x'] as Axis[]).map(slice)}</div>
          </div>
        </main>
        {tiny ? (
          <Drawer
            placement="right"
            open={rightOpen}
            onClose={() => setRightOpen(false)}
            width={Math.min(360, window.innerWidth - 40)}
            styles={{ body: { padding: 0 } }}
            title={null}
            closeIcon={null}
          >
            <aside className="inspector" style={{ width: '100%', height: '100%', borderLeft: 0 }}>
              {inspector}
            </aside>
          </Drawer>
        ) : (
          <>
            <Resizer label="右欄寬度" value={rightW} min={300} max={560} onDrag={(dx) => setRightW((w) => Math.max(300, Math.min(560, w - dx)))} />
            <aside className="inspector" style={{ width: narrow ? 300 : rightW }}>
              {inspector}
            </aside>
          </>
        )}
        </>
        )}
      </div>
      <Modal title="上傳 .vti / .npy" open={uploadOpen} onCancel={() => setUploadOpen(false)} footer={null} width={640} destroyOnHidden>
        <UploadPanel ed={ed} onDone={() => setUploadOpen(false)} />
      </Modal>
      <SettingsDrawer
        ed={ed}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLoad={() => setUploadOpen(true)}
      />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
    </CardHostCtx.Provider>
  );
}
