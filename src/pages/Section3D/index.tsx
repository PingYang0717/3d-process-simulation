// 簡化版的頁面（plan v17 §5.1）：頂端列、左欄結構、中間 3D＋三張唯讀切面（和原版同位置）、右欄動作面板＋「改了哪些」。
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Divider, InputNumber, Modal, Segmented, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { AimOutlined, DownloadOutlined, ExpandOutlined, LeftOutlined, RedoOutlined, RightOutlined, UndoOutlined, UploadOutlined } from '@ant-design/icons';
import { type Axis, type MeshData, type Vec3, sameBBox } from '../../volume/volume';
import { download } from '../../ui/download';
import { type Op, type SelectMode, useEditor } from './editor';
import { BusyBar } from './BusyBar';
import { type Preview, boxVoxels, previewBox } from '../../volume/preview';
import { previewIn, sidOf } from '../../volume/client';
import { hiddenTable, palette } from './tables';
import { type LiveValue, useLive, useLiveValue } from '../../ui/liveValue';
import type { ViewMode, ViewPreset, View3DHandle } from './views';
import { SliceView, View3D, preloadViews } from './views.lazy';
import { SliceZoom } from './SliceZoom';
import { zoomMemory } from './sliceXf';
import { overlayOpen, typingIn, usePersisted } from '../../ui/persist';
import { useEvent } from '../../ui/useEvent';
import { useStable } from '../../ui/stable';
import { countRender } from '../../ui/memoEd';
import { Resizer } from '../../ui/Resizer';
import { StructureList } from './StructureList';
import { UploadPanel } from './UploadPanel';
import { ActionPanel } from './ActionPanel';
import { StepList } from './StepList';
import { faceName, nmText } from './stepWords';
import { PROBE_DIRS } from '../../volume/probe';

const { Text } = Typography;

/** 切面標題（和原版相同）。 */
export const AXIS_NAME: Record<Axis, string> = { z: 'XY 正面', y: 'XZ 上視', x: 'YZ 側面' };

/** 拖拉中的預覽不進整頁的 state：放在 live value，只有 3D 與切面重 render。 */
function WithLivePv<P>({ live, pv, children }: { live: LiveValue<P | null>; pv: P | null; children: (p: P | null) => ReactNode }) {
  const l = useLive(live);
  return <>{children(l ?? pv)}</>;
}
function WithLive<T>({ live, children }: { live: LiveValue<T>; children: (v: T) => ReactNode }) {
  return <>{children(useLive(live))}</>;
}
/** 欄寬：拖拉中走 live value，停下來 300 ms 後才寫回 localStorage。 */
function useLiveWidth(key: string, init: number): LiveValue<number> {
  const [w, setW] = usePersisted(key, init);
  const live = useLiveValue(w);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const off = live.subscribe(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => setW(live.get()), 300);
    });
    return () => {
      off();
      if (t) {
        clearTimeout(t);
        setW(live.get());
      }
    };
  }, [live, setW]);
  return live;
}
function TooBigNote({ live }: { live: LiveValue<boolean> }) {
  const on = useLive(live);
  return on ? (
    <div className="too-big-note" role="status">
      範圍太大，放開後才會在 3D 看到結果
    </div>
  ) : null;
}
function HoverText({ live, idle }: { live: LiveValue<string | null>; idle: string }) {
  const h = useLive(live);
  return <>{h || idle}</>;
}

