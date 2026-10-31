import { useState } from 'react';
import { Alert, Button, Collapse, Empty, Flex, InputNumber, Select, Space, Table, Tooltip, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { DIRECTIONS, type Vec3, bboxDims, isVoid } from '../../volume/volume';
import { MatLabel, Swatch } from '../../ui/Swatch';
import { Section, StatTile } from '../../ui/Stat';
import { signed } from '../../ui/format';
import type { Editor } from './editor';
import { ScopeControl } from './PositionBar';
import { commitGesture, modelContext, opOfGesture, resolveHandle } from './handleOps';
import { groupNormal, smoothEdgeGroup } from '../../slice/gestures';
import { Checkbox } from 'antd';

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
          <InputNumber value={n} onChange={setN} step={1} precision={0} suffix="vx" style={{ width: '100%' }} onPressEnter={apply} />
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

/** 整個選取沿一個方向補平到最外側：圓頭、斜角變方頭，一鍵完成。 */
function LevelRow({ ed }: { ed: Editor }) {
  const [dirId, setDirId] = useState('up');
  const dir = DIRECTIONS.find((d) => d.id === dirId)!;
  const to = ed.levelTarget(dir.d);
  const axisName = dir.axis;
  return (
    <Flex vertical gap={10}>
      <Flex gap={10} align="end">
        <label className="field" style={{ flex: 1 }}>
          <span>哪一面</span>
          <Select
            value={dirId}
            onChange={setDirId}
            optionLabelProp="label"
            options={DIRECTIONS.map((d) => ({ value: d.id, label: `${d.arrow} ${d.name}`, title: d.hint }))}
          />
        </label>
        <Button block style={{ flex: 1.3 }} onClick={() => ed.levelWhole(dir.d)} disabled={to === null || !!ed.busy} loading={!!ed.busy}>
          補平成方頭（{axisName} = {to ?? '–'}）
        </Button>
      </Flex>
      <Text type="secondary" style={{ fontSize: 12 }}>
        選取裡每一排都補到{dir.name}最外側那一點（{axisName} = {to ?? '–'}，{to === null ? '' : `${(to * ed.nmPerVoxel).toFixed(1)} nm`}）。只填空氣；薄襯層
        {ed.follow ? '跟著往外推' : '會擋住（設定裡開「襯層一起推」才跟著走）'}，厚的鄰居不吃。只補一小塊請在 3D 上用「補平」筆刷點。
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

/** 選到節點或邊時：數值輸入（和拖拉產生完全相同的 Op，§5.5）。 */
function HandleRow({ ed }: { ed: Editor }) {
  const h = ed.handle!;
  const [uName, vName] = h.axis === 'z' ? ['x', 'y'] : h.axis === 'y' ? ['x', 'z'] : ['z', 'y'];
  const [pos, setPos] = useState<[number | null, number | null]>([h.p[0], h.p[1]]);
  const [n, setN] = useState<number | null>(1);
  const [single, setSingle] = useState(false);
  const [lastP, setLastP] = useState(h.p);
  if (lastP !== h.p) {
    setLastP(h.p);
    setPos([h.p[0], h.p[1]]);
  }
  const ctx = () => modelContext(ed, h.axis, h.at, [...ed.sel], { scope: ed.scope, follow: ed.follow, backfill: ed.backfill, nm: ed.nmPerVoxel });
  const run = (delta: [number, number], shift = false) => {
    const c = ctx();
    const hh = resolveHandle(c, h);
    if (!hh) return;
    const { op } = opOfGesture(c, hh, delta, shift, ed.mirror);
    if (op) {
      // 和拖拉同一條路：幾何層先更新、再送 Op（§7.8）
      commitGesture(ed, c, hh, delta, shift, op);
      const p = h.vid ? c.model?.vertices[h.vid] : null;
      ed.setHandle({ ...h, p: p && h.kind === 'node' ? [p.u, p.v] : [h.p[0] + Math.round(delta[0]), h.p[1] + Math.round(delta[1])] });
    }
  };
  if (h.kind === 'node')
    return (
      <Flex vertical gap={10}>
        <Flex gap={10} align="end">
          <label className="field">
            <span>{uName}</span>
            <InputNumber value={pos[0]} onChange={(v) => setPos([v, pos[1]])} precision={0} style={{ width: '100%' }} onPressEnter={() => run([(pos[0] ?? h.p[0]) - h.p[0], (pos[1] ?? h.p[1]) - h.p[1]])} />
          </label>
          <label className="field">
            <span>{vName}</span>
            <InputNumber value={pos[1]} onChange={(v) => setPos([pos[0], v])} precision={0} style={{ width: '100%' }} onPressEnter={() => run([(pos[0] ?? h.p[0]) - h.p[0], (pos[1] ?? h.p[1]) - h.p[1]])} />
          </label>
          <Button onClick={() => run([(pos[0] ?? h.p[0]) - h.p[0], (pos[1] ?? h.p[1]) - h.p[1]])} disabled={pos[0] === h.p[0] && pos[1] === h.p[1]}>
            套用
          </Button>
        </Flex>
        <Flex gap={8}>
          <Button size="small" onClick={() => run([h.origin[0] - h.p[0], h.origin[1] - h.p[1]])} disabled={h.origin[0] === h.p[0] && h.origin[1] === h.p[1]}>
            回到原位（{h.origin[0]}, {h.origin[1]}）
          </Button>
          <Button size="small" type="text" onClick={() => ed.setHandle(null)}>
            取消選把手（Esc）
          </Button>
        </Flex>
        <Text type="secondary" style={{ fontSize: 12 }}>
          節點在 {h.axis} = {h.at} 那一片；Enter 套用到範圍，和拖這個節點產生同一個步驟。方向鍵一次 1 格（Shift 10）。
        </Text>
      </Flex>
    );
  const c = ctx();
  const hh = resolveHandle(c, h);
  const r = hh ? c.rings.get(hh.key)![hh.ring] : null;
  const group = r && hh ? smoothEdgeGroup(r, hh.index, single) : [];
  let len = 0;
  if (r) for (let k = 0; k + 1 < group.length; k++) len += Math.hypot(r.pts[group[k + 1]][0] - r.pts[group[k]][0], r.pts[group[k + 1]][1] - r.pts[group[k]][1]);
  const push = () => {
    if (!r || !hh || !n) return;
    const nrm = groupNormal(r, group);
    run([nrm[0] * n, nrm[1] * n], single);
  };
  return (
    <Flex vertical gap={10}>
      <Text style={{ fontSize: 12 }}>
        長度 {len.toFixed(1)} vx（{(len * ed.nmPerVoxel).toFixed(1)} nm）
      </Text>
      <Flex gap={10} align="end">
        <label className="field">
          <span>往外推（負＝往內）</span>
          <InputNumber value={n} onChange={setN} precision={0} suffix="vx" style={{ width: '100%' }} onPressEnter={push} />
        </label>
        <Button type="primary" onClick={push} disabled={!n || !r}>
          推（{(Math.abs(n ?? 0) * ed.nmPerVoxel).toFixed(1)} nm）
        </Button>
      </Flex>
      <Checkbox checked={single} onChange={(e) => setSingle(e.target.checked)}>
        只推這一小段（同 Shift＋拖）
      </Checkbox>
      <Button size="small" type="text" onClick={() => ed.setHandle(null)} style={{ alignSelf: 'flex-start' }}>
        取消選把手（Esc）
      </Button>
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
            <b>調整</b>　按 3D 上方「2D 編輯」（E）切到放大的切面；整面長縮、移動、換材質在這裡輸入。選取會留著。
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
      {ed.handle && (
        <Section title={ed.handle.kind === 'node' ? '選到的節點' : '選到的邊'}>
          <HandleRow ed={ed} key={`${ed.handle.kind}${ed.handle.origin.join()}`} />
        </Section>
      )}
      <Section title="範圍（要改哪裡）">
        <ScopeControl ed={ed} showAxis />
      </Section>
      <Section title="長高／縮短">
        <PushRow ed={ed} />
      </Section>
      <Section title="補平（圓頭變方頭）">
        <LevelRow ed={ed} />
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
