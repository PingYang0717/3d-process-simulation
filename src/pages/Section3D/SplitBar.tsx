import { useState } from 'react';
import { Button, Dropdown, Input, Modal, Typography } from 'antd';
import { AppstoreOutlined, CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { BASE_ID, type Editor, type Split } from './editor';

const { Text } = Typography;

/** Split 列：「原始」＋每個 split 一個頁籤、新增、[ ] 切換、並排比較。 */
export function SplitBar({
  ed,
  compare,
  setCompare,
  onSweep,
}: {
  ed: Editor;
  compare: boolean;
  setCompare: (v: boolean) => void;
  onSweep: () => void;
}) {
  const [renaming, setRenaming] = useState<Split | null>(null);
  const [name, setName] = useState('');
  const startRename = (s: Split) => {
    setRenaming(s);
    setName(s.name);
  };
  const finishRename = () => {
    if (renaming) ed.renameSplit(renaming.id, name.trim());
    setRenaming(null);
  };
  const tabs = [{ id: BASE_ID, name: '原始' }, ...ed.splits.map((s) => ({ id: s.id, name: s.name }))];

  return (
    <div className="splitbar">
      <Text strong style={{ fontSize: 12, marginRight: 4 }}>
        Split
      </Text>
      <div className="split-tabs" role="tablist">
        {tabs.map((t) => {
          const on = t.id === ed.activeId;
          const s = ed.splits.find((x) => x.id === t.id);
          return (
            <div
              key={t.id}
              className={'split-tab' + (on ? ' on' : '') + (t.id === BASE_ID ? ' base' : '')}
              onClick={() => ed.setActiveId(t.id)}
              onDoubleClick={() => s && startRename(s)}
              role="tab"
              aria-selected={on}
            >
              <span className="split-name">{t.name}</span>
              {s && <span className="split-ops">{s.ops.length ? `${s.ops.length} 步` : '未改'}</span>}
              {s && on && (
                <Dropdown
                  trigger={['click']}
                  menu={{
                    items: [
                      { key: 'rename', icon: <EditOutlined />, label: '重新命名', onClick: () => startRename(s) },
                      { key: 'dup', icon: <CopyOutlined />, label: '複製這個 split', onClick: () => ed.duplicateSplit(s.id) },
                      {
                        key: 'del',
                        icon: <DeleteOutlined />,
                        label: '刪除',
                        danger: true,
                        disabled: ed.splits.length <= 1,
                        onClick: () => ed.removeSplit(s.id),
                      },
                    ],
                  }}
                >
                  <Button type="text" size="small" className="split-more" onClick={(e) => e.stopPropagation()} aria-label="更多">
                    ⋯
                  </Button>
                </Dropdown>
              )}
            </div>
          );
        })}
      </div>
      <Dropdown
        trigger={['click']}
        menu={{
          items: [
            { key: 'sweep', icon: <ThunderboltOutlined />, label: '同一個操作、不同數值（例：poly 長高 1／2／3 nm）…', onClick: onSweep },
            { key: 'blank', icon: <PlusOutlined />, label: '空白 split（從原始開始）', onClick: () => ed.addSplit() },
            {
              key: 'dup',
              icon: <CopyOutlined />,
              label: '複製目前的 split',
              disabled: !ed.active,
              onClick: () => ed.active && ed.duplicateSplit(ed.active.id),
            },
          ],
        }}
      >
        <Button size="small" type="dashed" icon={<PlusOutlined />}>
          新增
        </Button>
      </Dropdown>
      <span className="grow" />
      <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
        <kbd>[</kbd>
        <kbd>]</kbd> 切換
      </Text>
      <Button size="small" type={compare ? 'primary' : 'default'} icon={<AppstoreOutlined />} onClick={() => setCompare(!compare)}>
        並排比較
      </Button>
      <Modal title="重新命名" open={!!renaming} onCancel={() => setRenaming(null)} onOk={finishRename} okText="確定" width={360} destroyOnClose>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={finishRename} />
      </Modal>
    </div>
  );
}
