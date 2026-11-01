// 右欄「矩陣」（plan v11 §4.4，原 Split 總表）：一列一個 split、一欄一個變數；選到結構時多 W／H／D；
// 改動 vx、被擋、tags；欄可排序、可隱藏；匯出 CSV（和 manifest 同一份資料）。
import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Dropdown, Flex, Input, Table, Tag, Typography } from 'antd';
import { DownloadOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import { bboxDims } from '../../volume/volume';
import { signed } from '../../ui/format';
import { download } from '../../ui/download';
import { type Editor, changedOf } from './editor';
import { factorsOf, levelCell, matrixCsv } from './matrix';
import { CATEGORY } from './colors';
import { StateDot } from './SplitPicker';

const { Text } = Typography;

export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');

/**
 * ids＝只列這些（實驗頁的篩選與排序後的順序）；onRow＝點一列（實驗頁：高亮，不切 split，plan v12 §10 D11）；highlight＝高亮哪一列。
 */
export function MatrixTab({
  ed,
  onCompare,
  fileOf,
  ids,
  onRow,
  highlight,
}: {
  ed: Editor;
  onCompare?: (id?: string) => void;
  fileOf?: (s: { name: string }) => string;
  ids?: string[];
  onRow?: (id: string) => void;
  highlight?: string | null;
}) {
  const focus = ed.selComps[0];
  const was = focus ? ed.origByKey.get(focus.key) : undefined;
  const base = was ? bboxDims(was.bbox) : null;
  const factors = useMemo(() => factorsOf(ed.designs), [ed.designs]);
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [tagFor, setTagFor] = useState<string | null>(null);
  const list = ids ? ids.map((id) => ed.splits.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s) : ed.splits;
  const rows = list.map((s) => {
    const c = focus ? s.cur.L.comps.find((x) => x.key === focus.key) : undefined;
    const d = c ? bboxDims(c.bbox) : null;
    return { key: s.id, name: s.name, h: d?.h, w: d?.w, dd: d?.d, diff: changedOf(s), blocked: s.blocked, tags: s.tags ?? [], levels: s.levels ?? {}, parked: s.state === 'parked' };
  });
  type Row = (typeof rows)[number];
  const dim = (k: 'h' | 'w' | 'dd') => (_: unknown, r: Row) => {
    const v = r[k];
    if (v === undefined) return '—';
    const delta = base ? v - base[k === 'dd' ? 'd' : k] : 0;
    return (
      <div className="dim-cell">
        {v}
        {delta ? <small className="up">{signed(delta)}</small> : null}
      </div>
    );
  };
  const show = (k: string) => !hiddenCols.has(k);
  const csv = () => {
    const name = (s: { name: string }) => (fileOf ? fileOf(s) : `${safeName(s.name)}.vti`);
    const text = matrixCsv(
      ed.splits.filter((s) => !ed.exportOff.has(s.id)).map((s) => ({ ...s, changedVoxels: changedOf(s) })),
      factors,
      name,
    );
    void download(new TextEncoder().encode(text), 'matrix.csv', 'text/csv');
  };
  const optional = [
    ...factors.map((f) => ({ key: `f:${f.id}`, label: f.name || f.id })),
    ...(focus ? [{ key: 'h', label: '高 H' }, { key: 'w', label: '寬 W' }, { key: 'dd', label: '深 D' }] : []),
    { key: 'diff', label: '改動 vx' },
    { key: 'blocked', label: '被擋' },
    { key: 'tags', label: 'tags' },
  ];
  const columns = [
    {
      title: '✓',
      key: 'export',
      width: 32,
      render: (_: unknown, r: Row) => (
        <Checkbox
          checked={!ed.exportOff.has(r.key)}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const next = new Set(ed.exportOff);
            if (e.target.checked) next.delete(r.key);
            else next.add(r.key);
            ed.setExportOff(next);
          }}
          aria-label={`匯出 ${r.name}`}
        />
      ),
    },
    {
      title: '',
      key: 'state',
      width: 24,
      render: (_: unknown, r: Row) => <StateDot s={ed.splits.find((x) => x.id === r.key)!} />,
    },
    {
      title: 'Split',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      sorter: (a: Row, b: Row) => a.name.localeCompare(b.name),
      render: (n: string, r: Row) =>
        editing === r.key ? (
          <Input
            size="small"
            autoFocus
            defaultValue={n}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => (ed.renameSplit(r.key, e.target.value.trim()), setEditing(null))}
            onPressEnter={(e) => (ed.renameSplit(r.key, (e.target as HTMLInputElement).value.trim()), setEditing(null))}
          />
        ) : (
          <span onDoubleClick={() => setEditing(r.key)} title="雙擊改名">
            {n}
          </span>
        ),
    },
    ...factors
      .filter((f) => show(`f:${f.id}`))
      .map((f, k) => ({
        title: (
          <span>
            <span className="factor-dot" style={{ background: CATEGORY[k % CATEGORY.length], marginRight: 4 }} />
            {f.name || f.id}
          </span>
        ),
        key: `f:${f.id}`,
        align: 'right' as const,
        width: 84,
        sorter: (a: Row, b: Row) => (a.levels[f.id] ?? -Infinity) - (b.levels[f.id] ?? -Infinity),
        render: (_: unknown, r: Row) => {
          const c = levelCell(f, r.levels[f.id], ed.nmPerVoxel);
          if (!c) return '—';
          return (
            <div className="dim-cell">
              {c.nominal ? '標稱' : c.main}
              <small>{c.nominal ? c.main : c.sub}</small>
            </div>
          );
        },
      })),
    ...(focus
      ? (['h', 'w', 'dd'] as const)
          .filter(show)
          .map((k) => ({ title: k === 'h' ? '高 H' : k === 'w' ? '寬 W' : '深 D', key: k, align: 'right' as const, width: 54, sorter: (a: Row, b: Row) => (a[k] ?? 0) - (b[k] ?? 0), render: dim(k) }))
      : []),
    ...(show('diff')
      ? [{ title: '改動 vx', dataIndex: 'diff', key: 'diff', align: 'right' as const, width: 76, sorter: (a: Row, b: Row) => (a.diff ?? 0) - (b.diff ?? 0), render: (v?: number) => (v === undefined ? '…' : v.toLocaleString()) }]
      : []),
    ...(show('blocked')
      ? [{ title: '被擋', dataIndex: 'blocked', key: 'blocked', align: 'right' as const, width: 56, sorter: (a: Row, b: Row) => (a.blocked ?? 0) - (b.blocked ?? 0), render: (v?: number) => (v === undefined ? '—' : v ? <Text type="warning">{v.toLocaleString()}</Text> : 0) }]
      : []),
    ...(show('tags')
      ? [
          {
            title: 'tags',
            key: 'tags',
            render: (_: unknown, r: Row) => (
              <Flex gap={2} wrap="wrap" onClick={(e) => e.stopPropagation()}>
                {r.tags.map((t) => (
                  <Tag key={t} closable bordered={false} style={{ fontSize: 10, marginInlineEnd: 0 }} onClose={() => ed.setSplitTags(r.key, r.tags.filter((x) => x !== t))}>
                    {t}
                  </Tag>
                ))}
                {tagFor === r.key ? (
                  <Input
                    size="small"
                    autoFocus
                    style={{ width: 72 }}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && !r.tags.includes(v)) ed.setSplitTags(r.key, [...r.tags, v]);
                      setTagFor(null);
                    }}
                    onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                  />
                ) : (
                  <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setTagFor(r.key)} aria-label="加 tag" />
                )}
              </Flex>
            ),
          },
        ]
      : []),
    ...(onCompare
      ? [
          {
            title: '',
            key: 'cmp',
            width: 32,
            render: (_: unknown, r: Row) => <Button size="small" type="text" icon={<EyeOutlined />} aria-label="並排看" onClick={(e) => (e.stopPropagation(), onCompare(r.key))} />,
          },
        ]
      : []),
  ];
  return (
    <Flex vertical gap={14}>
      <Alert
        type="info"
        showIcon
        message={
          factors.length
            ? `一列一個 split、一欄一個變數（水平；下一行小字是另一欄）。${focus ? `W／H／D 是 ${focus.label} 在各個 split 的值（voxel；橘色是和原始的差）。` : ''}`
            : focus
              ? `表裡的尺寸是 ${focus.label} 在各個 split 的值（voxel；橘色是和原始的差）`
              : '在「實驗」頁籤定義變數產生 split，這裡一列一個 split、一欄一個變數'
        }
      />
      <Flex gap={8} wrap="wrap">
        <Button size="small" icon={<DownloadOutlined />} disabled={!ed.splits.length} onClick={csv}>
          匯出 CSV
        </Button>
        {onCompare && (
          <Button size="small" icon={<EyeOutlined />} disabled={!ed.splits.length} onClick={() => onCompare()}>
            並排看
          </Button>
        )}
        <Dropdown
          trigger={['click']}
          menu={{
            items: optional.map((o) => ({
              key: o.key,
              label: <Checkbox checked={show(o.key)}>{o.label}</Checkbox>,
              onClick: () => {
                const next = new Set(hiddenCols);
                if (next.has(o.key)) next.delete(o.key);
                else next.add(o.key);
                setHiddenCols(next);
              },
            })),
          }}
        >
          <Button size="small">欄位</Button>
        </Dropdown>
      </Flex>
      <Table
        size="small"
        className="dim-table"
        pagination={rows.length > 50 ? { pageSize: 50, size: 'small' } : false}
        scroll={{ x: 'max-content' }}
        dataSource={rows}
        rowClassName={(r) => (r.key === (highlight ?? ed.activeId) ? 'row-on' : '')}
        onRow={(r) => ({ onClick: () => (onRow ? onRow(r.key) : void ed.setActiveId(r.key)) })}
        columns={columns}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {onRow ? '點一列高亮、雙擊名字改名' : '點一列切到那個 split，雙擊名字改名'}；✓ 取消的 split 匯出時不打包；實心點＝在記憶體、空心＝只留改到的那一小塊。1 voxel = {ed.nmPerVoxel} nm。
      </Text>
    </Flex>
  );
}
