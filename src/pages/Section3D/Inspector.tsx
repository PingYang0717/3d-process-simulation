import { useState } from 'react';
import { Alert, Button, Collapse, Empty, Flex, InputNumber, Segmented, Select, Slider, Space, Table, Tooltip, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { DIRECTIONS, type Vec3, bboxDims, isVoid, unionBBox } from '../../volume/volume';
import { MatLabel, Swatch } from '../../ui/Swatch';
import { Section, StatTile } from '../../ui/Stat';
import { signed } from '../../ui/format';
import type { Editor } from './editor';

const { Text } = Typography;

export const matOf = (ed: Editor, id: number) =>
  ed.materials.find((m) => m.id === id) ?? { id, name: `材質 ${id}`, color: '#ff00ff' };

function PushRow({ ed }: { ed: Editor }) {
  const [dirId, setDirId] = useState('up');
  const [n, setN] = useState<number | null>(1);
  const dir = DIRECTIONS.find((d) => d.id === dirId)!;
  const steps = Math.round(n ?? 0);
  const apply = () => ed.push(dir.d, steps);
  return (
    <Flex vertical gap={10}>
      <Flex gap={10}>
        <label className="field" style={{ flex: 1.4 }}>
          <span>方向</span>
          <Select
            value={dirId}
            onChange={setDirId}
            optionLabelProp="label"
            options={DIRECTIONS.map((d) => ({ value: d.id, label: `${d.arrow} ${d.name}`, title: d.hint }))}
          />
        </label>
        <label className="field">
          <span>幾格（負＝縮）</span>
          <InputNumber value={n} onChange={setN} step={1} precision={0} addonAfter="vx" style={{ width: '100%' }} onPressEnter={apply} />
        </label>
      </Flex>
      <Button type="primary" block onClick={apply} disabled={!steps || !!ed.busy} loading={!!ed.busy}>
        {steps < 0 ? `${dir.name}縮 ${-steps} 格` : `${dir.name}長 ${steps} 格`}（{(Math.abs(steps) * ed.nmPerVoxel).toFixed(1)} nm）
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>
        整面一起推；套用後選取保留，可以連續按。局部的凸起、補平請在 3D 上用筆刷。
      </Text>
    </Flex>
  );
}

function MoveRow({ ed }: { ed: Editor }) {
  const [v, setV] = useState<(number | null)[]>([0, 0, 0]);
  const set = (i: number) => (x: number | null) =>
    setV((p) => {
      const next = [...p];
      next[i] = x;
      return next;
    });
  // 畫面上「往上」是 y 索引變小：輸入用正＝往上，送出時轉號
  const d: Vec3 = [Math.round(v[0] ?? 0), -Math.round(v[1] ?? 0), Math.round(v[2] ?? 0)];
  const any = d.some(Boolean);
  const apply = () => ed.translate(d);
  const labels = ['左右 x（右＋）', '上下（上＋）', '前後 z（後＋）'];
  const words = [d[0] > 0 ? '右' : '左', d[1] < 0 ? '上' : '下', d[2] > 0 ? '後' : '前'];
  return (
    <Flex vertical gap={10}>
      <Flex gap={10}>
        {labels.map((l, i) => (
          <label className="field" key={l}>
            <span>{l}</span>
            <InputNumber value={v[i]} onChange={set(i)} precision={0} style={{ width: '100%' }} onPressEnter={apply} />
          </label>
        ))}
      </Flex>
      <Button block onClick={apply} disabled={!any || !!ed.busy}>
        整塊移動
        {any
          ? `（${d
              .map((n, i) => (n ? `往${words[i]} ${Math.abs(n)}` : ''))
              .filter(Boolean)
              .join('、')} vx）`
          : ''}
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>
        也可以用方向鍵：1 格、<kbd>Shift</kbd> 10 格，<kbd>PgUp</kbd>／<kbd>PgDn</kbd> 走前後。
      </Text>
    </Flex>
  );
}

function MaterialRow({ ed, value, onMaterial }: { ed: Editor; value?: number; onMaterial: (id: number) => void }) {
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Select
        style={{ flex: 1 }}
        value={value}
        placeholder="多種材質"
        disabled={!!ed.busy}
        onChange={(m) => onMaterial(m)}
        options={ed.materials.filter((m) => m.id !== 0).map((m) => ({ value: m.id, label: <MatLabel mat={m} /> }))}
      />
      <Button onClick={() => onMaterial(254)} disabled={!!ed.busy}>
        設為 VOID
      </Button>
    </Space.Compact>
  );
}

