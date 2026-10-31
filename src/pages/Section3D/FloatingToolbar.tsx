import { useState } from 'react';
import { Button, Dropdown, Flex, InputNumber, Popover, Segmented, Space, Tooltip, Typography } from 'antd';
import { BorderOuterOutlined, DownOutlined, DragOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import type { Axis } from '../../volume/volume';
import { uvTo3D } from '../../volume/scope';
import { MatLabel } from '../../ui/Swatch';
import type { Editor } from './editor';
import { scopeWords } from './PositionBar';
import { commitGesture, modelContext, opOfGesture, resolveHandle } from './handleOps';
import { groupNormal, smoothEdgeGroup } from '../../slice/gestures';

const { Text } = Typography;

/** 切面上的四個方向（u 右、v 下）。 */
const PLANE_DIRS: { id: string; label: string; uv: [number, number] }[] = [
  { id: 'up', label: '↑ 上', uv: [0, -1] },
  { id: 'down', label: '↓ 下', uv: [0, 1] },
  { id: 'left', label: '← 左', uv: [-1, 0] },
  { id: 'right', label: '→ 右', uv: [1, 0] },
];

/**
 * 浮動工具列（plan v7 §5.4）：選到結構時貼在主切面的選取外框右上角。
 * 按鈕文字帶範圍詞（整根／此片／z a～b），範圍改了跟著改。
 */
export function FloatingToolbar({ ed, axis, onMaterial }: { ed: Editor; axis: Axis; onMaterial: (id: number) => void }) {
  const words = scopeWords(ed).short;
  const busy = !!ed.busy && ed.queued >= 3;
  const [pushDir, setPushDir] = useState('up');
  const [pushN, setPushN] = useState<number | null>(1);
  const [mv, setMv] = useState<[number | null, number | null]>([0, 0]);
  const handleEdge = ed.handle?.kind === 'edge' && ed.handle.axis === axis;
  const level = (uv: [number, number]) => ed.levelWhole(uvTo3D(axis, uv[0], uv[1]));
  const doPush = () => {
    const n = Math.round(pushN ?? 0);
    if (!n) return;
    if (pushDir === 'edge' && ed.handle) {
      // 已選邊的法線：和拖那條邊產生同一個 Op
      const ctx = modelContext(ed, axis, ed.handle.at, [...ed.sel], { scope: ed.scope, follow: ed.follow, backfill: ed.backfill, nm: ed.nmPerVoxel });
      const h = resolveHandle(ctx, ed.handle);
      if (!h) return;
      const r = ctx.rings.get(h.key)![h.ring];
      const nrm = groupNormal(r, smoothEdgeGroup(r, h.index));
      const delta: [number, number] = [nrm[0] * n, nrm[1] * n];
      const { op } = opOfGesture(ctx, h, delta, false, ed.mirror);
      commitGesture(ed, ctx, h, delta, false, op);
      return;
    }
    const d = PLANE_DIRS.find((x) => x.id === pushDir)!;
    ed.push(uvTo3D(axis, d.uv[0], d.uv[1]), n);
  };
  const dU = Math.round(mv[0] ?? 0);
  const dV = Math.round(mv[1] ?? 0);
  const [uName, vName] = axis === 'z' ? ['x', 'y'] : axis === 'y' ? ['x', 'z'] : ['z', 'y'];
  const pushPop = (
    <Flex vertical gap={10} style={{ width: 260 }}>
      <Segmented
        size="small"
        block
        value={pushDir}
        onChange={(v) => setPushDir(v as string)}
        options={[...PLANE_DIRS.map((d) => ({ label: d.label, value: d.id })), ...(handleEdge ? [{ label: '選的邊', value: 'edge' }] : [])]}
      />
      <Flex align="center" gap={8}>
        <span style={{ fontSize: 12 }}>格數（負＝往內）</span>
        <InputNumber size="small" value={pushN} onChange={setPushN} precision={0} suffix="vx" style={{ width: 96 }} onPressEnter={doPush} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {(Math.abs(pushN ?? 0) * ed.nmPerVoxel).toFixed(1)} nm
        </Text>
      </Flex>
      <Button type="primary" size="small" onClick={doPush} disabled={!pushN || busy}>
        往外推（{words}）
      </Button>
    </Flex>
  );
  const movePop = (
    <Flex vertical gap={10} style={{ width: 240 }}>
      <Flex gap={8}>
        <label className="field">
          <span>Δ{uName}（右＋）</span>
          <InputNumber size="small" value={mv[0]} onChange={(v) => setMv([v, mv[1]])} precision={0} style={{ width: '100%' }} />
        </label>
        <label className="field">
          <span>Δ{vName}（下＋）</span>
          <InputNumber size="small" value={mv[1]} onChange={(v) => setMv([mv[0], v])} precision={0} style={{ width: '100%' }} />
        </label>
      </Flex>
      <Button size="small" type="primary" disabled={(!dU && !dV) || busy} onClick={() => ed.translate(uvTo3D(axis, dU, dV), ed.follow)}>
        移動（{words}{ed.follow ? '，襯層一起' : ''}）
      </Button>
    </Flex>
  );
  return (
    <Space.Compact size="small" className="float-tb-inner">
      <Dropdown.Button
        size="small"
        disabled={busy}
        icon={<DownOutlined />}
        onClick={() => level([0, -1])}
        menu={{ items: PLANE_DIRS.map((d) => ({ key: d.id, label: `往${d.label.slice(2)}補平`, onClick: () => level(d.uv) })) }}
      >
        <Tooltip title="每一欄補到最外側那一點（圓頭、斜角變方頭）；▾ 選方向">
          <span>
            <VerticalAlignTopOutlined /> 方頭（{words}）
          </span>
        </Tooltip>
      </Dropdown.Button>
      <Popover content={pushPop} trigger="click" placement="bottom">
        <Button icon={<BorderOuterOutlined />}>往外推…</Button>
      </Popover>
      <Popover content={movePop} trigger="click" placement="bottom">
        <Button icon={<DragOutlined />}>移動…</Button>
      </Popover>
      <Dropdown
        trigger={['click']}
        disabled={busy}
        menu={{
          items: [
            ...ed.materials.filter((m) => m.id !== 0).map((m) => ({ key: `m${m.id}`, label: <MatLabel mat={m} />, onClick: () => onMaterial(m.id) })),
          ],
        }}
      >
        <Button>
          材質 <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Dropdown>
      <Button onClick={() => onMaterial(254)} disabled={busy}>
        設為 VOID
      </Button>
      {ed.sel.size > 1 && (
        <Tooltip title="多選時，在一個結構上的手勢也做在長得一樣的結構上（同材質、長寬比與面積相近）">
          <Button type={ed.mirror ? 'primary' : 'default'} onClick={() => ed.setMirror(!ed.mirror)}>
            對應 {ed.mirror ? '●' : '○'}
          </Button>
        </Tooltip>
      )}
    </Space.Compact>
  );
}
