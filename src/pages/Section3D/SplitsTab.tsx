import { useMemo } from 'react';
import { Alert, Button, Flex, Table, Typography } from 'antd';
import { DownloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { bboxDims } from '../../volume/volume';
import { signed } from '../../ui/format';
import type { Editor } from './editor';

const { Text } = Typography;

/** 右欄「Split」總表：每個 split 一列，選取結構的 H／W 與改動體素。 */
export function SplitsTab({ ed, onExportAll, onSweep }: { ed: Editor; onExportAll: () => void; onSweep: () => void }) {
  const focus = ed.selComps[0];
  const was = focus ? ed.origByKey.get(focus.key) : undefined;
  const base = was ? bboxDims(was.bbox) : null;
  const diffCounts = useMemo(() => new Map(ed.splits.map((s) => [s.id, ed.diffOf(s.cur.vol).count])), [ed.splits, ed.diffOf]);
  const rows = ed.splits.map((s) => {
    const c = focus ? s.cur.L.comps.find((x) => x.key === focus.key) : undefined;
    const d = c ? bboxDims(c.bbox) : null;
    return { key: s.id, name: s.name, h: d?.h, w: d?.w, diff: diffCounts.get(s.id) ?? 0 };
  });
  const dim = (k: 'h' | 'w') => (_: unknown, r: (typeof rows)[number]) => {
    const v = r[k];
    if (v === undefined) return '—';
    const delta = base ? v - base[k] : 0;
    return (
      <div className="dim-cell">
        {v}
        {delta ? <small className="up">{signed(delta)}</small> : null}
      </div>
    );
  };
  return (
    <Flex vertical gap={20}>
      <Alert
        type="info"
        showIcon
        message={
          focus
            ? `表裡的尺寸是 ${focus.label} 在各個 split 的值（voxel；橘色是和原始的差）`
            : '選一個結構，這裡會列出它在每個 split 的尺寸'
        }
      />
      <Table
        size="small"
        className="dim-table"
        pagination={false}
        dataSource={rows}
        rowClassName={(r) => (r.key === ed.activeId ? 'row-on' : '')}
        onRow={(r) => ({ onClick: () => ed.setActiveId(r.key) })}
        columns={[
          { title: 'Split', dataIndex: 'name', key: 'name', ellipsis: true },
          { title: '高 H', key: 'h', align: 'right', width: 54, render: dim('h') },
          { title: '寬 W', key: 'w', align: 'right', width: 54, render: dim('w') },
          { title: '改動 vx', dataIndex: 'diff', key: 'diff', align: 'right', width: 76, render: (v: number) => v.toLocaleString() },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        點一列切到那個 split。1 voxel = {ed.nmPerVoxel} nm。
      </Text>
      <Button icon={<ThunderboltOutlined />} onClick={onSweep} block>
        一次產生多個 split…
      </Button>
      <Button type="primary" icon={<DownloadOutlined />} onClick={onExportAll} block>
        全部匯出（zip）
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>
        zip 裡每個 split 一個 .npy（同 shape、同 dtype），加一份 manifest.json 記錄每個 split 做了哪些操作。
      </Text>
    </Flex>
  );
}
