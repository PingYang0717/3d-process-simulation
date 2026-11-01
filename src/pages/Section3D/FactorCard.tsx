// 實驗頁的變數卡：一張卡讀起來像一句話——「對 Poly-Si 1 的［頂端圓頭半徑 ▾］，現在是方角（0），要試：…」。
// 「要改什麼」（操作）在卡片上直接換，不用刪掉重加；軸、面、錨點這些固定欄位就放在卡片裡（不收起來）；
// 水平交給 LevelsEditor。滑過卡片，結構預覽上這個變數的標記會加粗。
import { useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, Flex, Input, InputNumber, Segmented, Select, Slider, Tooltip, Typography } from 'antd';
import { DeleteOutlined, DownOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { type Vec3, VOID } from '../../volume/volume';
import { type Factor, type FactorOp, type Problem, defaultId, fromVx, measureNominal, toVx } from '../../volume/factors';
import type { Editor } from './editor';
import { factorWords } from './opWords';
import { FacePicker } from './FacePicker';
import { LevelsEditor } from './LevelsEditor';
import { CATEGORY } from './colors';
import { ALL_OPS, OP_HELP, OP_LABEL, OP_SHORT, OpGlyph, kindOfSel, newFactor, opsFor, switchOp } from './factorMeta';

const { Text } = Typography;
const AX = ['x', 'y', 'z'] as const;

const Row = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="fc-set-row">
    <span className="fc-set-label">{label}</span>
    <div className="fc-set-body">{children}</div>
  </div>
);
const axisSeg = (v: 0 | 1 | 2, set: (a: 0 | 1 | 2) => void) => <Segmented size="small" value={v} onChange={(x) => set(x as 0 | 1 | 2)} options={AX.map((a, i) => ({ label: a, value: i }))} />;

/** 操作選單（新增與換操作共用）：圖示＋名稱＋一句話。 */
function opMenu(ops: FactorOp[], current: FactorOp | null, onPick: (op: FactorOp) => void) {
  return {
    items: ops.map((op) => ({
      key: op,
      label: (
        <div className={'op-menu-item' + (op === current ? ' on' : '')}>
          <span className="op-menu-glyph">
            <OpGlyph op={op} />
          </span>
          <span className="op-menu-text">
            <b>{OP_LABEL[op]}</b>
            <small>{OP_SHORT[op]}</small>
          </span>
        </div>
      ),
      onClick: () => onPick(op),
    })),
  };
}