function ZRangeRow({ ed }: { ed: Editor }) {
  const [z0, z1] = ed.zRange;
  const max = ed.vol.Z - 1;
  const whole = z0 === 0 && z1 === max;
  const b = unionBBox(ed.selComps);
  const covered = b ? Math.max(0, Math.min(b.z1, z1) - Math.max(b.z0, z0) + 1) : 0;
  const depth = b ? b.z1 - b.z0 + 1 : 0;
  return (
    <Flex vertical gap={4}>
      <Segmented
        size="small"
        block
        value={whole ? 'all' : 'part'}
        onChange={(v) =>
          ed.setZRange(
            v === 'all'
              ? [0, max]
              : b
                ? [Math.round((b.z0 * 2 + b.z1) / 3), Math.round((b.z0 + b.z1 * 2) / 3)]
                : [ed.cursor[2], ed.cursor[2]],
          )
        }
        options={[
          { label: '整塊都改', value: 'all' },
          { label: '只改其中一段（z）', value: 'part' },
        ]}
      />
      {!whole && (
        <>
          <Slider
            range
            min={0}
            max={max}
            value={[z0, z1]}
            onChange={(v) => ed.setZRange([v[0], v[1]])}
            tooltip={{ formatter: (v) => `z = ${v}` }}
            marks={b ? { [b.z0]: { label: <small>{b.z0}</small> }, [b.z1]: { label: <small>{b.z1}</small> } } : undefined}
            style={{ margin: '4px 8px 18px' }}
          />
          <Flex align="center" gap={8}>
            <span style={{ fontSize: 12 }}>z 從</span>
            <InputNumber size="small" min={0} max={max} value={z0} onChange={(v) => v !== null && ed.setZRange([v, z1])} precision={0} style={{ width: 64 }} />
            <span style={{ fontSize: 12 }}>到</span>
            <InputNumber size="small" min={0} max={max} value={z1} onChange={(v) => v !== null && ed.setZRange([z0, v])} precision={0} style={{ width: 64 }} />
            <Button size="small" type="text" onClick={() => ed.setZRange([ed.cursor[2], ed.cursor[2]])}>
              只有十字那片
            </Button>
          </Flex>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {b ? `這段蓋到選取的 ${covered} / ${depth} 片；` : ''}3D 上藍色的部分就是會被改到的範圍，切面上是藍色虛線框
          </Text>
        </>
      )}
    </Flex>
  );
}

