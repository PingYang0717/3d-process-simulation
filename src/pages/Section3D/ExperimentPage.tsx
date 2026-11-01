// 「實驗」頁（plan v12 §5.4、§10 D5～D11）：左「設計」（可收合；窄螢幕變抽屜）＋右「結果」。
// 結果區：工具列（篩選、排序、卡片｜表格、縮圖軸、比較／匯出／刪除勾選的）、依設計分組的卡片（視窗化、縮圖進視窗才畫）。
// 點卡片＝高亮；「在 3D 看」＝設為目前並切到編輯頁、對準差異。這一頁沒有 WebGL。
import { useCallback, useMemo, useRef, useState } from 'react';
import { App, Button, Drawer, Empty, Input, Modal, Segmented, Select, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, ArrowLeftOutlined, DeleteOutlined, DownloadOutlined, LeftOutlined, RightOutlined, SearchOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { type Axis, hexToRgb, unionBBox } from '../../volume/volume';
import { BASE_ID, type Editor, type Split, changedOf, statsOf } from './editor';
import { factorsOf, levelCell } from './matrix';
import { DesignPanel } from './DesignPanel';
import { type ResultGroup, ResultGrid } from './ResultGrid';
import type { CardApi } from './SplitCard';
import { keysOfSplit } from './SplitCard';
import { MatrixTab, safeName } from './MatrixTab';
import { AXIS_NAME, CompareView } from './CompareView';
import { autoAxis, longestAxisOf, unionBoxes } from './thumbs';
import { usePersisted } from '../../ui/persist';
import { DIFF_EDGE_HEX, REMOVED_RGB } from './drawSlice';

const { Text } = Typography;
const COMPARE_MAX = 12;
const MANUAL = '__manual';
type SortKey = 'seq' | 'name' | 'changed' | `f:${string}`;
const hhmm = (t?: number) => (t ? new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '');

export function ExperimentPage({ ed, onOpen3D, onOpenStructure, onExport, narrow, stem }: { ed: Editor; onOpen3D: (id: string) => void; onOpenStructure: () => void; onExport: (ids: string[]) => void; narrow: boolean; stem: string }) {
  const { modal } = App.useApp();
  const [hi, setHi] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [designF, setDesignF] = useState<string>('all');
  const [tagF, setTagF] = useState<string | null>(null);
  const [levelF, setLevelF] = useState<string[]>([]);
  const [sort, setSort] = useState<SortKey>('seq');
  const [view, setView] = usePersisted<'cards' | 'table'>('labView', 'cards', (v): v is 'cards' | 'table' => v === 'cards' || v === 'table');
  const [axisMode, setAxisMode] = useState<'auto' | Axis>('auto');
  const [comparing, setComparing] = useState<string[] | null>(null);
  const [cmpAxis, setCmpAxis] = useState<Axis>('z');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTo, setScrollTo] = useState<{ id: string; nonce: number } | null>(null);
  const [designHidden, setDesignHidden] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [renaming, setRenaming] = useState<Split | null>(null);
  const [newName, setNewName] = useState('');

  const factors = useMemo(() => factorsOf(ed.designs), [ed.designs]);
  const fIndex = useMemo(() => new Map(factors.map((f, k) => [f.id, k])), [factors]);
  const rgb = useMemo(() => new Map(ed.materials.map((m) => [m.id, hexToRgb(m.color)])), [ed.materials]);
  const look = useMemo(() => `${[...ed.hidden].sort().join(',')}|${ed.materials.map((m) => m.color).join('')}`, [ed.hidden, ed.materials]);
  const tags = useMemo(() => [...new Set(ed.splits.flatMap((s) => s.tags ?? []))], [ed.splits]);
  const levelOptions = useMemo(
    () =>
      factors.map((f) => ({
        label: f.name || f.id,
        options: [...new Set(ed.splits.flatMap((s) => (s.levels?.[f.id] !== undefined ? [s.levels[f.id]] : [])))]
          .sort((a, b) => a - b)
          .map((v) => ({ value: `${f.id}=${v}`, label: `${f.name || f.id} = ${levelCell(f, v, ed.nmPerVoxel)?.main}` })),
      })),
    [factors, ed.splits, ed.nmPerVoxel],
  );

  // 篩選＋排序（組內）
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    const lv = levelF.map((x) => x.split('=')).map(([id, v]) => [id, Number(v)] as const);
    const out = ed.splits.filter(
      (s) =>
        (!t || s.name.toLowerCase().includes(t)) &&
        (designF === 'all' || (designF === MANUAL ? !s.designId : s.designId === designF)) &&
        (!tagF || (s.tags ?? []).includes(tagF)) &&
        lv.every(([id, v]) => s.levels?.[id] === v),
    );
    const key = (s: Split): number | string =>
      sort === 'name' ? s.name : sort === 'changed' ? -changedOf(s) : sort === 'seq' ? (s.seq ?? 0) : (s.levels?.[sort.slice(2)] ?? Infinity);
    return out.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      return typeof ka === 'string' ? ka.localeCompare(kb as string) : ka - (kb as number);
    });
  }, [ed.splits, q, designF, tagF, levelF, sort]);

  // 依設計分組（新的在上面）；縮圖軸：同一設計共用（diff 外框聯集投影最大），頁面可統一切
  const groups: ResultGroup[] = useMemo(() => {
    const known = new Set(ed.designs.map((d) => d.id));
    const list: ResultGroup[] = [];
    const mk = (id: string, title: string, sub: string, splits: Split[], keys: string[]): ResultGroup => {
      const box = unionBoxes(splits.map((s) => statsOf(s, null).diffBox));
      const sb = unionBBox(ed.orig.L.comps.filter((c) => keys.includes(c.key)));
      const axis = axisMode !== 'auto' ? axisMode : (autoAxis(box) ?? longestAxisOf(sb));
      return { id, title, sub, splits, axis, keys };
    };
    for (const d of [...ed.designs].reverse()) {
      const ss = visible.filter((s) => s.designId === d.id);
      if (!ss.length) continue;
      const title = d.factors.map((f) => f.name || f.id).join(' × ');
      const dims = d.factors.map((f) => (d.levels[f.id] ?? []).length).join('×');
      list.push(mk(d.id!, title || '設計', `${dims} · ${d.combine === 'ofat' ? '逐一掃描' : d.combine === 'manual' ? '手動勾選' : '全因子'} · ${ss.length} 個${d.at ? ` · ${hhmm(d.at)}` : ''}`, ss, [...new Set(d.factors.flatMap((f) => f.keys))]));
    }
    const manual = visible.filter((s) => !s.designId || !known.has(s.designId));
    if (manual.length) list.push(mk(MANUAL, '手動', `${manual.length} 個 · 在編輯頁直接改出來的`, manual, [...new Set(manual.flatMap(keysOfSplit))]));
    return list;
  }, [visible, ed.designs, axisMode, ed.orig]);

  // 卡片的操作：身分不變（卡片 memo 才有用），裡面呼叫最新的
  const live = useRef({ ed, onOpen3D });
  live.current = { ed, onOpen3D };
  const toggle = useCallback((id: string, on?: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const api: CardApi = useMemo(
    () => ({
      highlight: (id) => setHi(id),
      toggle,
      open3D: (id) => live.current.onOpen3D(id),
      rename: (id) => {
        const s = live.current.ed.splits.find((x) => x.id === id);
        if (!s) return;
        setRenaming(s);
        setNewName(s.name);
      },
      duplicate: (id) => live.current.ed.duplicateSplit(id),
      remove: (id) => {
        const s = live.current.ed.splits.find((x) => x.id === id);
        if (!s) return;
        modal.confirm({
          title: `刪除「${s.name}」？`,
          okText: '刪除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => live.current.ed.removeSplit(id),
        });
      },
    }),
    [toggle, modal],
  );
  const onCollapse = useCallback((id: string) => setCollapsed((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id]))), []);
  const onSelectGroup = useCallback((g: ResultGroup) => setChecked((p) => new Set([...p, ...g.splits.map((s) => s.id)])), []);

  const checkedIds = ed.splits.filter((s) => checked.has(s.id)).map((s) => s.id);
  const startCompare = () => {
    let ids = checkedIds;
    if (!ids.length) {
      const d = ed.designs[ed.designs.length - 1];
      ids = ed.splits.filter((s) => (d ? s.designId === d.id : true)).map((s) => s.id);
    }
    if (ids.length > COMPARE_MAX) {
      modal.info({ title: `一次最多比 ${COMPARE_MAX} 個`, content: `勾了（或最近一次設計有）${ids.length} 個；先勾要比的那幾個。` });
      return;
    }
    if (!ids.length) return;
    // 切面放到這些 split 的差異中間，並排、疊圖一打開就看得到
    const box = unionBoxes(ed.splits.filter((s) => ids.includes(s.id)).map((s) => ed.stats(s).diffBox));
    if (box) {
      const axis = autoAxis(box) ?? 'z';
      setCmpAxis(axis);
      ed.setCursor([(box.x0 + box.x1) >> 1, (box.y0 + box.y1) >> 1, (box.z0 + box.z1) >> 1]);
    }
    setComparing(ids);
  };
  const removeChecked = () =>
    modal.confirm({
      title: `刪除勾選的 ${checkedIds.length} 個 split？`,
      okText: '刪除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        ed.removeSplits(checkedIds);
        setChecked(new Set());
      },
    });
  const onMade = (ids: string[]) => {
    setQ('');
    setDesignF('all');
    setTagF(null);
    setLevelF([]);
    setComparing(null);
    setHi(ids[0] ?? null);
    setScrollTo({ id: ids[0], nonce: Date.now() });
    if (narrow) setDrawer(false);
  };

  // 抽屜自己有「設計」標題，面板裡就不再放一次
  const design = <DesignPanel ed={ed} onMade={onMade} onOpen3D={onOpen3D} onOpenStructure={onOpenStructure} title={!narrow} />;
  const toolbar = (
    <div className="lab-toolbar">
      {narrow && (
        <Button size="small" onClick={() => setDrawer(true)}>
          設計
        </Button>
      )}
      <span className="lt-title">結果</span>
      <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="名字" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 140 }} aria-label="搜尋名字" />
      <Select
        size="small"
        value={designF}
        onChange={setDesignF}
        style={{ minWidth: 120 }}
        options={[{ value: 'all', label: '全部設計' }, ...[...ed.designs].reverse().map((d) => ({ value: d.id!, label: `${d.factors.map((f) => f.name || f.id).join(' × ')}${d.at ? ` · ${hhmm(d.at)}` : ''}` })), { value: MANUAL, label: '手動' }]}
        aria-label="篩選設計"
      />
      {levelOptions.some((g) => g.options.length) && (
        <Select size="small" mode="multiple" allowClear placeholder="水平" value={levelF} onChange={setLevelF} options={levelOptions} style={{ minWidth: 110, maxWidth: 260 }} maxTagCount={2} aria-label="篩選水平" />
      )}
      {tags.length > 0 && <Select size="small" allowClear placeholder="tag" value={tagF} onChange={setTagF} options={tags.map((t) => ({ value: t, label: t }))} style={{ width: 100 }} aria-label="篩選 tag" />}
      <Select
        size="small"
        value={sort}
        onChange={setSort}
        style={{ width: 120 }}
        options={[
          { value: 'seq', label: '產生順序' },
          { value: 'name', label: '名字' },
          { value: 'changed', label: '改動多的先' },
          ...factors.map((f) => ({ value: `f:${f.id}` as SortKey, label: `依 ${f.name || f.id}` })),
        ]}
        aria-label="排序"
      />
      <Segmented
        size="small"
        value={view}
        onChange={(v) => setView(v as 'cards' | 'table')}
        options={[
          { value: 'cards', icon: <AppstoreOutlined />, label: '卡片' },
          { value: 'table', icon: <UnorderedListOutlined />, label: '表格' },
        ]}
      />
      {view === 'cards' && (
        <Tooltip title="縮圖切哪個方向：自動＝同一設計共用、沿差異最長的那一軸切（改動方向落在切面上）">
          <Segmented
            size="small"
            value={axisMode}
            onChange={(v) => setAxisMode(v as 'auto' | Axis)}
            options={[
              { value: 'auto', label: '自動' },
              { value: 'z', label: 'XY' },
              { value: 'y', label: 'XZ' },
              { value: 'x', label: 'YZ' },
            ]}
          />
        </Tooltip>
      )}
      <span className="grow" />
      <span className={'lt-count' + (checkedIds.length ? ' on' : '')}>{checkedIds.length ? `已勾 ${checkedIds.length}` : `${visible.length} 個 split`}</span>
      <Tooltip title={checkedIds.length ? '並排或疊圖比較勾選的' : `沒勾＝最近一次設計的全部（上限 ${COMPARE_MAX}）`}>
        <Button size="small" type="primary" ghost disabled={!ed.splits.length} onClick={startCompare}>
          比較{checkedIds.length ? '勾選的' : ''}
        </Button>
      </Tooltip>
      <Button size="small" icon={<DownloadOutlined />} disabled={!checkedIds.length} onClick={() => onExport(checkedIds)}>
        匯出勾選的
      </Button>
      <Button size="small" danger icon={<DeleteOutlined />} disabled={!checkedIds.length} onClick={removeChecked} aria-label="刪除勾選的" />
      {checkedIds.length > 0 && (
        <Button size="small" type="text" onClick={() => setChecked(new Set())}>
          清除勾選
        </Button>
      )}
    </div>
  );

  return (
    <div className="lab">
      {narrow ? (
        <Drawer placement="left" open={drawer} onClose={() => setDrawer(false)} width={Math.min(420, window.innerWidth - 40)} title="設計" styles={{ body: { padding: '12px 16px 0' } }}>
          {design}
        </Drawer>
      ) : (
        <aside className={'lab-design' + (designHidden ? ' collapsed' : '')}>
          <Tooltip title={designHidden ? '展開設計區' : '收合設計區'} placement="right">
            <Button type="text" size="small" className="lab-collapse" icon={designHidden ? <RightOutlined /> : <LeftOutlined />} onClick={() => setDesignHidden(!designHidden)} aria-label={designHidden ? '展開設計區' : '收合設計區'} />
          </Tooltip>
          {!designHidden && <div className="lab-design-body">{design}</div>}
        </aside>
      )}
      <section className="lab-results">
        {comparing ? (
          <>
            <div className="lab-toolbar">
              <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setComparing(null)}>
                回到結果
              </Button>
              <Text style={{ fontSize: 13 }}>
                比較 {comparing.length} 個 split · {AXIS_NAME[cmpAxis]}
              </Text>
            </div>
            <div className="lab-compare">
              <CompareView ed={ed} axis={cmpAxis} setAxis={setCmpAxis} ids={comparing} onOpen={onOpen3D} />
            </div>
          </>
        ) : (
          <>
            {toolbar}
            {ed.splits.length > 0 && (
              <div className="lab-legend">
                <span className="lg-item">
                  <span className="lg-line" />
                  原始輪廓
                </span>
                <span className="lg-item">
                  <span className="lg-edge" style={{ background: DIFF_EDGE_HEX }} />
                  改過
                </span>
                <span className="lg-item">
                  <span className="lg-edge" style={{ background: `rgb(${REMOVED_RGB.join(',')})` }} />
                  拿掉
                </span>
                <span className="lg-sep" />
                <span className="lg-tip">點卡片＝高亮 · 雙擊或「在 3D 看」＝到編輯頁 · Shift／Ctrl＋點＝勾選</span>
              </div>
            )}
            {!ed.splits.length ? (
              <div className="lab-onboard">
                <div className="ob-card">
                  <div className="ob-kicker">還沒有 split</div>
                  <h2>三步做一組實驗</h2>
                  <ol className="ob-steps">
                    <li>
                      <span className="ob-n">1</span>
                      <div>
                        <b>選結構</b>
                        <span>左邊 ① 選要改的那一塊（或在編輯頁點它）；預覽可以換視角、拖切片。</span>
                      </div>
                    </li>
                    <li>
                      <span className="ob-n">2</span>
                      <div>
                        <b>加變數、填要試的值</b>
                        <span>選「要改什麼」（寬度、圓頭半徑…），值可以直接點著改；預覽會標出它改哪裡。</span>
                      </div>
                    </li>
                    <li>
                      <span className="ob-n">3</span>
                      <div>
                        <b>看組合，按產生</b>
                        <span>每一列就是一個會產生的 split，狀態欄寫清楚能不能產生、為什麼。</span>
                      </div>
                    </li>
                  </ol>
                  <Text type="secondary" className="ob-foot">
                    或者到編輯頁直接改一刀，也會出現在這裡。
                  </Text>
                </div>
              </div>
            ) : view === 'table' ? (
              <div className="lab-table">
                <MatrixTab ed={ed} fileOf={(sp) => `${stem}__${safeName(sp.name)}.vti`} ids={visible.map((s) => s.id)} onRow={setHi} highlight={hi} />
              </div>
            ) : !visible.length ? (
              <Empty className="lab-empty" description="沒有符合篩選的 split" />
            ) : (
              <ResultGrid
                groups={groups}
                orig={ed.orig}
                factors={factors}
                fIndex={fIndex}
                rgb={rgb}
                hidden={ed.hidden}
                look={look}
                materials={ed.materials}
                nm={ed.nmPerVoxel}
                hi={hi}
                checked={checked}
                activeId={ed.activeId === BASE_ID ? '' : ed.activeId}
                api={api}
                collapsed={collapsed}
                onCollapse={onCollapse}
                onSelectGroup={onSelectGroup}
                scrollTo={scrollTo}
              />
            )}
          </>
        )}
      </section>
      <Modal title="重新命名" open={!!renaming} onCancel={() => setRenaming(null)} onOk={() => (renaming && ed.renameSplit(renaming.id, newName.trim()), setRenaming(null))} okText="確定" width={360} destroyOnHidden>
        <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onPressEnter={() => (renaming && ed.renameSplit(renaming.id, newName.trim()), setRenaming(null))} />
      </Modal>
    </div>
  );
}
