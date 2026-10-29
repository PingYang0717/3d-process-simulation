import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { App, Badge, Button, Divider, Drawer, Dropdown, Flex, Menu, Modal, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import {
  AimOutlined,
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownloadOutlined,
  EyeInvisibleOutlined,
  MenuOutlined,
  QuestionCircleOutlined,
  RollbackOutlined,
  SettingOutlined,
  SlidersOutlined,
  UndoOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { type Axis, encodeNpy, isVoid, unionBBox } from '../../volume/volume';
import { zipStore } from '../../volume/zip';
import { download } from '../../ui/download';
import { MatLabel, Swatch } from '../../ui/Swatch';
import { type SelectMode, useEditor } from './editor';
import { View3D, type View3DHandle, SliceView } from './views';
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

function Resizer({ onDrag }: { onDrag: (dx: number) => void }) {
  return (
    <div
      className="resizer"
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

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');

export default function Section3DPage() {
  const ed = useEditor();
  const { message } = App.useApp();
  const [leftW, setLeftW] = useState(240);
  const [rightW, setRightW] = useState(350);
  const narrow = useMedia('(max-width: 1199px)');
  const tiny = useMedia('(max-width: 799px)');
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [tab, setTab] = useState('props');
  const [clip, setClip] = useState(false);
  const [showDiff, setShowDiff] = useState(true);
  const [peek, setPeek] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sweepOpen, setSweepOpen] = useState(false);
  const [compare, setCompare] = useState(false);
  const [cmpAxis, setCmpAxis] = useState<Axis>('z');
  const tagRef = useRef<HTMLDivElement>(null);
  const view = useRef<View3DHandle | null>(null);

  // 按住 B 看原始
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b' && !(e.target as HTMLElement | null)?.closest?.('input,textarea')) setPeek(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'b') setPeek(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const shown = peek ? ed.orig.vol : ed.vol;
  const selBBox = useMemo(() => {
    const b = unionBBox(ed.selComps);
    if (!b) return null;
    const z0 = Math.max(b.z0, ed.zRange[0]);
    const z1 = Math.min(b.z1, ed.zRange[1]);
    return z0 <= z1 ? { ...b, z0, z1 } : b;
  }, [ed.selComps, ed.zRange]);
  const diffShown = showDiff && ed.diff.count ? ed.diff.mask : null;

  // ---- 匯出 ----

  const stem = (ed.source ?? 'tcad').replace(/\.npy$/i, '');
  const exportOne = () => {
    const name = ed.isBase || !ed.active ? `${stem}.npy` : `${stem}__${safeName(ed.active.name)}.npy`;
    download(encodeNpy(ed.vol), name);
    message.success(`已匯出 ${name}`);
  };
  const exportAll = () => {
    const files = ed.splits.map((s) => ({ name: `${stem}__${safeName(s.name)}.npy`, data: encodeNpy(s.cur.vol) }));
    const manifest = {
      source: ed.source ?? 'demo',
      shape: [ed.vol.Z, ed.vol.Y, ed.vol.X],
      dtype: 'uint8',
      nmPerVoxel: ed.nmPerVoxel,
      splits: ed.splits.map((s, i) => ({
        name: s.name,
        file: files[i].name,
        changedVoxels: ed.diffOf(s.cur.vol).count,
        ops: s.ops.map((op) => ({ ...op, text: ed.opText(op, ed.orig.L) })),
      })),
    };
    files.push({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    const name = `${stem}__splits.zip`;
    download(zipStore(files), name, 'application/zip');
    message.success(`已匯出 ${name}`);
  };

  // ---- 右鍵選單：只做選取相關 ----

  const menuComp = ed.menu?.key ? ed.compByKey.get(ed.menu.key) : undefined;
  const closeMenu = () => ed.setMenu(null);
  const menuItems: MenuProps['items'] = menuComp
    ? [
        { key: 'only', label: `只選 ${menuComp.label}`, onClick: () => (ed.selectKeys([menuComp.key]), closeMenu()) },
        {
          key: 'add',
          label: ed.sel.has(menuComp.key) && ed.sel.size > 1 ? '從選取中移除' : '加入選取（同 Shift＋點）',
          onClick: () => (ed.selectKeys([menuComp.key], 'toggle'), closeMenu()),
        },
        { key: 'samemat', label: `選全部的 ${ed.matName(menuComp.mat)}`, onClick: () => (ed.selectMaterial(menuComp.mat), closeMenu()) },
        { type: 'divider' },
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

  const matItems: MenuProps['items'] = ed.materials
    .filter((m) => m.id !== 0)
    .map((m) => ({ key: `m${m.id}`, label: <MatLabel mat={m} />, onClick: () => ed.setMaterial(m.id) }));

  const pickInSlice = (p: [number, number, number], mode: SelectMode) => {
    ed.setCursor(p);
    ed.pickVoxel((p[2] * ed.vol.Y + p[1]) * ed.vol.X + p[0], mode);
  };
  const slice = (axis: Axis) => {
    const at = axis === 'x' ? ed.cursor[0] : axis === 'y' ? ed.cursor[1] : ed.cursor[2];
    return (
      <div className="pane slice-pane" key={axis}>
        <div className="pane-head">
          <Text strong style={{ fontSize: 12 }}>
            {AXIS_NAME[axis]}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {axis} = {at}（{(at * ed.nmPerVoxel).toFixed(1)} nm）
          </Text>
          <span className="grow" />
          <Text type="secondary" className="slice-hint" style={{ fontSize: 11 }}>
            滾輪換切片
          </Text>
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
            onPick={pickInSlice}
            onStep={(d) => ed.stepCursor(axis, d)}
          />
        </div>
      </div>
    );
  };

  const selName = ed.selComps.length === 1 ? ed.selComps[0].label : `${ed.selComps.length} 個結構`;
  const firstMat = ed.selComps.length ? matOf(ed, ed.selComps[0].mat) : null;
  const oneMat = ed.selComps.every((c) => c.mat === ed.selComps[0]?.mat);
  const whole = ed.zRange[0] === 0 && ed.zRange[1] === ed.vol.Z - 1;

  const pane3d = (
    <div className="pane pane-3d">
      <div className="pane-head">
        <Text strong style={{ fontSize: 12 }}>
          3D
        </Text>
        <Text type="secondary" ellipsis className="pane-sub" style={{ fontSize: 12, maxWidth: 260 }}>
          {ed.isBase ? '原始模型（唯讀）：切到某個 split 才能改' : `${ed.active?.name} · 點一塊選取，Shift 多選`}
        </Text>
        <span className="grow" />
        {ed.sel.size > 0 && !ed.isBase && (
          <Space size={4} className="quick">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {selName}
            </Text>
            <Tooltip title="長高 1 voxel（可以一直按）">
              <Button size="small" icon={<ArrowUpOutlined />} onClick={() => ed.push([0, -1, 0], 1)}>
                長高
              </Button>
            </Tooltip>
            <Tooltip title="縮短 1 voxel">
              <Button size="small" icon={<ArrowDownOutlined />} onClick={() => ed.push([0, -1, 0], -1)}>
                縮短
              </Button>
            </Tooltip>
            <Dropdown menu={{ items: matItems }} trigger={['click']}>
              <Button size="small">
                {oneMat && firstMat && <Swatch fill={firstMat.color} isVoid={isVoid(firstMat.id)} />}
                {oneMat ? firstMat?.name : '多種材質'}
              </Button>
            </Dropdown>
            <Divider type="vertical" />
          </Space>
        )}
        <Tooltip title="復原上一步（Ctrl+Z）">
          <Button size="small" icon={<UndoOutlined />} disabled={!ed.hist.length} onClick={ed.undo}>
            復原
          </Button>
        </Tooltip>
        <Tooltip title="丟掉這個 split 的所有改動，回到原始">
          <Button size="small" icon={<RollbackOutlined />} disabled={!ed.diff.count} onClick={ed.resetAll}>
            回到原始
          </Button>
        </Tooltip>
        <Divider type="vertical" />
        {ed.diff.count > 0 && (
          <Tooltip title="按住看原始陣列（也可以按住 B）">
            <Button
              size="small"
              type={peek ? 'primary' : 'default'}
              onPointerDown={() => setPeek(true)}
              onPointerUp={() => setPeek(false)}
              onPointerLeave={() => setPeek(false)}
            >
              看原始
            </Button>
          </Tooltip>
        )}
        <Button size="small" type={clip ? 'primary' : 'default'} onClick={() => setClip(!clip)}>
          剖開
        </Button>
        <Tooltip title="重設視角">
          <Button size="small" icon={<AimOutlined />} onClick={() => view.current?.resetView()} aria-label="重設視角" />
        </Tooltip>
      </div>
      <div className="canvas-wrap" ref={wrapRef}>
        <View3D
          vol={shown}
          materials={ed.materials}
          hidden={ed.hidden}
          selMask={peek ? null : ed.affMask}
          selBBox={peek ? null : selBBox}
          cursor={ed.cursor}
          clipZ={clip ? ed.cursor[2] : null}
          diffMask={diffShown}
          onPick={(v, mode) => {
            if (v === null) {
              if (mode === 'set') ed.clearSel();
              return;
            }
            ed.pickVoxel(v, mode);
            ed.setCursor(ed.voxelCoord(v));
          }}
          onMenu={(v, x, y) => {
            const r = wrapRef.current?.getBoundingClientRect();
            setMenuAt({ x: (r?.left ?? 0) + x, y: (r?.top ?? 0) + y });
            const l = v !== null ? ed.L.labels[v] : -1;
            ed.setMenu({ x, y, key: l >= 0 ? ed.L.comps[l].key : null });
          }}
          floatRef={tagRef}
          handle={view}
        />
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
        {peek ? (
          <div className="peek">原始陣列（放開回到現在）</div>
        ) : (
          clip && <div className="peek">剖開到 z = {ed.cursor[2]}（在 XZ／YZ 切面滾輪可以移動）</div>
        )}
      </div>
      <div className={'pane-foot' + (hot ? ' hot' : '')}>
        <span>
          {hot
            ? ed.last!.text
            : ed.sel.size
              ? `已選 ${selName} · ${ed.selCount.toLocaleString()} voxels${whole ? '' : ` · 只改 z ${ed.zRange[0]}～${ed.zRange[1]}`} · 方向鍵＝整塊移動 1 格，上方「長高／縮短」＝只推頂面`
              : '還沒選取：點一塊結構開始'}
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
                改動
                {ed.changedKeys.size > 0 && <Badge count={ed.changedKeys.size} size="small" color="#1677ff" />}
              </Flex>
            ),
            children: (
              <div className="insp-body">
                <ChangesTab ed={ed} onExport={exportOne} />
              </div>
            ),
          },
          {
            key: 'splits',
            label: (
              <Flex align="center" gap={6}>
                Split
                {ed.splits.length > 1 && <Badge count={ed.splits.length} size="small" color="#8c8c8c" />}
              </Flex>
            ),
            children: (
              <div className="insp-body">
                <SplitsTab ed={ed} onExportAll={exportAll} onSweep={() => setSweepOpen(true)} />
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

  return (
    <div className="app">
      <header className="topbar">
        {narrow && (
          <Tooltip title="結構清單">
            <Button type="text" icon={<MenuOutlined />} onClick={() => setLeftOpen(true)} aria-label="結構清單" />
          </Tooltip>
        )}
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.6">
              <path d="M2 13h12M4 13V8a4 4 0 0 1 8 0v5" />
            </svg>
          </span>
          <span className="brand-name">Section Editor</span>
          <Tag bordered={false}>3D</Tag>
        </div>
        <Divider type="vertical" />
        <Text type="secondary" ellipsis style={{ maxWidth: 260 }}>
          {ed.source ?? '內建範例'} · shape ({ed.vol.Z}, {ed.vol.Y}, {ed.vol.X}) uint8
        </Text>
        <div className="grow" />
        <Button icon={<UploadOutlined />} onClick={() => setUploadOpen(true)}>
          <span className="btn-text">上傳 .npy</span>
        </Button>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'one', label: `匯出目前（${ed.isBase ? '原始' : ed.active?.name}）.npy`, onClick: exportOne },
              { key: 'all', label: `全部 ${ed.splits.length} 個 split 匯出成 zip`, onClick: exportAll },
            ],
          }}
        >
          <Button type="primary" icon={<DownloadOutlined />}>
            <span className="btn-text">匯出</span>
          </Button>
        </Dropdown>
        {tiny && (
          <Badge count={ed.sel.size} size="small" color="#1677ff">
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
            <Resizer onDrag={(dx) => setLeftW((w) => Math.max(180, Math.min(420, w + dx)))} />
          </>
        )}
        <main className="stage">
          <SplitBar ed={ed} compare={compare} setCompare={setCompare} onSweep={() => setSweepOpen(true)} />
          {compare ? (
            <CompareView ed={ed} axis={cmpAxis} setAxis={setCmpAxis} showDiff={showDiff} />
          ) : (
            <div className="canvas-area">
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
            <Resizer onDrag={(dx) => setRightW((w) => Math.max(300, Math.min(560, w - dx)))} />
            <aside className="inspector" style={{ width: narrow ? 300 : rightW }}>
              {inspector}
            </aside>
          </>
        )}
      </div>
      <Modal title="上傳 .npy" open={uploadOpen} onCancel={() => setUploadOpen(false)} footer={null} width={640} destroyOnClose>
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
