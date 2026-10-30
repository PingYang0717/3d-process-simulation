import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { App, Badge, Button, Divider, Drawer, Dropdown, Flex, InputNumber, Menu, Modal, Popover, Segmented, Slider, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  CompressOutlined,
  DownOutlined,
  ExpandOutlined,
  FormatPainterOutlined,
  LeftOutlined,
  RightOutlined,
  SwapOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  ScissorOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  RollbackOutlined,
  SettingOutlined,
  SlidersOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { type Axis, type Vec3, type Volume, encodeNpy, hexToRgb, isVoid, unionBBox } from '../../volume/volume';
import { encodeVti } from '../../volume/vti';
import { zipStore } from '../../volume/zip';
import { download } from '../../ui/download';
import { MatLabel, Swatch } from '../../ui/Swatch';
import { type Op, type SelectMode, useEditor } from './editor';
import { type Preview, previewOp } from '../../volume/preview';
import type { Clip, ViewMode, ViewPreset, View3DHandle } from './views';
import { SliceView, View3D } from './views.lazy';
import { overlayOpen, usePersisted } from '../../ui/persist';
import { Inspector, matOf } from './Inspector';
import { ChangesTab } from './ChangesTab';
import { SplitsTab } from './SplitsTab';
import { SplitBar } from './SplitBar';
import { SweepModal } from './SweepModal';
import { AXIS_NAME, CompareView } from './CompareView';
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
const COMMIT_PREVIEW_CAP = 6_000_000;
type PV = Preview & { base: Uint8Array; committed: boolean };

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
  const { message, modal } = App.useApp();
  const [leftW, setLeftW] = usePersisted('leftW', 240);
  const [rightW, setRightW] = usePersisted('rightW', 350);
  const narrow = useMedia('(max-width: 1199px)');
  const tiny = useMedia('(max-width: 799px)');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [tab, setTab] = useState('props');
  /** 剖面：軸、留哪一半、每軸各自的位置（和十字分開，點選結構不會讓剖面跳走）。 */
  const [clipOn, setClipOn] = useState(false);
  const [clipAxis, setClipAxis] = useState<Axis>('z');
  const [clipSide, setClipSide] = useState<1 | -1>(1);
  const [clipPos, setClipPos] = useState<Record<Axis, number>>({ x: 0, y: 0, z: 0 });
  const [showDiff, setShowDiff] = usePersisted('showDiff', true);
  /** 現在／原始／差異。 */
  const [mode, setMode] = useState<ViewMode>('now');
  /** 放大哪一張切面當主畫面（null = 3D 大）。 */
  const [focus, setFocus] = useState<Axis | null>(null);
  const [sliceHover, setSliceHover] = useState<Vec3 | null>(null);
  const [xray, setXray] = useState(false);
  const [translucent, setTranslucent] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [cmpAxis, setCmpAxis] = useState<Axis>('z');
  const tagRef = useRef<HTMLDivElement>(null);
  const view = useRef<View3DHandle | null>(null);
  /** 即時預覽：這一步在主執行緒裁切重算的結果；3D 與切面先畫它，Worker 的正式結果到了再換掉。 */
  const [pv, setPv] = useState<PV | null>(null);
  const makePreview = (op: Op, cap: number, committed: boolean) => {
    if (mode !== 'now' || op.kind === 'material') return false;
    const p = previewOp(ed.cur, ed.orig.vol, op, cap);
    setPv(p ? { ...p, base: ed.cur.vol.data, committed } : null);
    return !!p;
  };
  // 每一步送 Worker 前先預覽（按鈕、方向鍵、筆刷放開都走 commit）
  useEffect(() => {
    ed.previewHook.current = (op) => void makePreview(op, COMMIT_PREVIEW_CAP, true);
  });
  // 計算結束但狀態沒變（失敗或沒改到）：預覽收掉；換檔案也收掉
  useEffect(() => {
    if (!ed.busy && pv?.committed && pv.base === ed.cur.vol.data) setPv(null);
  }, [ed.busy, ed.cur, pv]);
  useEffect(() => setPv(null), [ed.orig, mode]);
  /** 切面要畫的預覽：只有根據的陣列還是現在這份才有效（正式結果到了切面本來就會重畫）。 */
  const slicePv = pv && pv.base === ed.cur.vol.data && mode === 'now' ? pv : null;

  const cursorAt = (a: Axis) => (a === 'x' ? ed.cursor[0] : a === 'y' ? ed.cursor[1] : ed.cursor[2]);
  const axisMax = (a: Axis) => (a === 'x' ? ed.vol.X : a === 'y' ? ed.vol.Y : ed.vol.Z) - 1;
  const setCursorAxis = (a: Axis, v: number) => {
    const next: Vec3 = [...ed.cursor];
    next[a === 'x' ? 0 : a === 'y' ? 1 : 2] = Math.max(0, Math.min(axisMax(a), Math.round(v)));
    ed.setCursor(next);
  };
  const setClipAt = (a: Axis, v: number) => setClipPos((p) => ({ ...p, [a]: Math.max(0, Math.min(axisMax(a), Math.round(v))) }));
  const toggleClip = () => {
    // 開啟時從十字的位置開始
    if (!clipOn) setClipPos((p) => ({ ...p, [clipAxis]: cursorAt(clipAxis) }));
    setClipOn(!clipOn);
  };

  // B：現在 ⇄ 原始；D：現在 ⇄ 差異；, .：剖面前後一片；F 對準選取、H 全貌、1/2/3/4 視角；Esc：還原放大的切面
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // 說明、設定、Modal 開著時單鍵留給它們，不動 3D
      if (overlayOpen()) return;
      const k = e.key.toLowerCase();
      const views: Record<string, ViewPreset> = { f: 'fit', h: 'home', home: 'home', '1': 'front', '2': 'top', '3': 'side', '4': 'iso' };
      if (k === 'b') setMode((m) => (m === 'orig' ? 'now' : 'orig'));
      else if (k === 'd') setMode((m) => (m === 'diff' ? 'now' : 'diff'));
      else if ((e.key === ',' || e.key === '.') && clipOn) setClipPos((p) => ({ ...p, [clipAxis]: Math.max(0, Math.min(axisMax(clipAxis), p[clipAxis] + (e.key === '.' ? 1 : -1))) }));
      else if (views[k]) view.current?.setView(views[k]);
      else if (e.key === '?') setHelpOpen(true);
      else if (e.key === 'Escape' && focus) {
        // 只退出放大的切面，選取留著
        e.stopImmediatePropagation();
        setFocus(null);
      }
    };
    window.addEventListener('keydown', down, { capture: true });
    return () => window.removeEventListener('keydown', down, { capture: true });
  }, [clipOn, clipAxis, focus, ed.vol.X, ed.vol.Y, ed.vol.Z]);

  // 剛套用一步：訊息＋「復原」，3D 選取框閃一下
  useEffect(() => {
    if (!ed.last) return;
    view.current?.flash();
    message.open({
      key: 'last',
      type: 'success',
      duration: 4,
      content: (
        <span>
          {ed.last.text}
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
  const clip: Clip | null = clipOn ? { axis: clipAxis, at: Math.min(axisMax(clipAxis), clipPos[clipAxis]), side: clipSide } : null;
  const selBBox = useMemo(() => {
    const b = unionBBox(ed.selComps);
    if (!b) return null;
    const z0 = Math.max(b.z0, ed.zRange[0]);
    const z1 = Math.min(b.z1, ed.zRange[1]);
    return z0 <= z1 ? { ...b, z0, z1 } : b;
  }, [ed.selComps, ed.zRange]);
  const diffShown = showDiff && ed.diff.count ? ed.diff.mask : null;

  // ---- 匯出：.vti（同 Extent／Spacing／Origin）或 .npy ----

  type Fmt = 'vti' | 'npy';
  const stem = (ed.meta.name ?? 'tcad').replace(/\.(npy|vti)$/i, '');
  const spacing = ed.meta.spacing ?? [ed.nmPerVoxel, ed.nmPerVoxel, ed.nmPerVoxel];
  const origin = ed.meta.origin ?? [0, 0, 0];
  const encode = (v: Volume, fmt: Fmt) => (fmt === 'vti' ? encodeVti(v, spacing, origin, ed.meta.arrayName || 'material') : encodeNpy(v));
  const exportOne = (fmt: Fmt = 'vti') => {
    const name = ed.isBase || !ed.active ? `${stem}.${fmt}` : `${stem}__${safeName(ed.active.name)}.${fmt}`;
    download(encode(ed.vol, fmt), name)
      .then((saved) => message.success(`已匯出 ${saved}`))
      .catch((e: { code?: string }) => e?.code !== 'declined' && message.error('匯出失敗'));
  };
  /** 全部匯出前先列出會打包哪些 split（名稱、步數、檔名），確認了才寫檔。 */
  const confirmExportAll = (fmt: Fmt = 'vti') => {
    const fileOf = (s: { name: string }) => `${stem}__${safeName(s.name)}.${fmt}`;
    modal.confirm({
      title: `打包 ${ed.splits.length} 個 split 成 zip（.${fmt}）`,
      icon: <DownloadOutlined style={{ color: 'var(--c-primary)' }} />,
      width: 520,
      okText: '匯出 zip',
      cancelText: '取消',
      content: (
        <Flex vertical gap={6} style={{ marginTop: 8 }}>
          {ed.splits.map((s) => (
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
      onOk: () => exportAll(fmt),
    });
  };
  const exportAll = async (fmt: Fmt = 'vti') => {
    const fileOf = (s: { name: string }) => `${stem}__${safeName(s.name)}.${fmt}`;
    const files = ed.splits.map((s) => ({ name: fileOf(s), data: encode(s.cur.vol, fmt) }));
    const diffs = await Promise.all(ed.splits.map((s) => ed.diffOf(s.cur)));
    const manifest = {
      source: ed.meta.name ?? 'demo',
      format: fmt,
      materials: ed.materials.map(({ id, name, color }) => ({ id, name, color })),
      shape: [ed.vol.Z, ed.vol.Y, ed.vol.X],
      dtype: 'uint8',
      spacing,
      origin,
      nmPerVoxel: ed.nmPerVoxel,
      splits: ed.splits.map((s, i) => ({
        name: s.name,
        file: fileOf(s),
        changedVoxels: diffs[i].count,
        ops: s.ops.map((op) => ({ ...op, text: ed.opText(op, ed.orig.L) })),
      })),
    };
    files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    const name = `${stem}__splits.zip`;
    download(zipStore(files), name, 'application/zip')
      .then((saved) => message.success(`已匯出 ${saved}`))
      .catch((e: { code?: string }) => e?.code !== 'declined' && message.error('匯出失敗'));
  };

  // ---- 右鍵選單：只做選取相關 ----

  const menuComp = ed.menu?.key ? ed.compByKey.get(ed.menu.key) : undefined;
  const closeMenu = () => ed.setMenu(null);
  const behind = (ed.menu?.along ?? []).filter((k) => k !== menuComp?.key).map((k) => ed.compByKey.get(k)).filter((c): c is NonNullable<typeof c> => !!c);
  const menuItems: MenuProps['items'] = menuComp
    ? [
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
  const matItems: MenuProps['items'] = ed.materials
    .filter((m) => m.id !== 0)
    .map((m) => ({ key: `m${m.id}`, label: <MatLabel mat={m} />, onClick: () => changeMaterial(m.id) }));

  const pickInSlice = (p: [number, number, number], mode: SelectMode) => {
    ed.setCursor(p);
    ed.pickVoxel((p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0], mode);
  };
  const slice = (axis: Axis) => {
    const at = cursorAt(axis);
    const big = focus === axis;
    const hov = sliceHover;
    const hovMat = hov ? ed.matName(shown.data[(hov[2] * ed.vol.Y + hov[1]) * ed.vol.X + hov[0]]) : null;
    return (
      <div className={'pane slice-pane' + (big ? ' big' : '')} key={axis} data-axis={axis}>
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
          {big && hov && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              ({hov[0]}, {hov[1]}, {hov[2]}) {hovMat}
            </Text>
          )}
          <Tooltip title={big ? '還原（Esc）' : '放大這張切面'}>
            <Button type="text" size="small" className="slice-zoom" icon={big ? <CompressOutlined /> : <ExpandOutlined />} onClick={() => setFocus(big ? null : axis)} aria-label={big ? '還原' : '放大'} />
          </Tooltip>
        </div>
        <div className="slice-body">
          <SliceView
            vol={shown}
            axis={axis}
            at={at}
            materials={ed.materials}
            hidden={ed.hidden}
            selMask={peek ? null : ed.affMask}
            cursor={ed.cursor}
            zRange={ed.zRange}
            diff={diffShown}
            preview={slicePv}
            onPick={pickInSlice}
            onStep={(d) => ed.stepCursor(axis, d)}
            onHover={big ? setSliceHover : undefined}
          />
        </div>
      </div>
    );
  };

  // ---- 筆刷設定（3D 工具列） ----
  const br = ed.brush;
  const brushPop = (
    <Flex vertical gap={12} style={{ width: 280 }}>
      <Segmented
        block
        value={br.mode}
        onChange={(v) => ed.setBrush({ ...br, mode: v as 'push' | 'level' | 'off' })}
        options={[
          { label: '推拉', value: 'push' },
          { label: '補平', value: 'level' },
          { label: '關閉（只轉視角）', value: 'off' },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {br.mode === 'push'
          ? '按住已選結構的面往外拉＝長、往回推＝縮，只改筆刷範圍，拖的時候就看得到結果。轉視角：中鍵拖，或 Alt＋左鍵拖。'
          : br.mode === 'level'
            ? '點已選結構的一個面，筆刷範圍內每一排都補到（或削到）跟它一樣高。整根要變方頭請用右欄「補平（圓頭變方頭）」。'
            : '關閉時在 3D 上怎麼拖都只轉視角、不會改到體素；長縮、移動、換材質仍可在右欄輸入。'}
      </Text>
      <Flex align="center" gap={10}>
        <span style={{ fontSize: 12, width: 64 }}>半徑</span>
        <Slider min={0} max={60} value={br.radius ?? 6} onChange={(v) => ed.setBrush({ ...br, radius: v })} style={{ flex: 1, margin: '0 4px' }} />
        <InputNumber size="small" min={0} max={500} value={br.radius ?? 6} onChange={(v) => v !== null && ed.setBrush({ ...br, radius: Math.round(v) })} suffix="vx" style={{ width: 96 }} />
      </Flex>
      <Flex align="center" gap={10}>
        <span style={{ fontSize: 12, width: 64 }}>形狀</span>
        <Segmented
          size="small"
          value={br.shape}
          onChange={(v) => ed.setBrush({ ...br, shape: v as 'round' | 'square' })}
          options={[
            { label: '圓', value: 'round' },
            { label: '方', value: 'square' },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {br.shape === 'square' ? `${2 * (br.radius ?? 6) + 1}×${2 * (br.radius ?? 6) + 1} 格` : `直徑 ${2 * (br.radius ?? 6) + 1} 格`}（{((2 * (br.radius ?? 6) + 1) * ed.nmPerVoxel).toFixed(1)} nm）
        </Text>
      </Flex>
      <Text type="secondary" style={{ fontSize: 12 }}>
        整面長縮、整塊移動請用右欄輸入。
      </Text>
    </Flex>
  );
  const brushLabel = br.mode === 'off' ? '筆刷 關' : `${br.mode === 'push' ? '筆刷' : '補平'} ${br.shape === 'square' ? '方' : '圓'}${br.radius ?? 6}`;

  const selName = ed.selComps.length === 1 ? ed.selComps[0].label : `${ed.selComps.length} 個結構`;
  /** Worker 計算中：改體素的按鈕先 disabled，點了不會無聲被吞掉。 */
  const working = !!ed.busy;
  const firstMat = ed.selComps.length ? matOf(ed, ed.selComps[0].mat) : null;
  const oneMat = ed.selComps.every((c) => c.mat === ed.selComps[0]?.mat);
  const whole = ed.zRange[0] === 0 && ed.zRange[1] === ed.vol.Z - 1;

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
        {ed.sel.size > 0 && (
          <Space.Compact size="small" className="tb">
            <Tooltip title="頂面往上 1 voxel，可以一直按">
              <Button icon={<ArrowUpOutlined />} disabled={working} onClick={() => ed.push([0, -1, 0], 1)}>
                長高
              </Button>
            </Tooltip>
            <Tooltip title="頂面往下 1 voxel">
              <Button icon={<ArrowDownOutlined />} disabled={working} onClick={() => ed.push([0, -1, 0], -1)}>
                縮短
              </Button>
            </Tooltip>
            <Dropdown menu={{ items: matItems }} trigger={['click']} disabled={working}>
              <Button>
                {oneMat && firstMat && <Swatch fill={firstMat.color} isVoid={isVoid(firstMat.id)} />}
                {oneMat ? firstMat?.name : '多種材質'}
                <DownOutlined style={{ fontSize: 10, marginLeft: 2 }} />
              </Button>
            </Dropdown>
            <Popover content={brushPop} trigger="click" placement="bottomLeft">
              <Tooltip title={br.mode === 'off' ? '筆刷已關閉：3D 上拖拉只轉視角' : '3D 上拖拉面只改筆刷範圍；整面長縮與移動在右欄輸入。關閉筆刷就只轉視角'}>
                <Button icon={<FormatPainterOutlined />} type={br.mode === 'off' ? 'dashed' : 'default'}>
                  {brushLabel}
                </Button>
              </Tooltip>
            </Popover>
          </Space.Compact>
        )}
        <Space.Compact size="small" className="tb">
          <Tooltip title="復原上一步（Ctrl+Z）">
            <Button icon={<UndoOutlined />} disabled={!ed.hist.length || working} onClick={ed.undo} aria-label="復原">
              <span className="tb-text">復原</span>
            </Button>
          </Tooltip>
          <Tooltip title="丟掉這個 split 的所有改動">
            <Button icon={<RollbackOutlined />} disabled={!ed.diff.count || working} onClick={ed.resetAll} aria-label="回到原始">
              <span className="tb-text">回到原始</span>
            </Button>
          </Tooltip>
        </Space.Compact>
        <Tooltip title={ed.diff.count > 0 ? 'B：現在 ⇄ 原始；D：現在 ⇄ 差異（沒改的半透明、改過的實色、拿掉的紅）' : '還沒有改動；改了之後可以切到「原始」「差異」對照'}>
          <Segmented
            size="small"
            className="tb"
            value={mode}
            disabled={!ed.diff.count}
            onChange={(v) => setMode(v as ViewMode)}
            options={[
              { label: '現在', value: 'now' },
              { label: '原始', value: 'orig' },
              { label: '差異', value: 'diff' },
            ]}
          />
        </Tooltip>
        <Space.Compact size="small" className="tb">
          <Tooltip title="沿一個軸剖開 3D，剖口貼上切面圖；用滑桿或 , . 鍵移動">
            <Button type={clipOn ? 'primary' : 'default'} icon={<ScissorOutlined />} onClick={toggleClip} aria-label="剖面">
              <span className="tb-text">剖面</span>
            </Button>
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              selectable: true,
              multiple: true,
              selectedKeys: [xray ? 'xray' : '', translucent ? 'trans' : ''],
              items: [
                { key: 'xray', label: '空洞透視：VOID 永遠畫在最上面', onClick: () => setXray(!xray) },
                { key: 'trans', label: '材質半透明：看得到內部', onClick: () => setTranslucent(!translucent) },
              ],
            }}
          >
            <Tooltip title="顯示">
              <Button icon={<EyeOutlined />} aria-label="顯示選項">
                <DownOutlined style={{ fontSize: 10 }} />
              </Button>
            </Tooltip>
          </Dropdown>
        </Space.Compact>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <View3D
          state={peek ? ed.orig : ed.cur}
          materials={ed.materials}
          hidden={ed.hidden}
          selMask={peek ? null : ed.affMask}
          selComps={peek ? null : ed.selIdx}
          zRange={ed.zRange}
          selBBox={peek ? null : selBBox}
          cursor={ed.cursor}
          clip={clip}
          showDiff={showDiff && !peek}
          diffMask={diffShown}
          mode={mode}
          brush={ed.brush}
          nmPerVoxel={ed.nmPerVoxel}
          orig={ed.orig.vol}
          preview={pv}
          onPreview={(op) => {
            if (op) return makePreview(op, LIVE_PREVIEW_CAP, false);
            setPv((p) => (p && !p.committed ? null : p));
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
          onHover={setHover}
          floatRef={tagRef}
          handle={view}
          xray={xray}
          translucent={translucent}
          busy={!!ed.busy}
        />
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
            <Tooltip title="把剖面移到橘色十字的位置">
              <Button size="small" icon={<AimOutlined />} disabled={clip!.at === cursorAt(clipAxis)} onClick={() => setClipAt(clipAxis, cursorAt(clipAxis))} aria-label="對齊十字">
                <span className="sb-text">對齊十字</span>
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
        {mode === 'orig' ? (
          <div className="peek">原始陣列（唯讀；B 或上方切換回到現在）</div>
        ) : mode === 'diff' ? (
          <div className="peek">差異：沒改的半透明、改過的實色、拿掉的紅（D 切回）</div>
        ) : null}
      </div>
      <div className={'pane-foot' + (hot ? ' hot' : '')}>
        <span>
          {hot
            ? ed.last!.text
            : hover ||
              (ed.sel.size
                ? `${selName} · ${ed.selCount.toLocaleString()} voxels${whole ? '' : ` · 只改 z ${ed.zRange[0]}～${ed.zRange[1]}`}${
                    br.mode === 'off' ? ' · 筆刷已關閉，拖拉只轉視角' : ' · 按住它的面拖＝筆刷雕刻；轉視角用中鍵或 Alt＋左鍵拖'
                  }；整面長縮、移動在右欄`
                : '點一塊結構開始；Shift 多選；雙擊模型＝繞著那點轉；F 對準、H 全貌')}
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
                <Inspector ed={ed} onMaterial={changeMaterial} />
              </div>
            ),
          },
          {
            key: 'changes',
            label: (
              <Flex align="center" gap={6}>
                改動
                {ed.changedKeys.size > 0 && <Badge count={ed.changedKeys.size} size="small" color="var(--c-primary)" />}
              </Flex>
            ),
            children: (
              <div className="insp-body">
                <ChangesTab ed={ed} onExport={() => exportOne('vti')} />
              </div>
            ),
          },
          {
            key: 'splits',
            label: (
              <Flex align="center" gap={6}>
                Split
                {ed.splits.length > 1 && <Badge count={ed.splits.length} size="small" color="var(--c-text-3)" />}
              </Flex>
            ),
            children: (
              <div className="insp-body">
                <SplitsTab ed={ed} onExportAll={() => confirmExportAll('vti')} onSweep={() => setSweepOpen(true)} />
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
    <div className="app">
      <header className="topbar">
        {narrow && (
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
        <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)} aria-label="上傳 .vti">
          <span className="btn-text">上傳 .vti</span>
        </Button>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'one', label: `匯出目前（${ed.isBase ? '原始' : ed.active?.name}）.vti`, onClick: () => exportOne('vti') },
              { key: 'one-npy', label: '匯出目前 .npy', onClick: () => exportOne('npy') },
              { type: 'divider' },
              {
                key: 'all',
                label: ed.splits.length > 1 ? `全部 ${ed.splits.length} 個 split 打包 zip（.vti ＋ manifest）` : '打包 zip（.vti ＋ manifest.json）',
                disabled: !ed.splits.length,
                onClick: () => confirmExportAll('vti'),
              },
              { key: 'all-npy', label: '打包 zip（.npy ＋ manifest.json）', disabled: !ed.splits.length, onClick: () => confirmExportAll('npy') },
            ],
          }}
        >
          <Button type="primary" icon={<DownloadOutlined />} aria-label="匯出">
            <span className="btn-text">匯出</span>
          </Button>
        </Dropdown>
        {tiny && (
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
          <SplitBar ed={ed} compare={compare} setCompare={setCompare} onSweep={() => setSweepOpen(true)} />
          {ed.busy && (
            <div className="busy-bar" role="status">
              <span className="busy-dot" />
              {ed.busy}
            </div>
          )}
          {compare ? (
            <CompareView ed={ed} axis={cmpAxis} setAxis={setCmpAxis} showDiff={showDiff} />
          ) : (
            <div className={'canvas-area' + (focus ? ` focus-${focus}` : '')}>
              {pane3d}
              <div className="slices">{(['z', 'y', 'x'] as Axis[]).map(slice)}</div>
            </div>
          )}
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
      </div>
      <Modal title="上傳 .vti / .npy" open={uploadOpen} onCancel={() => setUploadOpen(false)} footer={null} width={640} destroyOnHidden>
        <UploadPanel ed={ed} onDone={() => setUploadOpen(false)} />
      </Modal>
      <SettingsDrawer
        ed={ed}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        showDiff={showDiff}
        setShowDiff={setShowDiff}
        onLoad={() => setUploadOpen(true)}
      />
      <HelpDrawer open={helpOpen} onClose={() => setHelpOpen(false)} />
      <SweepModal
        ed={ed}
        open={sweepOpen}
        onClose={() => setSweepOpen(false)}
        onMade={(axis) => {
          // 產生後自動切到看得到差異的切面：z 方向 → XZ 上視
          setCmpAxis(axis === 'z' ? 'y' : 'z');
          setCompare(true);
        }}
      />
    </div>
  );
}