/** 「加一個變數」：點開直接選操作，選了就加進去（預設欄位＋第一組預設水平），之後在卡片上調。 */
export function AddFactorButton({ ed, taken, onAdd, disabled }: { ed: Editor; taken: string[]; onAdd: (f: Factor, levels: number[]) => void; disabled?: boolean }) {
  const ops = opsFor(kindOfSel(ed));
  return (
    <Dropdown
      trigger={['click']}
      disabled={disabled}
      menu={opMenu(ops, null, (op) => {
        const { factor, levels } = newFactor(ed, op, taken);
        onAdd(factor, levels);
      })}
      placement="bottom"
      overlayClassName="op-menu"
    >
      <Button type="dashed" block icon={<PlusOutlined />} disabled={disabled} className="dp-add">
        {disabled ? '先在 ① 選結構，再加變數' : '加一個變數：選要改什麼'}
        {!disabled && <DownOutlined className="dp-caret" />}
      </Button>
    </Dropdown>
  );
}

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
  onHot,
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
  /** 滑過這張卡：結構預覽上這個變數的標記加粗。 */
  onHot?: (id: string | null) => void;
}) {
  const [editId, setEditId] = useState(false);
  const nm = ed.nmPerVoxel;
  const L = ed.orig.L.comps.some((c) => f.keys.includes(c.key)) ? ed.orig.L : ed.L;
  const missing = !f.keys.length || f.keys.some((key) => !ed.orig.L.comps.some((c) => c.key === key) && !ed.L.comps.some((c) => c.key === key));
  const w = factorWords(f, L, nm, ed.matName);
  const t = f.template;
  const color = CATEGORY[k % CATEGORY.length];
  // deps 寫實際讀的欄位（ed 在 memoEd 底下是身分不變的 Proxy，不能拿整個 ed 當 deps）
  const ops = useMemo(() => {
    const o = opsFor(kindOfSel(ed));
    return o.length === ALL_OPS.length ? o : ALL_OPS;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed.selComps, ed.materials]);
  /** 改固定欄位：重新量標稱（id 不變）。 */
  const setT = (patch: Record<string, unknown>) => {
    const nf = { ...f, template: { ...t, ...patch } };
    nf.nominal = measureNominal(ed.L, ed.vol, nf);
    onChange(nf, levels);
  };
  const setParam = (param: string) => {
    const nf = { ...f, param };
    nf.nominal = measureNominal(ed.L, ed.vol, nf);
    onChange(nf, levels);
  };
  const setUnit = (unit: Factor['unit']) => {
    if (unit === f.unit) return;
    const nf = { ...f, unit };
    onChange(
      nf,
      levels.map((v) => Math.round(fromVx(nf, toVx(f, v, nm), nm) * 1e6) / 1e6),
    );
  };
  const refs = useMemo(() => ed.comps.filter((c) => !f.keys.includes(c.key)).slice(0, 60).map((c) => ({ value: c.key, label: c.label })), [ed.comps, f.keys]);
  const id = f.id || defaultId(ed.L, f.keys, f.op, f.template, ed.matName);
  const fraction = f.op === 'defect' && f.param.startsWith('center');

  // 固定欄位：直接放在卡片上
  const settings: React.ReactNode[] = [];
  if (f.op === 'cd' || f.op === 'translate') settings.push(<Row label="沿哪個軸">{axisSeg(((t.axis as number) ?? 0) as 0 | 1 | 2, (a) => setT({ axis: a }))}</Row>);
  if (f.op === 'cd')
    settings.push(
      <Row label="哪邊不動">
        <Segmented size="small" value={(t.anchor as string) ?? 'center'} onChange={(v) => setT({ anchor: v })} options={[{ label: '中心（兩側對稱）', value: 'center' }, { label: `${AX[(t.axis as number) ?? 0]} 小端`, value: 'lo' }, { label: `${AX[(t.axis as number) ?? 0]} 大端`, value: 'hi' }]} />
      </Row>,
    );
  if (f.op === 'push' || (f.op === 'level' && !t.ref))
    settings.push(
      <Row label="哪一面">
        <FacePicker value={t.dir as Vec3} onChange={(d) => setT({ dir: d })} onHover={onFace} size={64} />
      </Row>,
    );
  if (f.op === 'level')
    settings.push(
      <Row label="相對於">
        <Select
          size="small"
          allowClear
          style={{ width: '100%' }}
          placeholder="（絕對座標）"
          value={(t.ref as { key: string } | undefined)?.key ?? null}
          onChange={(v) => {
            const nf = { ...f, template: { ...t }, param: v ? 'offset' : 'to' };
            if (v) nf.template.ref = { key: v, side: 'lo' };
            else delete nf.template.ref;
            nf.nominal = measureNominal(ed.L, ed.vol, nf);
            onChange(nf, levels);
          }}
          options={refs}
        />
        {!!t.ref && (
          <Segmented
            size="small"
            value={(t.ref as { side: string }).side}
            onChange={(v) => setT({ ref: { ...(t.ref as object), side: v } })}
            options={[
              { label: '它的頂（小端）', value: 'lo' },
              { label: '它的底（大端）', value: 'hi' },
            ]}
          />
        )}
      </Row>,
    );
  if (f.op === 'taper')
    settings.push(
      <Row label="哪面側壁">
        <FacePicker value={(t.face as Vec3) ?? [1, 0, 0]} onChange={(d) => setT({ face: d })} onHover={onFace} size={64} />
      </Row>,
      <Row label="高度軸">{axisSeg(((t.along as number) ?? 1) as 0 | 1 | 2, (a) => setT({ along: a }))}</Row>,
      <Row label="要變的是">
        <Segmented size="small" value={f.param} onChange={(v) => setParam(v as string)} options={[{ label: t.along === 1 || t.along === undefined ? '底' : '末端', value: 'bottom' }, { label: t.along === 1 || t.along === undefined ? '頂' : '起端', value: 'top' }, { label: '整體傾斜', value: 'both' }]} />
        <Checkbox checked={t.both !== false} onChange={(e) => setT({ both: e.target.checked })}>
          兩側對稱
        </Checkbox>
      </Row>,
    );
  if (f.op === 'defect') {
    const center = (t.center as Vec3) ?? [0.5, 0.5, 0.5];
    const size = (t.size as Vec3) ?? [20, 1, 30];
    settings.push(
      <Row label="要變的是">
        <Select
          size="small"
          style={{ width: '100%' }}
          value={f.param}
          onChange={(v) => setParam(v)}
          options={[0, 1, 2].flatMap((kk) => [
            { value: `size[${kk}]`, label: `大小 ${AX[kk]}（從 0 起）` },
            { value: `center[${kk}]`, label: `位置 ${AX[kk]}（0～1）` },
          ])}
        />
      </Row>,
      <Row label="形狀">
        <Segmented size="small" value={(t.shape as string) ?? 'slab'} onChange={(v) => setT({ shape: v })} options={[{ label: '片', value: 'slab' }, { label: '球', value: 'sphere' }, { label: '盒', value: 'box' }]} />
      </Row>,
      <Row label="位置（0～1）">
        <Flex vertical style={{ width: '100%' }}>
          {AX.map((a, kk) => (
            <Flex key={a} align="center" gap={6}>
              <span style={{ width: 12, fontSize: 12 }}>{a}</span>
              <Slider style={{ flex: 1, margin: '4px 6px' }} min={0} max={1} step={0.01} value={center[kk]} onChange={(v) => setT({ center: center.map((x, i) => (i === kk ? v : x)) })} />
            </Flex>
          ))}
        </Flex>
      </Row>,
      <Row label="大小（格）">
        <Flex gap={4}>
          {AX.map((a, kk) => (
            <InputNumber key={a} size="small" min={0} value={size[kk]} onChange={(v) => v !== null && setT({ size: size.map((x, i) => (i === kk ? Math.round(v) : x)) })} prefix={a} style={{ width: 72 }} />
          ))}
        </Flex>
      </Row>,
      <Row label="材質">
        <Select size="small" style={{ width: '100%' }} value={(t.mat as number) ?? VOID} onChange={(v) => setT({ mat: v })} options={ed.materials.filter((m) => m.id !== 0).sort((p, q) => Number(q.id === VOID) - Number(p.id === VOID)).map((m) => ({ value: m.id, label: m.name }))} />
      </Row>,
    );
  }
  if (f.op === 'cd' || f.op === 'push' || f.op === 'taper')
    settings.push(
      <Row label="碰到別的材質">
        <Segmented size="small" value={t.policy === 'overwrite' ? 'overwrite' : 'block'} onChange={(v) => setT({ policy: v === 'overwrite' ? 'overwrite' : undefined })} options={[{ label: '擋住', value: 'block' }, { label: '穿過去', value: 'overwrite' }]} />
      </Row>,
    );
  if (!fraction)
    settings.push(
      <Row label="單位">
        <Segmented size="small" value={f.unit} onChange={(v) => setUnit(v as Factor['unit'])} options={[{ label: 'nm', value: 'nm' }, { label: '格', value: 'vx' }]} />
        <Text type="secondary" style={{ fontSize: 11 }}>
          1 格 = {nm} nm
        </Text>
      </Row>,
    );

  return (
    <div className={'factor-card' + (missing ? ' warn' : '')} style={{ '--fc': color } as React.CSSProperties} onPointerEnter={() => onHot?.(f.id)} onPointerLeave={() => onHot?.(null)}>
      <div className="fc-head">
        <span className="fc-badge" aria-hidden>
          {k + 1}
        </span>
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
            <Tooltip title="重新量「現在的值」（用目前的 split）">
              <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => onChange({ ...f, nominal: measureNominal(ed.L, ed.vol, f) }, levels)} aria-label="重新量現在的值" />
            </Tooltip>
          )}
          <Tooltip title="刪掉這個變數">
            <Button size="small" type="text" icon={<DeleteOutlined />} onClick={onRemove} aria-label="刪掉變數" />
          </Tooltip>
        </span>
      </div>

      <div className="fc-what">
        <span className="fc-who">
          對 <b>{w.who}</b> 的
        </span>
        <Dropdown trigger={['click']} menu={opMenu(ops, f.op, (op) => op !== f.op && (({ factor, levels: lv }) => onChange(factor, lv))(switchOp(ed, f, op, taken)))} overlayClassName="op-menu" placement="bottomLeft">
          <button type="button" className="fc-op" aria-label={`要改什麼：${OP_LABEL[f.op]}，點一下換`}>
            <OpGlyph op={f.op} size={16} />
            <span>{OP_LABEL[f.op]}</span>
            <DownOutlined className="dp-caret" />
          </button>
        </Dropdown>
        {w.now && <span className="fc-now">{w.now}</span>}
        <Tooltip title={OP_HELP[f.op]}>
          <InfoCircleOutlined className="fc-info" aria-label="操作說明" />
        </Tooltip>
      </div>
      <div className="fc-short">{OP_SHORT[f.op]}</div>
      {missing && (
        <Text type="warning" className="dp-hint">
          對不到結構（範本裡的結構不在這個模型），請刪掉重加
        </Text>
      )}

      <LevelsEditor f={f} levels={levels} problems={problems} nm={nm} onChange={(lv, nf) => onChange(nf ?? f, lv)} />

      {settings.length > 0 && (
        <div className="fc-settings">
          <div className="fc-settings-title">細節</div>
          {settings.map((el, i) => (
            <div key={i}>{el}</div>
          ))}
        </div>
      )}
    </div>
  );
}
