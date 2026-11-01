// 實驗頁的變數（plan v12 §5.4 第 2 點）：新增表單（選操作 → 固定欄位）與變數卡（色帶、名稱＋id、一句話、水平 chips、設定 ▾）。
import { useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Flex, Input, InputNumber, Segmented, Select, Slider, Tooltip, Typography } from 'antd';
import { DeleteOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { type Vec3, VOID, kindOf } from '../../volume/volume';
import { type Factor, type FactorOp, type Problem, defaultId, makeFactor, measureNominal } from '../../volume/factors';
import type { Editor } from './editor';
import { OP_HELP, OP_LABEL, factorWords, whoText } from './opWords';
import { FacePicker } from './FacePicker';
import { roundFrame } from './RoundCard';
import { LevelsEditor } from './LevelsEditor';
import { CATEGORY } from './colors';

const { Text } = Typography;
const AX = ['x', 'y', 'z'] as const;

/** 依材質類別排的操作清單：介電薄層 dilate 在前、閘極／金屬 cd／taper 在前，其他都有。 */
function opsFor(kind: string): FactorOp[] {
  const all: FactorOp[] = ['push', 'translate', 'level', 'round', 'defect'];
  if (kind === 'diel') return ['dilate', ...all, 'cd', 'taper'];
  if (kind === 'metal' || kind === 'semi') return ['cd', 'taper', ...all, 'dilate'];
  return [...all, 'cd', 'taper', 'dilate'];
}
/** CD 預設軸：通常是最短的水平軸。 */
const cdAxis = (ed: Editor): 0 | 1 | 2 => {
  const b = ed.selBox;
  if (!b) return 0;
  return b.x1 - b.x0 <= b.z1 - b.z0 ? 0 : 2;
};
const row = (label: string, el: React.ReactNode) => (
  <Flex align="center" gap={8}>
    <span style={{ fontSize: 12, width: 64, flex: 'none', color: 'var(--c-text-2)' }}>{label}</span>
    {el}
  </Flex>
);
const axisSeg = (v: 0 | 1 | 2, set: (a: 0 | 1 | 2) => void) => <Segmented size="small" value={v} onChange={(x) => set(x as 0 | 1 | 2)} options={AX.map((a, i) => ({ label: a, value: i }))} />;

/** 新增變數：選操作 → 填固定欄位 → 加入。結構＝目前的選取。 */
export function NewFactorForm({ ed, taken, onAdd, onCancel, onFace }: { ed: Editor; taken: string[]; onAdd: (f: Factor) => void; onCancel: () => void; onFace?: (d: Vec3 | null) => void }) {
  const kind = ed.selComps.length ? kindOf(ed.materials.find((m) => m.id === ed.selComps[0].mat) ?? { id: 0, name: '', color: '' }) : 'other';
  const ops = opsFor(kind);
  const [op, setOp] = useState<FactorOp>(ops[0]);
  const [axis, setAxis] = useState<0 | 1 | 2>(() => cdAxis(ed));
  const [anchor, setAnchor] = useState<'center' | 'lo' | 'hi'>('center');
  const [dir, setDir] = useState<Vec3>([0, -1, 0]);
  const [refKey, setRefKey] = useState<string | null>(null);
  const [side, setSide] = useState<'lo' | 'hi'>('lo');
  const [along, setAlong] = useState<0 | 1 | 2>(1);
  const [both, setBoth] = useState(true);
  const [tparam, setTparam] = useState<'bottom' | 'top' | 'both'>('bottom');
  const [shape, setShape] = useState<'slab' | 'sphere' | 'box'>('slab');
  const [center, setCenter] = useState<Vec3>([0.5, 0.5, 0.5]);
  const [size, setSize] = useState<Vec3>([20, 1, 30]);
  const [dparam, setDparam] = useState('size[1]');
  const [mat, setMat] = useState(VOID);
  const [unit, setUnit] = useState<'nm' | 'vx'>('nm');
  const [overwrite, setOverwrite] = useState(false);
  const keys = [...ed.sel];
  const refs = useMemo(() => {
    const b = ed.selBox;
    if (!b) return [];
    const a = dir[0] ? 0 : dir[1] ? 1 : 2;
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    const overlaps = (c: (typeof ed.comps)[number]) => {
      const cl = [c.bbox.x0, c.bbox.y0, c.bbox.z0];
      const ch = [c.bbox.x1, c.bbox.y1, c.bbox.z1];
      return [0, 1, 2].every((k) => k === a || (cl[k] <= hi[k] && ch[k] >= lo[k]));
    };
    return ed.comps
      .filter((c) => !ed.sel.has(c.key))
      .sort((p, q) => Number(overlaps(q)) - Number(overlaps(p)) || q.count - p.count)
      .slice(0, 40)
      .map((c) => ({ value: c.key, label: `${c.label}${overlaps(c) ? '' : '（不相交）'}` }));
  }, [ed.comps, ed.sel, ed.selBox, dir]);
  if (!keys.length) return <Alert type="info" showIcon message="先在上面選一個結構，再加變數" />;
  const template = (): { template: Record<string, unknown>; param?: string } => {
    const pol = overwrite ? { policy: 'overwrite' } : {};
    switch (op) {
      case 'cd':
        return { template: { axis, anchor, ...pol } };
      case 'push':
        return { template: { dir, ...pol } };
      case 'translate':
        return { template: { axis } };
      case 'level':
        return refKey ? { template: { dir, ref: { key: refKey, side } }, param: 'offset' } : { template: { dir }, param: 'to' };
      case 'round': {
        const { axis: ra, at, scope } = roundFrame(ed);
        return { template: { axis: ra, at, scope, gesture: { corners: [{ id: 'ul' }, { id: 'ur' }], n: 2, mode: 'match' } } };
      }
      case 'dilate':
        return { template: {} };
      case 'taper':
        return { template: { face: dir, along, both, ...pol }, param: tparam };
      case 'defect':
        return { template: { shape, center, size, mat }, param: dparam };
    }
  };
  const add = () => {
    const t = template();
    onAdd(makeFactor(ed.L, ed.vol, keys, op, t.template, ed.matName, taken, op === 'defect' && dparam.startsWith('center') ? 'vx' : unit, t.param));
  };
  const face = (v: Vec3, set: (d: Vec3) => void) => <FacePicker value={v} onChange={set} onHover={onFace} size={72} />;
  return (
    <Flex vertical gap={8} className="factor-new">
      <div className="fn-title">
        新變數 <Text type="secondary">· {whoText(ed.L, keys, ed.matName)}</Text>
      </div>
      {row(
        '操作',
        <Select
          size="small"
          style={{ flex: 1 }}
          value={op}
          onChange={setOp}
          options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))}
          optionRender={(o) => (
            <Tooltip title={OP_HELP[o.value as string]} placement="right">
              <span style={{ display: 'block' }}>{o.label}</span>
            </Tooltip>
          )}
          aria-label="操作"
        />,
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        {OP_HELP[op]}
      </Text>
      {(op === 'cd' || op === 'translate') && row('軸', axisSeg(axis, setAxis))}
      {op === 'cd' &&
        row(
          '錨點',
          <Segmented size="small" value={anchor} onChange={(v) => setAnchor(v as typeof anchor)} options={[{ label: '中心', value: 'center' }, { label: `${AX[axis]} 小端不動`, value: 'lo' }, { label: `${AX[axis]} 大端不動`, value: 'hi' }]} />,
        )}
      {(op === 'push' || op === 'level' || op === 'taper') && row(op === 'taper' ? '側壁' : '面', face(dir, setDir))}
      {op === 'level' && (
        <>
          {row('相對於', <Select size="small" allowClear style={{ flex: 1 }} placeholder="（絕對座標）" value={refKey} onChange={(v) => setRefKey(v ?? null)} options={refs} />)}
          {refKey &&
            row(
              '參照面',
              <Segmented size="small" value={side} onChange={(v) => setSide(v as 'lo' | 'hi')} options={[{ label: dir[1] ? '頂（y 小）' : `${AX[dir[0] ? 0 : 2]} 小端`, value: 'lo' }, { label: dir[1] ? '底（y 大）' : `${AX[dir[0] ? 0 : 2]} 大端`, value: 'hi' }]} />,
            )}
        </>
      )}
      {op === 'taper' && (
        <>
          {row('高度軸', axisSeg(along, setAlong))}
          {row('變數', <Segmented size="small" value={tparam} onChange={(v) => setTparam(v as typeof tparam)} options={[{ label: along === 1 ? '底' : '末端', value: 'bottom' }, { label: along === 1 ? '頂' : '起端', value: 'top' }, { label: '整體傾斜', value: 'both' }]} />)}
          <Checkbox checked={both} onChange={(e) => setBoth(e.target.checked)}>
            兩側對稱
          </Checkbox>
        </>
      )}
      {op === 'defect' && (
        <>
          {row('形狀', <Segmented size="small" value={shape} onChange={(v) => setShape(v as typeof shape)} options={[{ label: '片', value: 'slab' }, { label: '球', value: 'sphere' }, { label: '盒', value: 'box' }]} />)}
          {AX.map((a, k) => <div key={a}>{row(`中心 ${a}`, <Slider style={{ flex: 1 }} min={0} max={1} step={0.01} value={center[k]} onChange={(v) => setCenter((c) => c.map((x, i) => (i === k ? v : x)) as Vec3)} />)}</div>)}
          {row(
            '大小（格）',
            <Flex gap={4}>
              {AX.map((a, k) => (
                <InputNumber key={a} size="small" min={0} value={size[k]} onChange={(v) => v !== null && setSize((s) => s.map((x, i) => (i === k ? Math.round(v) : x)) as Vec3)} prefix={a} style={{ width: 72 }} />
              ))}
            </Flex>,
          )}
          {row(
            '變數',
            <Select
              size="small"
              style={{ flex: 1 }}
              value={dparam}
              onChange={setDparam}
              options={[0, 1, 2].flatMap((k) => [
                { value: `size[${k}]`, label: `大小 ${AX[k]}（從 0 起）` },
                { value: `center[${k}]`, label: `位置 ${AX[k]}（0～1）` },
              ])}
            />,
          )}
          {row(
            '材質',
            <Select
              size="small"
              style={{ flex: 1 }}
              value={mat}
              onChange={setMat}
              options={ed.materials.filter((m) => m.id !== 0).sort((p, q) => Number(q.id === VOID) - Number(p.id === VOID)).map((m) => ({ value: m.id, label: m.name }))}
            />,
          )}
        </>
      )}
      {(op === 'cd' || op === 'push' || op === 'taper') && (
        <Checkbox checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)}>
          允許穿過其他材質（預設：{ed.pushPolicy === 'block' ? '擋住' : '蓋過去'}）
        </Checkbox>
      )}
      {!(op === 'defect' && dparam.startsWith('center')) &&
        row('單位', <Segmented size="small" value={unit} onChange={(v) => setUnit(v as 'nm' | 'vx')} options={[{ label: 'nm', value: 'nm' }, { label: '格（voxel）', value: 'vx' }]} />)}
      <Flex justify="end" gap={8}>
        <Button size="small" type="text" onClick={onCancel}>
          取消
        </Button>
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={add}>
          加入變數
        </Button>
      </Flex>
    </Flex>
  );
}

