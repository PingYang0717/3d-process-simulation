import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Flex, InputNumber, Segmented, Table, Tooltip, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { bboxDims, isVoid } from '../../volume/volume';
import { Swatch } from '../../ui/Swatch';
import { Section, StatTile } from '../../ui/Stat';
import { signed } from '../../ui/format';
import type { Editor } from './editor';
import { CardShell, DefectCard, MaterialCard, MoveCard, PushCard, ShapeCard, wordsOf } from './OpCard';
import { commitGesture, modelContext, opOfGesture, resolveHandle } from './handleOps';
import { type DragArg, type DragMode, groupNormal, resolveNodeDrag, smoothEdgeGroup } from '../../slice/gestures';
import type { Op } from '../../volume/ops';
import { describeOp } from './opWords';

const { Text } = Typography;

export const matOf = (ed: Editor, id: number) =>
  ed.materials.find((m) => m.id === id) ?? { id, name: `材質 ${id}`, color: '#ff00ff' };

/**
 * 選到節點或邊時的卡片（plan v10 §4.4）：數值＋拖法，先預覽再套用；和拖拉同一條路（opOfGesture → commitGesture）。
 * 拖法：自動（依形狀選矩形角或單點）／矩形角／單點／自由衰減（同 Alt＋拖）。
 */
