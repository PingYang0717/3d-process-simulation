// 編輯頁的 Split 列（plan v12 §5.4、§10 D6）：取代一排頁籤。一顆「目前 ▾」按鈕，點開是可搜尋的清單
// （名字、水平 chips、步數、live／parked 小點）；[ ] 仍然循環；「新增 ▾」：空白／複製／去實驗頁。
import { useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Input, Modal, Popover, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, DownOutlined, EditOutlined, ExperimentOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { BASE_ID, type Editor, type Split, changedOf } from './editor';
import { factorsOf, levelCell } from './matrix';
import { CATEGORY } from './colors';
import { memoEd } from '../../ui/memoEd';

const { Text } = Typography;

/** live／parked 小點：實心＝在記憶體、空心＝只留改到的那一小塊。 */
export function StateDot({ s }: { s: Split }) {
  const parked = s.state === 'parked';
  return (
    <Tooltip title={parked ? '只留改到的那一小塊（parked）；要看或要改時再載入' : '在記憶體（live）'}>
      <span className={'state-dot' + (parked ? ' parked' : '')} aria-label={parked ? 'parked' : 'live'} />
    </Tooltip>
  );
}

function SplitPickerImpl({ ed }: { ed: Editor }) {
  const { modal } = App.useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<Split | null>(null);
  const [name, setName] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const factors = useMemo(() => factorsOf(ed.designs), [ed.designs]);
  const fIndex = useMemo(() => new Map(factors.map((f, k) => [f.id, k])), [factors]);
  const items = useMemo(() => {
    const t = q.trim().toLowerCase();
    return ed.splits.filter((s) => !t || s.name.toLowerCase().includes(t) || (s.tags ?? []).some((x) => x.toLowerCase().includes(t)));
  }, [ed.splits, q]);
  const pick = (id: string) => {
    setOpen(false);
    setQ('');
    void ed.setActiveId(id);
  };
  const confirmRemove = (s: Split) =>
    modal.confirm({
      title: `刪除「${s.name}」？`,
      content: s.ops.length ? `這個 split 有 ${s.ops.length} 步改動，刪除後無法復原。` : '這個 split 還沒有改動。',
      okText: '刪除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => ed.removeSplit(s.id),
    });
  const finishRename = () => {
    if (renaming) ed.renameSplit(renaming.id, name.trim());
    setRenaming(null);
  };
  const chips = (s: Split) =>
    factors
      .filter((f) => s.levels?.[f.id] !== undefined)
      .map((f) => {
        const c = levelCell(f, s.levels![f.id], ed.nmPerVoxel)!;
        return (
          <span key={f.id} className="lv-chip">
            <span className="factor-dot" style={{ background: CATEGORY[(fIndex.get(f.id) ?? 0) % CATEGORY.length] }} />
            {c.nominal ? '標稱' : c.main}
          </span>
        );
      });
  const row = (id: string, label: string, s: Split | null) => (
    <div
      key={id}
      role="option"
      aria-selected={id === ed.activeId}
      tabIndex={-1}
      className={'picker-row' + (id === ed.activeId ? ' on' : '')}
      onClick={() => pick(id)}
      onKeyDown={(e) => e.key === 'Enter' && pick(id)}
    >
      {s ? <StateDot s={s} /> : <span className="state-dot base" />}
      <span className="picker-name">{label}</span>
      {s && <span className="picker-chips">{chips(s)}</span>}
      <span className="grow" />
      {s && (
        <Text type="secondary" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          {s.ops.length ? `${s.ops.length} 步 · Δ ${changedOf(s).toLocaleString()}` : '未改'}
        </Text>
      )}
    </div>
  );
  const active = ed.active;
  const panel = (
    <div className="split-picker-panel">
      <Input
        autoFocus
        size="small"
        allowClear
        prefix={<SearchOutlined />}
        placeholder={`搜尋 ${ed.splits.length} 個 split（名字、tag）`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            (listRef.current?.querySelector('.picker-row') as HTMLElement | null)?.focus();
          } else if (e.key === 'Enter' && items[0]) pick(items[0].id);
        }}
        aria-label="搜尋 split"
      />
      <div
        className="picker-list"
        role="listbox"
        ref={listRef}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          e.preventDefault();
          const el = document.activeElement as HTMLElement | null;
          const next = (e.key === 'ArrowDown' ? el?.nextElementSibling : el?.previousElementSibling) as HTMLElement | null;
          next?.focus();
        }}
      >
        {!q && row(BASE_ID, '原始', null)}
        {items.slice(0, 300).map((s) => row(s.id, s.name, s))}
        {items.length > 300 && (
          <Text type="secondary" style={{ fontSize: 12, padding: 8 }}>
            還有 {items.length - 300} 個，請輸入關鍵字縮小
          </Text>
        )}
        {!items.length && q && (
          <Text type="secondary" style={{ fontSize: 12, padding: 8 }}>
            沒有符合「{q}」的 split
          </Text>
        )}
      </div>
      <div className="picker-foot">
        <Text type="secondary" style={{ fontSize: 11 }}>
          <kbd>[</kbd>
          <kbd>]</kbd> 前後切換 · 實驗頁（Ctrl+2）有縮圖、篩選與比較
        </Text>
      </div>
    </div>
  );

  return (
    <div className="splitbar">
      <Text type="secondary" style={{ fontSize: 12 }}>
        Split
      </Text>
      <Popover content={panel} trigger="click" open={open} onOpenChange={setOpen} placement="bottomLeft" arrow={false} destroyOnHidden>
        <Button size="small" className="split-picker-btn" aria-label="切換 split" aria-haspopup="listbox">
          {active ? <StateDot s={active} /> : <span className="state-dot base" />}
          <span className="split-picker-name">{active ? active.name : '原始'}</span>
          <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Popover>
      {active && (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'rename', icon: <EditOutlined />, label: '重新命名', onClick: () => (setRenaming(active), setName(active.name)) },
              { key: 'dup', icon: <CopyOutlined />, label: '複製這個 split', onClick: () => ed.duplicateSplit(active.id) },
              { key: 'del', icon: <DeleteOutlined />, label: '刪除', danger: true, onClick: () => confirmRemove(active) },
            ],
          }}
        >
          <Button type="text" size="small" aria-label="這個 split 的更多操作">
            ⋯
          </Button>
        </Dropdown>
      )}
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            { key: 'blank', icon: <PlusOutlined />, label: '空白 split（從原始開始）', onClick: () => void ed.addSplit() },
            { key: 'dup', icon: <CopyOutlined />, label: '複製目前的 split', disabled: !ed.active, onClick: () => ed.active && ed.duplicateSplit(ed.active.id) },
            { key: 'lab', icon: <ExperimentOutlined />, label: '去實驗頁定義變數、一次產生多個（Ctrl+2）', onClick: () => ed.setPage('lab') },
          ],
        }}
      >
        <Button size="small" type="dashed" icon={<PlusOutlined />}>
          新增
        </Button>
      </Dropdown>
      {!ed.splits.length && (
        <Text type="secondary" style={{ fontSize: 12 }} ellipsis>
          還沒有 split：直接在原始上改會自動建立 Split 1，或到實驗頁一次產生多個
        </Text>
      )}
      <span className="grow" />
      {ed.splits.length > 0 && (
        <Text type="secondary" className="split-hint" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {ed.splits.length} 個 split · <kbd>[</kbd>
          <kbd>]</kbd> 切換
        </Text>
      )}
      <Modal title="重新命名" open={!!renaming} onCancel={() => setRenaming(null)} onOk={finishRename} okText="確定" width={360} destroyOnHidden>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={finishRename} />
      </Modal>
    </div>
  );
}

export const SplitPicker = memoEd(SplitPickerImpl, ['active', 'activeId', 'designs', 'nmPerVoxel', 'splits'], 'SplitPicker');