/** 一個變數一張卡：左邊一條色帶 · 名稱（粗體，直接改）＋ id 灰字 · 一句話 · 水平 chips ＋ 預設 · 設定 ▾。動作鍵滑過才浮出。 */
export function FactorCard({
  ed,
  f,
  k,
  levels,
  problems,
  taken,
  onChange,
  onRemove,
  onFace,
}: {
  ed: Editor;
  f: Factor;
  k: number;
  levels: number[];
  problems: Problem[];
  taken: string[];
  onChange: (f: Factor, levels: number[]) => void;
  onRemove: () => void;
  onFace?: (d: Vec3 | null) => void;
}) {
  const [editId, setEditId] = useState(false);
  const nm = ed.nmPerVoxel;
  const L = ed.orig.L.comps.some((c) => f.keys.includes(c.key)) ? ed.orig.L : ed.L;
  const missing = !f.keys.length || f.keys.some((key) => !ed.orig.L.comps.some((c) => c.key === key) && !ed.L.comps.some((c) => c.key === key));
  const w = factorWords(f, L, nm, ed.matName);
  const t = f.template;
  /** 改固定欄位：重新量標稱（id 不變）。 */
  const setT = (patch: Record<string, unknown>) => {
    const nf = { ...f, template: { ...t, ...patch } };
    nf.nominal = measureNominal(ed.L, ed.vol, nf);
    onChange(nf, levels);
  };
  const settings: React.ReactNode[] = [];
  if (f.op === 'cd' || f.op === 'translate') settings.push(row('軸', axisSeg(((t.axis as number) ?? 0) as 0 | 1 | 2, (a) => setT({ axis: a }))));
  if (f.op === 'cd')
    settings.push(
      row(
        '錨點',
        <Segmented size="small" value={(t.anchor as string) ?? 'center'} onChange={(v) => setT({ anchor: v })} options={[{ label: '中心', value: 'center' }, { label: '小端不動', value: 'lo' }, { label: '大端不動', value: 'hi' }]} />,
      ),
    );
  if (f.op === 'push' || (f.op === 'level' && !t.ref)) settings.push(row('面', <FacePicker value={t.dir as Vec3} onChange={(d) => setT({ dir: d })} onHover={onFace} size={64} />));
  if (f.op === 'taper') settings.push(row('側壁', <FacePicker value={t.face as Vec3} onChange={(d) => setT({ face: d })} onHover={onFace} size={64} />));
  if (f.op === 'cd' || f.op === 'push' || f.op === 'taper')
    settings.push(
      <Checkbox key="pol" checked={t.policy === 'overwrite'} onChange={(e) => setT({ policy: e.target.checked ? 'overwrite' : undefined })}>
        允許穿過其他材質
      </Checkbox>,
    );
  const rest = Object.entries(t)
    .filter(([key]) => !['axis', 'anchor', 'dir', 'face', 'policy', 'scope', 'gesture'].includes(key))
    .map(([key, v]) => `${key} = ${JSON.stringify(v)}`);
  const id = f.id || defaultId(ed.L, f.keys, f.op, f.template, ed.matName);
  return (
    <div className={'factor-card' + (missing ? ' warn' : '')} style={{ '--fc': CATEGORY[k % CATEGORY.length] } as React.CSSProperties}>
      <div className="fc-head">
        <Input
          size="small"
          variant="borderless"
          className="fc-name"
          value={f.name}
          onChange={(e) => {
            const name = e.target.value;
            // id 自動由名稱產生（ASCII）；名稱是中文時保留原 id
            const auto = name.replace(/[^A-Za-z0-9_\-.]/g, '');
            onChange({ ...f, name, ...(!editId && auto ? { id: taken.includes(auto) && auto !== f.id ? f.id : auto } : {}) }, levels);
          }}
          placeholder="變數名稱（例：L_g）"
          aria-label="變數名稱"
        />
        {editId ? (
          <Input
            size="small"
            autoFocus
            value={f.id}
            onChange={(e) => onChange({ ...f, id: e.target.value.replace(/[^A-Za-z0-9_\-.]/g, '') }, levels)}
            onBlur={() => setEditId(false)}
            onPressEnter={() => setEditId(false)}
            style={{ width: 120 }}
            className="dp-mono"
            aria-label="變數 id"
          />
        ) : (
          <Tooltip title="檔名、CSV 與命名樣板用的 id（ASCII）；點一下改">
            <button type="button" className="factor-id" onClick={() => setEditId(true)}>
              {id}
            </button>
          </Tooltip>
        )}
        <span className="fc-acts">
          {!['translate', 'taper'].includes(f.op) && !missing && (
            <Tooltip title="重新量標稱（用目前的 split）">
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => onChange({ ...f, nominal: measureNominal(ed.L, ed.vol, f) }, levels)} aria-label="重新量標稱" />
            </Tooltip>
          )}
          <Tooltip title="刪掉這個變數">
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={onRemove} aria-label="刪掉變數" />
          </Tooltip>
        </span>
      </div>
      <div className="fc-desc">
        <b>{w.who}</b>
        <span>{w.what}</span>
        {w.now && <span className="fc-now">{w.now}</span>}
        <Tooltip title={OP_HELP[f.op]}>
          <InfoCircleOutlined className="fc-info" />
        </Tooltip>
      </div>
      {missing && (
        <Text type="warning" className="dp-hint">
          對不到結構（範本裡的結構不在這個模型），請刪掉重加
        </Text>
      )}
      <LevelsEditor f={f} levels={levels} problems={problems} nm={nm} onChange={(lv, nf) => onChange(nf ?? f, lv)} />
      {(settings.length > 0 || rest.length > 0) && (
        <Collapse
          ghost
          size="small"
          className="factor-settings"
          items={[
            {
              key: 's',
              label: <span className="fc-settings-label">設定</span>,
              children: (
                <Flex vertical gap={6}>
                  {settings.map((el, i) => (
                    <div key={i}>{el}</div>
                  ))}
                  {rest.length > 0 && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {rest.join(' · ')}
                    </Text>
                  )}
                </Flex>
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