function HandleRow({ ed }: { ed: Editor }) {
  const h = ed.handle!;
  const [uName, vName] = h.axis === 'z' ? ['x', 'y'] : h.axis === 'y' ? ['x', 'z'] : ['z', 'y'];
  const [pos, setPos] = useState<[number, number]>([h.p[0], h.p[1]]);
  const [n, setN] = useState(1);
  const [drag, setDrag] = useState<DragMode>('auto');
  const [single, setSingle] = useState(false);
  const [lastP, setLastP] = useState(h.p);
  if (lastP !== h.p) {
    setLastP(h.p);
    setPos([h.p[0], h.p[1]]);
  }
  const c = useMemo(
    () => modelContext(ed, h.axis, h.at, [...ed.sel], { scope: ed.scope, follow: ed.follow, backfill: ed.backfill, nm: ed.nmPerVoxel }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ed.L, ed.vol, ed.sel, ed.scope, ed.follow, ed.backfill, ed.nmPerVoxel, ed.version, h],
  );
  const hh = resolveHandle(c, h);
  const r = hh ? c.rings.get(hh.key)?.[hh.ring] : undefined;
  const group = r && hh && h.kind === 'edge' ? smoothEdgeGroup(r, hh.index, single) : [];
  // 自由形變關閉（plan v11 §4.10）：節點只有矩形角、邊不能只推一段
  const mode: DragArg = h.kind === 'node' ? (ed.freeform ? drag : 'corner') : ed.freeform && single;
  const delta: [number, number] = useMemo(() => {
    if (h.kind === 'node') return [pos[0] - h.p[0], pos[1] - h.p[1]];
    if (!r || !group.length) return [0, 0];
    const nrm = groupNormal(r, group);
    return [nrm[0] * n, nrm[1] * n];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [h, pos[0], pos[1], n, r, group.join()]);
  const op = useMemo(() => (hh && (delta[0] || delta[1]) ? opOfGesture(c, hh, delta, mode, ed.mirror).op : null), [c, hh?.index, hh?.ring, hh?.key, delta, mode, ed.mirror]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (o: Op) => {
    if (!hh) return;
    commitGesture(ed, c, hh, delta, mode, o);
    const p = h.vid ? c.model?.vertices[h.vid] : null;
    ed.setHandle({ ...h, p: p && h.kind === 'node' ? [p.u, p.v] : [h.p[0] + Math.round(delta[0]), h.p[1] + Math.round(delta[1])] });
  };
  const words = op ? describeOp(wordsOf(ed), op) : '';
  const picked = r && hh && h.kind === 'node' ? resolveNodeDrag(r, hh.index, drag) : null;
  if (h.kind === 'node')
    return (
      <CardShell ed={ed} op={op} words={words} onApply={apply}>
        <Flex gap={10} align="end">
          <label className="field">
            <span>{uName}</span>
            <InputNumber value={pos[0]} onChange={(v) => v !== null && setPos([Math.round(v), pos[1]])} precision={0} style={{ width: '100%' }} />
          </label>
          <label className="field">
            <span>{vName}</span>
            <InputNumber value={pos[1]} onChange={(v) => v !== null && setPos([pos[0], Math.round(v)])} precision={0} style={{ width: '100%' }} />
          </label>
        </Flex>
        <Flex align="center" gap={8} wrap>
          <span style={{ fontSize: 12 }}>拖法</span>
          {!ed.freeform ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              矩形角（設定 → 進階：自由形變 打開才有單點、自由衰減）
            </Text>
          ) : (
          <Segmented
            size="small"
            value={drag}
            onChange={(v) => setDrag(v as DragMode)}
            options={[
              { label: '自動', value: 'auto' },
              { label: '矩形角', value: 'corner' },
              { label: '單點', value: 'single' },
              { label: '自由衰減', value: 'falloff' },
            ]}
          />
          )}
          {ed.freeform && drag === 'auto' && picked && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              這個節點用「{picked === 'corner' ? '矩形角' : picked === 'single' ? '單點' : '自由衰減'}」
            </Text>
          )}
        </Flex>
        <Flex gap={8}>
          <Button size="small" onClick={() => setPos([h.origin[0], h.origin[1]])} disabled={h.origin[0] === pos[0] && h.origin[1] === pos[1]}>
            回到原位（{h.origin[0]}, {h.origin[1]}）
          </Button>
          <Button size="small" type="text" onClick={() => ed.setHandle(null)}>
            取消選把手（Esc）
          </Button>
        </Flex>
        <Text type="secondary" style={{ fontSize: 12 }}>
          節點在 {h.axis} = {h.at} 那一片；拖法和拖這個節點一樣（Shift＋拖＝單點、Alt＋拖＝自由衰減）。
        </Text>
      </CardShell>
    );
  let len = 0;
  if (r) for (let k = 0; k + 1 < group.length; k++) len += Math.hypot(r.pts[group[k + 1]][0] - r.pts[group[k]][0], r.pts[group[k + 1]][1] - r.pts[group[k]][1]);
  return (
    <CardShell ed={ed} op={op} words={words} onApply={apply}>
      <Text style={{ fontSize: 12 }}>
        長度 {len.toFixed(1)} vx（{(len * ed.nmPerVoxel).toFixed(1)} nm）
      </Text>
      <Flex align="center" gap={8}>
        <span style={{ fontSize: 12 }}>長／縮（負＝往內）</span>
        <InputNumber value={n} onChange={(v) => v !== null && setN(Math.round(v))} precision={0} suffix="vx" style={{ width: 96 }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {(Math.abs(n) * ed.nmPerVoxel).toFixed(1)} nm
        </Text>
      </Flex>
      <Checkbox checked={single && ed.freeform} disabled={!ed.freeform} onChange={(e) => setSingle(e.target.checked)}>
        只推這一小段（同 Shift＋拖）
      </Checkbox>
      <Button size="small" type="text" onClick={() => ed.setHandle(null)} style={{ alignSelf: 'flex-start' }}>
        取消選把手（Esc）
      </Button>
    </CardShell>
  );
}

/** 右欄「選取與調整」。 */
export function Inspector({ ed }: { ed: Editor }) {
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
            <b>調整</b>　按 <kbd>E</kbd> 進入聚焦編輯：拖箭頭＝整面長／縮、拖角＝圓頭；再按 <kbd>E</kbd> 切到 2D 剖面。長／縮、方頭／圓頭、移動、材質也可以在這裡打數字，先看預覽再按「套用」。
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
      {ed.handle && (
        <Section title={ed.handle.kind === 'node' ? '選到的節點' : '選到的邊'}>
          <HandleRow ed={ed} key={`${ed.handle.kind}${ed.handle.origin.join()}`} />
        </Section>
      )}
      <Section title="長／縮">
        <PushCard ed={ed} />
      </Section>
      <Section title="方頭／圓頭">
        <ShapeCard ed={ed} />
      </Section>
      <Section title="移動">
        <MoveCard ed={ed} />
      </Section>
      <Section title="材質">
        <MaterialCard ed={ed} />
      </Section>
      {ed.sel.size === 1 && (
        <Section title="缺陷">
          <DefectCard ed={ed} />
        </Section>
      )}
    </>
  );
}