const voxelCount = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : `${(n / 1e3).toFixed(0)} K`);
/** 即時預覽的上限（裁切範圍的體素數）。 */
const LIVE_PREVIEW_CAP = 400_000;
const COMMIT_PREVIEW_CAP = 400_000;
type PV = Preview & { base: number; committed: boolean; mesh?: MeshData };
const NO_HIDDEN = new Set<number>();

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
  useLayoutEffect(() => countRender('Section3DPage'));
  const { message } = App.useApp();
  const leftW = useLiveWidth('leftW', 240);
  const rightW = useLiveWidth('rightW', 350);
  const hover = useLiveValue<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  // ---- 開啟就是主畫面（plan v18 §3.1）：自動載入簡單範例；3D 引擎同時抓 ----
  const [bootErr, setBootErr] = useState<string | null>(null);
  const boot = useEvent(() => {
    setBootErr(null);
    ed.demo('basic').catch((e: unknown) => setBootErr((e as Error)?.message ?? String(e)));
  });
  const booted = useRef(false);
  useEffect(() => {
    // StrictMode 的 effect 會跑兩次：範例只產生一次
    if (booted.current) return;
    booted.current = true;
    preloadViews();
    boot();
  }, [boot]);
  /** 改後／改前（plan v17 §5.8：看改動只留這個切換＋「改了哪些」）。 */
  const [mode, setMode] = useState<ViewMode>('now');
  const peek = mode === 'orig';
  /** 放大成主畫面的那一張切面（plan v18 §3.2）；null＝主畫面是 3D。每次載入新檔案都回到 3D，縮放的記憶也清掉。 */
  const [big, setBig] = useState<Axis | null>(null);
  useEffect(() => {
    setBig(null);
    zoomMemory.clear();
  }, [ed.orig]);
  const view = useRef<View3DHandle | null>(null);
  const tagRef = useRef<HTMLDivElement>(null);

  // ---- 即時預覽：按鈕／方向鍵在主執行緒先畫，拖箭頭時 Worker 每幀回一次 ----
  const [pv, setPv] = useState<PV | null>(null);
  const livePv = useLiveValue<PV | null>(null);
  const tooBig = useLiveValue(false);
  const live2 = useRef({ inflight: false, pending: null as Op | null, sent: null as Op | null, seq: 0, dragging: false });
  const look = useRef({ ed });
  look.current = { ed };
  const sendPreview = (op: Op, committed: boolean, cap: number) => {
    const L = live2.current;
    const cur = look.current.ed.cur;
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
    previewIn(cur, { op, cap, hidden: hiddenTable(look.current.ed.hidden), palette: palette(look.current.ed.materials), showDiff: false, seq, mesh: true }).then(
      (r) => {
        const fresh = r.seq === L.seq && sidOf(look.current.ed.cur) === base && (committed || L.dragging);
        if (fresh) {
          if ('none' in r) {
            livePv.set(null);
            setPv((p) => (committed || (p && !p.committed) ? null : p));
            if (!committed) tooBig.set(true);
          } else if (committed) {
            livePv.set(null);
            setPv({ box: r.box, data: r.data, mesh: r.mesh ?? undefined, base, committed });
          } else {
            livePv.set({ box: r.box, data: r.data, mesh: r.mesh ?? undefined, base, committed });
            tooBig.set(false);
          }
        }
        done();
      },
      () => done(),
    );
  };
  const makePreview = (op: Op, cap: number, committed: boolean) => {
    if (committed) tooBig.set(false);
    if (mode !== 'now' || op.kind === 'material') return false;
    const box = previewBox(ed.cur, op);
    if (!box || boxVoxels(box) > cap) {
      if (committed) setPv(null);
      else {
        setPv((p) => (p && !p.committed ? null : p));
        tooBig.set(true);
      }
      return false;
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
  const endLive = () => {
    live2.current.dragging = false;
    live2.current.pending = null;
    livePv.set(null);
    tooBig.set(false);
    setPv((p) => (p && !p.committed ? null : p));
  };
  useEffect(() => {
    ed.previewHook.current = (op) => void makePreview(op, COMMIT_PREVIEW_CAP, true);
  });
  useEffect(() => {
    if (!ed.busy && pv?.committed && pv.base === sidOf(ed.cur)) setPv(null);
  }, [ed.busy, ed.cur, pv]);
  useEffect(() => {
    setPv(null);
    livePv.set(null);
  }, [ed.orig, mode, livePv]);

  // ---- 剛做完一步：改到的外框閃一下 ----
  useEffect(() => {
    if (!ed.last?.box || mode !== 'now') return;
    view.current?.flash();
    view.current?.stepBox(ed.last.box);
  }, [ed.last]);
  // 沒有改動時「改前」沒有意義
  useEffect(() => {
    if (mode === 'orig' && !ed.diffCount) setMode('now');
  }, [mode, ed.diffCount]);
  // 有還沒匯出的改動時，關閉或重新整理前先問一下
  const dirty = ed.diffCount > 0;
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  // ---- 鍵盤：F 對準選取、H 全貌（其他鍵在 editor） ----
  const keyDown = (e: KeyboardEvent) => {
    if (typingIn(e.target) || overlayOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'f' && ed.sel.size) view.current?.setView('fit');
    else if (k === 'h') view.current?.setView('home');
    // Esc：有選取時先取消選取（editor）；沒有選取才把放大的切面還原
    else if (e.key === 'Escape' && big && !ed.sel.size) setBig(null);
  };
  const keyRef = useRef(keyDown);
  keyRef.current = keyDown;
  useEffect(() => {
    const down = (e: KeyboardEvent) => keyRef.current(e);
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // 選取的結構改變時：箭頭的外框（最後選的那一個）
  const handleBox = useStable(ed.handleComp?.bbox ?? null, sameBBox);
  const selBBox = useStable(ed.selBox, sameBBox);
  const shown = peek ? ed.orig.vol : ed.vol;
  const cursorAt = (a: Axis) => (a === 'x' ? ed.cursor[0] : a === 'y' ? ed.cursor[1] : ed.cursor[2]);
  const axisMax = (a: Axis) => (a === 'x' ? ed.vol.X : a === 'y' ? ed.vol.Y : ed.vol.Z) - 1;
  const setCursorAxis = (a: Axis, v: number) => {
    const next: Vec3 = [...ed.cursor];
    next[a === 'x' ? 0 : a === 'y' ? 1 : 2] = Math.max(0, Math.min(axisMax(a), Math.round(v)));
    ed.setCursor(next);
  };
  const pickInSlice = useEvent((p: [number, number, number], m: SelectMode) => {
    ed.setCursor(p);
    ed.pickVoxel((p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0], m);
  });
  const stepAxis = useEvent((a: Axis, d: number) => ed.stepCursor(a, d));
  const stepFns = useMemo<Record<Axis, (d: number) => void>>(() => ({ x: (d) => stepAxis('x', d), y: (d) => stepAxis('y', d), z: (d) => stepAxis('z', d) }), [stepAxis]);
  /** 箭頭的說明：推拉＝「上面外推 3 格（1.5 nm）」；平移＝「往上搬 3 格（1.5 nm）」。 */
  const words = useMemo(
    () => ({
      drag: (dir: Vec3, v: number) => {
        const f = faceName(dir);
        const nm = nmText(v, ed.nmPerVoxel);
        // 拖哪一面，面板就切到哪一面（試算跟著換）；拖超過做得到的格數時寫出來
        if (ed.tool === 'push' && ed.face !== f) ed.setFace(f);
        const to = v > 0 ? dir : (dir.map((x) => -x) as Vec3);
        const room = ed.tool === 'move' ? ed.probe?.dirs?.[PROBE_DIRS.findIndex((d) => d.join() === to.map(Math.sign).join())] : ed.face === f ? (v > 0 ? ed.probe?.out : ed.probe?.in) : undefined;
        const lim = room && !room.more && Math.abs(v) > room.n ? `（只能做 ${room.n} 格）` : '';
        if (ed.tool === 'move') return `往${faceName(to)}搬 ${Math.abs(v)} 格（${nm}）${lim}`;
        return `${f}面${v > 0 ? '外推' : '內縮'} ${Math.abs(v)} 格（${nm}）${lim}`;
      },
      hover: (dir: Vec3, grow: string, shrink: string) => (ed.tool === 'move' ? `${grow}拖＝往${faceName(dir)}搬、${shrink}拖＝反方向` : `${grow}拖＝外推、${shrink}拖＝內縮`),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed.tool, ed.nmPerVoxel, ed.face, ed.probe],
  );
  const working = !!ed.busy;

  /** 改後｜改前、復原／重做：跟著主畫面走（3D，或放大的那張切面）。 */
  const tools = (
    <>
      <Tooltip title={ed.diffCount ? '改後 ⇄ 改前' : '還沒有改動'}>
        <Segmented
          size="small"
          className="tb"
          value={mode}
          disabled={!ed.diffCount}
          onChange={(v) => setMode(v as ViewMode)}
          options={[
            { label: '改後', value: 'now' },
            { label: '改前', value: 'orig' },
          ]}
        />
      </Tooltip>
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
    </>
  );
  /** ‹ z = 27 › 13.5 nm */
  const slicePos = (axis: Axis) => {
    const at = cursorAt(axis);
    return (
      <>
        <Space.Compact size="small" className="slice-pos">
          <Button icon={<LeftOutlined />} onClick={() => ed.stepCursor(axis, -1)} aria-label="上一片" />
          <InputNumber size="small" min={0} max={axisMax(axis)} value={at} onChange={(v) => v !== null && setCursorAxis(axis, v)} precision={0} prefix={<span style={{ color: 'var(--c-text-3)' }}>{axis} =</span>} style={{ width: 84 }} />
          <Button icon={<RightOutlined />} onClick={() => ed.stepCursor(axis, 1)} aria-label="下一片" />
        </Space.Compact>
        <Text type="secondary" className="slice-hint" style={{ fontSize: 11 }}>
          {(at * ed.nmPerVoxel).toFixed(1)} nm
        </Text>
      </>
    );
  };
  /** 放大的切面：可縮放、平移（唯讀）；標題列有方向切換和主畫面的工具。 */
  const mainSlice = (axis: Axis) => (
    <div className="pane slice-pane big" key={axis} data-axis={axis}>
      <div className="pane-head">
        <Tooltip title="3D 放回主畫面（Esc）">
          <Button size="small" icon={<LeftOutlined />} onClick={() => setBig(null)}>
            回 3D
          </Button>
        </Tooltip>
        <Segmented size="small" value={axis} onChange={(v) => setBig(v as Axis)} options={(['z', 'y', 'x'] as Axis[]).map((a) => ({ label: AXIS_NAME[a], value: a }))} />
        {slicePos(axis)}
        <span className="grow" />
        {tools}
      </div>
      <div className="slice-body">
        <WithLivePv live={livePv} pv={pv}>
          {(p) => (
            <SliceZoom
              key={axis}
              vol={shown}
              axis={axis}
              at={cursorAt(axis)}
              materials={ed.materials}
              hidden={NO_HIDDEN}
              selMask={peek ? null : ed.selMask}
              cursor={ed.cursor}
              scope={ed.sel.size ? ed.scope : null}
              preview={p && p.base === sidOf(ed.cur) && mode === 'now' ? p : null}
              selBox={peek ? null : selBBox}
              onPick={pickInSlice}
              onStep={stepFns[axis]}
            />
          )}
        </WithLivePv>
      </div>
    </div>
  );
  const slice = (axis: Axis) => {
    if (big === axis) return mainSlice(axis);
    const at = cursorAt(axis);
    return (
      <div className="pane slice-pane" key={axis} data-axis={axis}>
        <div className="pane-head">
          <Text strong style={{ fontSize: 12 }}>
            {AXIS_NAME[axis]}
          </Text>
          {slicePos(axis)}
          <Tooltip title="放大這張切面（可縮放、平移）">
            <Button type="text" size="small" className="slice-zoom" icon={<ExpandOutlined />} onClick={() => setBig(axis)} aria-label={`放大 ${AXIS_NAME[axis]}`} />
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
                hidden={NO_HIDDEN}
                selMask={peek ? null : ed.selMask}
                cursor={ed.cursor}
                scope={ed.sel.size ? ed.scope : null}
                diff={null}
                preview={p && p.base === sidOf(ed.cur) && mode === 'now' ? p : null}
                onPick={pickInSlice}
                onStep={stepFns[axis]}
              />
            )}
          </WithLivePv>
        </div>
      </div>
    );
  };

  const pane3d = (
    <div className="pane pane-3d">
      <div className="pane-head">
        <Text strong style={{ fontSize: 12 }}>
          3D
        </Text>
        <Text type="secondary" ellipsis className="pane-sub" style={{ fontSize: 12, maxWidth: 240 }}>
          {ed.sel.size ? `已選 ${ed.selName}` : ''}
        </Text>
        <span className="grow" />
        {big ? (
          <Tooltip title="3D 放回主畫面（Esc）">
            <Button type="text" size="small" className="pane-expand" icon={<ExpandOutlined />} onClick={() => setBig(null)} aria-label="3D 放回主畫面" />
          </Tooltip>
        ) : (
          tools
        )}
      </div>
      <div className="canvas-wrap">
        <div className="legend" aria-hidden>
          <b>點一下</b>＝選結構
          <br />
          <b>拖箭頭</b>＝改（放開就完成）
          <br />
          <b>拖其他地方</b>＝轉視角
          <br />
          <b>Shift＋點</b>＝多選同材質
        </div>
        <WithLivePv live={livePv} pv={pv}>
          {(p) => (
            <View3D
              state={peek ? ed.orig : ed.cur}
              materials={ed.materials}
              hidden={ed.hidden}
              selMask={peek ? null : ed.selMask}
              selComps={peek ? null : ed.selIdx}
              selBBox={peek ? null : selBBox}
              handleBox={peek ? null : handleBox}
              words={words}
              scope={ed.scope}
              cursor={ed.cursor}
              mode={mode}
              tool={peek || !ed.sel.size || ed.tool === 'mat' ? null : 'handles'}
              dimOthers={ed.sel.size > 0 && !peek}
              faceOp={ed.faceOp}
              onCommit={ed.commit}
              preview={p}
              onPreview={(op) => {
                if (op) return makePreview(op, LIVE_PREVIEW_CAP, false);
                endLive();
                return false;
              }}
              onPick={(v, m) => ed.pickVoxel(v, m)}
              onHover={hover.set}
              floatRef={tagRef}
              handle={view}
              busy={working}
            />
          )}
        </WithLivePv>
        <TooBigNote live={tooBig} />
        <div className="viewbar">
          {(
            [
              ['front', '正視', 'XY 正面（和下方第一張切面同方向）'],
              ['top', '上視', 'XZ 上視'],
              ['side', '側視', 'YZ 側面'],
              ['iso', '等角', '斜 45° 看全貌'],
              ['home', '全貌', '回到載入時的視角（H）'],
              ['fit', '對準選取', '把選取的結構放到畫面中央（F）'],
            ] as [ViewPreset, string, string][]
          ).map(([k, label, tip]) => (
            <Tooltip key={k} title={tip}>
              <Button size="small" type="text" icon={k === 'fit' ? <AimOutlined /> : undefined} disabled={k === 'fit' && !ed.sel.size} onClick={() => view.current?.setView(k)}>
                {label}
                {(k === 'fit' || k === 'home') && <kbd className="kcap">{k === 'fit' ? 'F' : 'H'}</kbd>}
              </Button>
            </Tooltip>
          ))}
        </div>
        <div ref={tagRef} className="sel-tag" style={{ display: 'none' }}>
          {ed.selName}
        </div>
        {peek && <div className="peek">改前（原始，唯讀；切回「改後」才能改）</div>}
      </div>
      <div className="pane-foot">
        <span>
          <HoverText live={hover} idle="左鍵拖＝轉視角；滾輪＝縮放；右鍵拖＝平移；Esc＝取消選取；Ctrl+A＝同材質全選；Ctrl+Z＝復原；F＝對準選取" />
        </span>
        <span className="grow" />
        <span>
          十字 ({ed.cursor[0]}, {ed.cursor[1]}, {ed.cursor[2]})
        </span>
      </div>
    </div>
  );

  const exportVti = async () => {
    // 內建範例的名字是中文：有些瀏覽器的下載不收非 ASCII 的檔名（存成 download），範例一律叫 example
    const stem = ed.meta.format === 'demo' ? 'example' : (ed.meta.name ?? 'tcad').replace(/\.(npy|vti)$/i, '');
    try {
      const data = await ed.exportVti();
      const saved = await download(data, `${stem}${ed.diffCount ? '_edited' : ''}.vti`);
      message.success(`已匯出 ${saved}`);
    } catch (e) {
      message.error(`匯出失敗：${(e as Error)?.message ?? e}`);
    }
  };

  const inspector = (
    <>
      <ActionPanel ed={ed} peek={peek} />
      <StepList ed={ed} />
      <div className={'insp-foot' + (ed.diffCount ? ' changed' : '')}>
        <span className={'dot' + (ed.diffCount ? ' warn' : '')} />
        <span className="grow foot-msg" aria-live="polite">
          {ed.last?.text ?? (ed.diffCount ? `和原始差 ${ed.diffCount.toLocaleString()} 體素` : '尚未改動，輸出與原始相同')}
        </span>
        {ed.last?.canUndo && ed.hist.length > 0 && (
          <Typography.Link onClick={ed.undo} disabled={working}>
            復原
          </Typography.Link>
        )}
      </div>
    </>
  );

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        {ed.ready && (
          <>
            <Divider type="vertical" />
            <Text type="secondary" ellipsis style={{ maxWidth: 360 }}>
              {ed.meta.name ?? '內建範例'} · {ed.vol.X}×{ed.vol.Y}×{ed.vol.Z}（{voxelCount(ed.vol.data.length)} 體素）
              {ed.meta.spacing ? ` · spacing ${ed.meta.spacing.join('×')} ${ed.meta.unit === 'um' ? 'µm' : 'nm'}` : ''}
            </Text>
          </>
        )}
        <div className="grow" />
        {/* 範例還在載入時先不給按：同時只能載入一個（loadVolume 會直接略過第二個） */}
        <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)} disabled={!ed.ready && !bootErr} aria-label="上傳 .vti">
          <span className="btn-text">上傳 .vti</span>
        </Button>
        <Tooltip title={ed.meta.hasRaw && ed.meta.fractions ? '匯出一個 .vti，格式和上傳的檔案相同' : '匯出一個 .vti（材質編號放 CellData）'}>
          <Button type="primary" icon={<DownloadOutlined />} onClick={exportVti} disabled={working || !ed.ready} aria-label="匯出">
            <span className="btn-text">匯出</span>
          </Button>
        </Tooltip>
      </header>
      {ed.ready ? (
      <div className="body">
        <WithLive live={leftW}>{(w) => <StructureList ed={ed} width={w} />}</WithLive>
        <WithLive live={leftW}>{(w) => <Resizer label="左欄寬度" value={w} min={180} max={420} onDrag={(dx) => leftW.set(Math.max(180, Math.min(420, leftW.get() + dx)))} />}</WithLive>
        <main className="stage" id="stage">
          <BusyBar ed={ed} />
          <div className={'canvas-area' + (big ? ` enlarged big-${big}` : '')}>
            {pane3d}
            <div className="slices">{(['z', 'y', 'x'] as Axis[]).map(slice)}</div>
          </div>
        </main>
        <WithLive live={rightW}>{(w) => <Resizer label="右欄寬度" value={w} min={300} max={560} onDrag={(dx) => rightW.set(Math.max(300, Math.min(560, rightW.get() - dx)))} />}</WithLive>
        <WithLive live={rightW}>{(w) => <aside className="inspector simple" style={{ width: w }}>{inspector}</aside>}</WithLive>
      </div>
      ) : (
        <div className="boot" role={bootErr ? 'alert' : 'status'}>
          {bootErr ? (
            <>
              <Text type="danger">範例載入失敗：{bootErr}</Text>
              <Space>
                <Button onClick={boot}>重試</Button>
                <Button type="primary" icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
                  上傳 .vti
                </Button>
              </Space>
            </>
          ) : (
            <>
              <Spin size="small" />
              <span>載入範例中…</span>
            </>
          )}
        </div>
      )}
      <Modal title="上傳 .vti / .npy" open={uploadOpen} onCancel={() => setUploadOpen(false)} footer={null} width={640} destroyOnHidden>
        <UploadPanel ed={ed} onDone={() => setUploadOpen(false)} />
      </Modal>
    </div>
  );
}