/** 右欄「選取與調整」。 */
export function Inspector({ ed, onMaterial }: { ed: Editor; onMaterial: (id: number) => void }) {
  const nm = ed.nmPerVoxel;
  const sel = ed.selComps;
  if (!sel.length)
    return (
      <Flex vertical gap={20} style={{ paddingTop: 8 }}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="還沒選取結構" />
        <ol className="steps">
          <li>
            <b>選取</b>　在 3D 或切面點一塊，或點左邊清單。<kbd>Shift</kbd>＋點可以多選，例如兩根 poly。
          </li>
          <li>
            <b>調整</b>　細修在 3D 上拖它的面（筆刷）；整面長縮、移動、換材質在這裡輸入。選取會留著。
          </li>
          <li>
            <b>匯出</b>　右上角「匯出」，shape 與 dtype 和原始一樣。
          </li>
        </ol>
        <div className="overview">
          <div>
            <span>{ed.comps.length}</span>結構
          </div>
          <div>
            <span>{ed.materials.filter((m) => m.id !== 0 && !isVoid(m.id)).length}</span>種材質
          </div>
          <div className="overview-wide">
            <span>
              {ed.vol.X} × {ed.vol.Y} × {ed.vol.Z}
            </span>
            voxels · 1 vx = {nm} nm
          </div>
        </div>
      </Flex>
    );

  const mats = new Set(sel.map((c) => c.mat));
  const first = matOf(ed, sel[0].mat);
  const rows = sel.map((c) => {
    const o = ed.origByKey.get(c.key);
    return { key: c.key, label: c.label, now: bboxDims(c.bbox), was: o ? bboxDims(o.bbox) : undefined };
  });
  const single = sel.length === 1 ? rows[0] : null;
  const dimCell = (k: 'w' | 'h' | 'd' | 'y') => (_: unknown, r: (typeof rows)[number]) => {
    const v = r.now[k];
    const delta = r.was ? v - r.was[k] : 0;
    return (
      <div className="dim-cell" title={`${(v * nm).toFixed(1)} nm`}>
        {v}
        {delta ? <small className="up">{signed(delta)}</small> : null}
      </div>
    );
  };

  return (
    <>
      <Flex align="center" gap={10}>
        <Swatch fill={first.color} isVoid={isVoid(first.id)} size={20} />
        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
          <Text strong style={{ fontSize: 16 }}>
            {single ? single.label : `已選 ${sel.length} 個結構`}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {mats.size === 1 ? first.name : `${mats.size} 種材質`} · {ed.selCount.toLocaleString()} voxels
            {single && ed.changedKeys.has(single.key) ? ' · 已改動' : ''}
          </Text>
        </Flex>
        <Tooltip title="取消選取（Esc）">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={ed.clearSel} aria-label="取消選取" />
        </Tooltip>
      </Flex>
      <Section
        title="尺寸"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            橘色＝和原始不同
          </Text>
        }
      >
        {single ? (
          <div className="stat-grid">
            <StatTile label="寬 W (x)" now={single.now.w} before={single.was?.w} nm={nm} />
            <StatTile label="高 H (y)" now={single.now.h} before={single.was?.h} nm={nm} />
            <StatTile label="深 D (z)" now={single.now.d} before={single.was?.d} nm={nm} />
            <StatTile label="頂部 Y" now={single.now.y} before={single.was?.y} nm={nm} />
          </div>
        ) : (
          <>
            <Table
              size="small"
              className="dim-table"
              pagination={false}
              dataSource={rows}
              columns={[
                { title: '結構', dataIndex: 'label', key: 'label', ellipsis: true },
                { title: '寬 W', key: 'w', align: 'right', width: 56, render: dimCell('w') },
                { title: '高 H', key: 'h', align: 'right', width: 56, render: dimCell('h') },
                { title: '深 D', key: 'd', align: 'right', width: 56, render: dimCell('d') },
                { title: '頂 Y', key: 'y', align: 'right', width: 56, render: dimCell('y') },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              單位 voxel；橘色＝和原始的差。滑到數字上看 nm。
            </Text>
          </>
        )}
      </Section>
      {ed.isBase && <Alert type="info" showIcon message="直接調整會自動建立 Split 1；原始本身不會變。" />}
      <Section title="材質">
        <MaterialRow ed={ed} value={mats.size === 1 ? [...mats][0] : undefined} onMaterial={onMaterial} />
      </Section>
      <Section title="要改哪裡">
        <ZRangeRow ed={ed} />
      </Section>
      <Section title="長高／縮短">
        <PushRow ed={ed} />
      </Section>
      <Collapse
        ghost
        size="small"
        className="insp-collapse"
        items={[{ key: 'move', label: <span className="insp-collapse-title">移動（整塊）</span>, children: <MoveRow ed={ed} /> }]}
      />
    </>
  );
}
