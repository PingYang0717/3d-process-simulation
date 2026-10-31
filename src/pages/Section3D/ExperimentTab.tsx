// 「實驗」頁籤（plan v11 §4.2）：定義變數 → 組合 → 從哪裡開始 → 產生前預覽 → 產生；範本存取（§4.3）。
// 變數清單存在 localStorage（designDraft），重新整理後還在；產生出來的 split 帶 levels／designId（標註，§9 D11）。
import { useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Dropdown, Flex, Input, InputNumber, Segmented, Select, Slider, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, DownOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { type Vec3, DIRECTIONS, VOID, kindOf } from '../../volume/volume';
import { axisIndex } from '../../volume/scope';
import {
  type Design,
  type DesignTemplate,
  type Factor,
  type FactorOp,
  DEFAULT_NAME_TEMPLATE,
  belowHalf,
  combosOf,
  deltaOf,
  formatLevel,
  fromTemplate,
  fromVx,
  makeFactor,
  measureNominal,
  nameOfCombo,
  nominalLevel,
  opsOfCombo,
  otherColumn,
  parseLevels,
  toTemplate,
} from '../../volume/factors';
import { previewOp } from '../../volume/preview';
import { newReport } from '../../volume/kernel';
import { usePersisted } from '../../ui/persist';
import { download } from '../../ui/download';
import type { Editor } from './editor';
import { whoText } from './opWords';
import { FacePicker } from './FacePicker';
import { roundFrame } from './RoundCard';

const { Text } = Typography;

/** 8 色類別色盤（疊圖、變數色點共用）。 */
export const CATEGORY = ['#2f6fdf', '#e8604c', '#2a9d8f', '#f4a261', '#9d7bd8', '#d6336c', '#7a8c2e', '#4cc9f0'];

const OP_LABEL: Record<FactorOp, string> = {
  cd: '對稱 CD（寬度）',
  push: '長／縮一面',
  translate: '整塊移動',
  level: '方頭到（recess）',
  round: '圓頭半徑',
  dilate: '保形層厚度',
  taper: '側壁斜度',
  defect: '缺陷（void）',
};

/** 草稿：變數＋每個變數的水平文字＋組合設定。 */
interface Draft {
  factors: Factor[];
  text: Record<string, string>;
  combine: Design['combine'];
  from: Design['from'];
  nameTemplate: string;
  picks: string[];
}
const EMPTY_DRAFT: Draft = { factors: [], text: {}, combine: 'full', from: 'base', nameTemplate: DEFAULT_NAME_TEMPLATE, picks: [] };
const isDraft = (v: unknown): v is Draft => !!v && typeof v === 'object' && Array.isArray((v as Draft).factors) && typeof (v as Draft).text === 'object';
const isTemplates = (v: unknown): v is DesignTemplate[] => Array.isArray(v);

/** 依材質類別排的操作清單：介電薄層 dilate 在前、閘極／金屬 cd／taper 在前，其他都有。 */
function opsFor(kind: string): FactorOp[] {
  const all: FactorOp[] = ['push', 'translate', 'level', 'round', 'defect'];
  if (kind === 'diel') return ['dilate', ...all, 'cd', 'taper'];
  if (kind === 'metal' || kind === 'semi') return ['cd', 'taper', ...all, 'dilate'];
  return [...all, 'cd', 'taper', 'dilate'];
}

const dirOptions = DIRECTIONS.map((d) => ({ value: d.id, label: `${d.arrow} ${d.name}` }));
const dirOf = (id: string) => DIRECTIONS.find((d) => d.id === id)!.d;
const dirId = (d: Vec3) => DIRECTIONS.find((x) => x.d[0] === d[0] && x.d[1] === d[1] && x.d[2] === d[2])?.id ?? 'up';
const AX = ['x', 'y', 'z'] as const;

/** 新增變數：選操作 → 填固定欄位（template）→ 加入。結構＝目前的選取。 */
function NewFactor({ ed, taken, onAdd }: { ed: Editor; taken: string[]; onAdd: (f: Factor) => void }) {
  const kind = ed.selComps.length ? kindOf(ed.materials.find((m) => m.id === ed.selComps[0].mat) ?? { id: 0, name: '', color: '' }) : 'other';
  const ops = opsFor(kind);
  const [op, setOp] = useState<FactorOp>(ops[0]);
  const [axis, setAxis] = useState<0 | 1 | 2>(() => (ed.selBox ? longest(ed) : 0));
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
    // 同一平面上和選取外框相交的結構先列（例如 fin、STI），再列其他
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
  if (!keys.length) return <Alert type="info" showIcon message="先在 3D 或左欄選結構（Shift 多選），再按「新增變數」" />;
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
  const row = (label: string, el: React.ReactNode) => (
    <Flex align="center" gap={8}>
      <span style={{ fontSize: 12, width: 64, flex: 'none' }}>{label}</span>
      {el}
    </Flex>
  );
  const axisSeg = (v: 0 | 1 | 2, set: (a: 0 | 1 | 2) => void) => <Segmented size="small" value={v} onChange={(x) => set(x as 0 | 1 | 2)} options={AX.map((a, i) => ({ label: a, value: i }))} />;
  return (
    <Flex vertical gap={8} className="factor-new">
      <Text style={{ fontSize: 12 }}>
        結構：<b>{whoText(ed.L, keys, ed.matName)}</b>
      </Text>
      {row('操作', <Select size="small" style={{ flex: 1 }} value={op} onChange={setOp} options={ops.map((o) => ({ value: o, label: OP_LABEL[o] }))} />)}
      {(op === 'cd' || op === 'translate') && row('軸', axisSeg(axis, setAxis))}
      {op === 'cd' &&
        row(
          '錨點',
          <Segmented size="small" value={anchor} onChange={(v) => setAnchor(v as typeof anchor)} options={[{ label: '中心', value: 'center' }, { label: `${AX[axis]} 小端不動`, value: 'lo' }, { label: `${AX[axis]} 大端不動`, value: 'hi' }]} />,
        )}
      {(op === 'push' || op === 'level' || op === 'taper') && row(op === 'taper' ? '側壁' : '面', <FacePicker value={dir} onChange={setDir} size={72} />)}
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
          {AX.map((a, k) =>
            row(
              `中心 ${a}`,
              <Slider style={{ flex: 1 }} min={0} max={1} step={0.01} value={center[k]} onChange={(v) => setCenter((c) => c.map((x, i) => (i === k ? v : x)) as Vec3)} />,
            ),
          )}
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
        row('單位', <Segmented size="small" value={unit} onChange={(v) => setUnit(v as 'nm' | 'vx')} options={[{ label: 'nm', value: 'nm' }, { label: 'voxel', value: 'vx' }]} />)}
      <Flex justify="end">
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={add}>
          加入變數
        </Button>
      </Flex>
    </Flex>
  );
}

/** 選取最長的那一軸（cd 預設軸）。 */
function longest(ed: Editor): 0 | 1 | 2 {
  const b = ed.selBox!;
  const w = [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0];
  // CD 通常是最短的水平軸
  return w[0] <= w[2] ? 0 : 2;
}

/** 一個變數一列：色點 · 名稱（id）· 結構 · 操作 · 標稱 · 水平 · ⋯ */
function FactorRow({ ed, f, k, text, onText, onChange, onRemove }: { ed: Editor; f: Factor; k: number; text: string; onText: (t: string) => void; onChange: (f: Factor) => void; onRemove: () => void }) {
  const nm = ed.nmPerVoxel;
  const levels = parseLevels(text, f, nm);
  const missing = !f.keys.length || f.keys.some((key) => !ed.orig.L.comps.some((c) => c.key === key) && !ed.L.comps.some((c) => c.key === key));
  const lockedNominal = f.op === 'translate' || f.op === 'taper' || (f.op === 'defect' && !f.param.startsWith('center'));
  const u = f.op === 'defect' && f.param.startsWith('center') ? '' : f.unit;
  const show = (v: number, signed = false) => `${formatLevel(f, v, signed)}${u ? ` ${u}` : ''}`;
  return (
    <div className={'factor-row' + (missing ? ' warn' : '')}>
      <Flex align="center" gap={6}>
        <span className="factor-dot" style={{ background: CATEGORY[k % CATEGORY.length] }} />
        <Input size="small" value={f.id} onChange={(e) => onChange({ ...f, id: e.target.value.replace(/[^A-Za-z0-9_\-.]/g, '') })} style={{ width: 120 }} aria-label="變數 id" />
        <Input size="small" value={f.name} onChange={(e) => onChange({ ...f, name: e.target.value })} style={{ flex: 1 }} placeholder="顯示名" aria-label="顯示名" />
        <Tooltip title="刪掉這個變數">
          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={onRemove} aria-label="刪掉變數" />
        </Tooltip>
      </Flex>
      <Text type={missing ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
        {missing ? '請重選結構（範本對不到）' : whoText(ed.orig.L.comps.some((c) => f.keys.includes(c.key)) ? ed.orig.L : ed.L, f.keys, ed.matName)} · {OP_LABEL[f.op]}（{f.param}）· 標稱{' '}
        {lockedNominal ? '0' : show(fromVx(f, f.nominal, nm))}
        {!lockedNominal && !missing && (
          <Tooltip title="重新量標稱（用目前的 split）">
            <Button size="small" type="link" icon={<ReloadOutlined />} onClick={() => onChange({ ...f, nominal: measureNominal(ed.L, ed.vol, f) })} />
          </Tooltip>
        )}
      </Text>
      <Flex align="center" gap={6}>
        <Input size="small" value={text} onChange={(e) => onText(e.target.value)} placeholder={f.mode === 'absolute' ? '16, 18, 20 或 ±2 step 1 或 nominal ±10%' : '-1, 0, 1 或 -2..2 step 1'} status={levels === null ? 'error' : undefined} aria-label="水平" />
        <Segmented
          size="small"
          value={f.mode}
          onChange={(v) => onChange({ ...f, mode: v as Factor['mode'] })}
          options={[
            { label: '絕對', value: 'absolute' },
            { label: '相對', value: 'relative' },
          ]}
        />
      </Flex>
      {levels && levels.length > 0 && (
        <Flex gap={4} wrap="wrap">
          {levels.map((v, i) => {
            const nominal = deltaOf(f, v, nm) === 0;
            return (
              <Tag key={i} color={belowHalf(f, v, nm) ? 'orange' : nominal ? 'default' : 'blue'} bordered={false} style={{ fontSize: 11 }}>
                {show(v, f.mode === 'relative')}（{f.mode === 'absolute' ? show(otherColumn(f, v, nm), true) : show(otherColumn(f, v, nm))}）{u && f.unit === 'nm' ? ` = ${deltaOf(f, v, nm) > 0 ? '+' : ''}${deltaOf(f, v, nm)} vx` : ''}
                {nominal ? ' · 標稱' : ''}
                {belowHalf(f, v, nm) ? ' · 小於半格' : ''}
              </Tag>
            );
          })}
        </Flex>
      )}
    </div>
  );
}

export function ExperimentTab({ ed, onMade }: { ed: Editor; onMade?: () => void }) {
  const { message, modal } = App.useApp();
  const [draft, setDraft] = usePersisted<Draft>('designDraft', EMPTY_DRAFT, isDraft);
  const [templates, setTemplates] = usePersisted<DesignTemplate[]>('factorTemplates', [], isTemplates);
  const [adding, setAdding] = useState(false);
  const [trial, setTrial] = useState<Record<string, { changed: number; blocked: number } | 'big'> | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nm = ed.nmPerVoxel;
  const set = (p: Partial<Draft>) => {
    setTrial(null);
    setDraft((d) => ({ ...d, ...p }));
  };
  const design: Design = useMemo(
    () => ({
      factors: draft.factors.filter((f) => f.keys.length),
      levels: Object.fromEntries(draft.factors.map((f) => [f.id, parseLevels(draft.text[f.id] ?? '', f, nm) ?? []])),
      combine: draft.combine,
      picks: draft.combine === 'manual' ? draft.picks.map((p) => JSON.parse(p) as Record<string, number>) : undefined,
      from: draft.from,
      nameTemplate: draft.nameTemplate || DEFAULT_NAME_TEMPLATE,
    }),
    [draft, nm],
  );
  const allCombos = useMemo(() => combosOf({ ...design, combine: 'full' }, nm), [design, nm]);
  const combos = useMemo(() => combosOf(design, nm), [design, nm]);
  const ids = draft.factors.map((f) => f.id);
  const dupId = ids.find((id, i) => ids.indexOf(id) !== i);
  const fromAll = draft.from === 'all';
  const canAll = combos.length === 1 && ed.splits.length > 0;
  const startState = draft.from === 'active' && ed.active ? ed.active.cur : ed.orig;

  const updateFactor = (i: number, f: Factor) => {
    const old = draft.factors[i];
    const text = { ...draft.text };
    if (old.id !== f.id) {
      text[f.id] = text[old.id] ?? '';
      delete text[old.id];
    }
    set({ factors: draft.factors.map((x, k) => (k === i ? f : x)), text });
  };

  const runTrial = () => {
    const out: Record<string, { changed: number; blocked: number } | 'big'> = {};
    const ctx = ed.factorCtx(startState);
    combos.slice(0, 60).forEach((c, i) => {
      const name = nameOfCombo(design, c, i + 1);
      let changed = 0;
      let blocked = 0;
      for (const op of opsOfCombo(design, c, ctx)) {
        const r = newReport();
        const p = previewOp(startState, ed.orig.vol, op, 3_000_000, r);
        if (!p) {
          out[name] = 'big';
          return;
        }
        // 外框裡和目前不同的格數
        const { box, data } = p;
        const { X, Y } = startState.vol;
        const W = box.x1 - box.x0 + 1;
        const H = box.y1 - box.y0 + 1;
        for (let k = 0; k < data.length; k++) {
          const x = k % W;
          const y = ((k - x) / W) % H;
          const z = (k - x - y * W) / (W * H);
          if (data[k] !== startState.vol.data[((z + box.z0) * Y + y + box.y0) * X + x + box.x0]) changed++;
        }
        blocked += r.blocked;
      }
      out[name] = { changed, blocked };
    });
    setTrial(out);
  };

  const generate = async () => {
    if (!design.factors.length || !combos.length) return;
    if (dupId) {
      message.warning(`變數 id「${dupId}」重複`);
      return;
    }
    if (combos.length > 200) {
      message.error(`${combos.length} 個組合太多（上限 200）：改用逐一掃描或手動勾選`);
      return;
    }
    const go = async () => {
      const made = await ed.addDesign(design);
      if (made.length) {
        message.success(fromAll ? `已套用到 ${made.length} 個 split` : `已產生 ${made.length} 個 split`);
        onMade?.();
      }
    };
    if (combos.length > 50)
      modal.confirm({ title: `要產生 ${combos.length} 個 split`, content: '每個 split 都要重播一次，可能要一段時間。繼續？', okText: '產生', cancelText: '取消', onOk: go });
    else await go();
  };

  const saveTemplate = () => {
    let name = '';
    modal.confirm({
      title: '存成範本',
      content: <Input autoFocus placeholder="例如 FEOL 閘極" onChange={(e) => (name = e.target.value)} />,
      okText: '存',
      cancelText: '取消',
      onOk: () => {
        const tpl = toTemplate(design, name || `範本 ${templates.length + 1}`, ed.L, ed.matName);
        setTemplates((all) => [...all.filter((t) => t.name !== tpl.name), tpl]);
        message.success(`已存成範本「${tpl.name}」`);
      },
    });
  };
  const loadTemplate = (tpl: DesignTemplate) => {
    try {
      const { design: d, missing } = fromTemplate(tpl, ed.L, ed.vol, ed.matName);
      set({ factors: d.factors, text: Object.fromEntries(d.factors.map((f) => [f.id, (d.levels[f.id] ?? []).join(', ')])), combine: d.combine, nameTemplate: d.nameTemplate });
      if (missing.length) message.warning(`${missing.join('、')} 對不到結構，請重選`);
      else message.success(`已載入範本「${tpl.name}」`);
    } catch (e) {
      message.error((e as Error).message);
    }
  };
  const importFile = async (file: File) => {
    try {
      const tpl = JSON.parse(await file.text()) as DesignTemplate;
      setTemplates((all) => [...all.filter((t) => t.name !== tpl.name), tpl]);
      loadTemplate(tpl);
    } catch {
      message.error('讀不出範本 JSON');
    }
  };

  return (
    <Flex vertical gap={14} className="experiment-tab">
      <Flex align="center" gap={8}>
        <Text strong style={{ flex: 1 }}>
          變數
        </Text>
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'save', label: '存成範本…', disabled: !design.factors.length, onClick: saveTemplate },
              ...(templates.length ? [{ type: 'divider' as const }, ...templates.map((t) => ({ key: `t:${t.name}`, label: `載入「${t.name}」`, onClick: () => loadTemplate(t) }))] : []),
              { type: 'divider' as const },
              {
                key: 'export',
                label: '匯出 JSON',
                disabled: !design.factors.length,
                onClick: () => void download(new TextEncoder().encode(JSON.stringify(toTemplate(design, 'design', ed.L, ed.matName), null, 2)), 'design-template.json', 'application/json'),
              },
              { key: 'import', label: '匯入 JSON…', onClick: () => fileRef.current?.click() },
            ],
          }}
        >
          <Button size="small">
            範本 <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
      </Flex>
      {draft.factors.map((f, i) => (
        <FactorRow
          key={i}
          ed={ed}
          f={f}
          k={i}
          text={draft.text[f.id] ?? ''}
          onText={(t) => set({ text: { ...draft.text, [f.id]: t } })}
          onChange={(nf) => updateFactor(i, nf)}
          onRemove={() => set({ factors: draft.factors.filter((_, k) => k !== i) })}
        />
      ))}
      {dupId && <Alert type="warning" showIcon message={`變數 id「${dupId}」重複；同一個設計裡要唯一`} />}
      {adding ? (
        <NewFactor
          ed={ed}
          taken={ids}
          onAdd={(f) => {
            set({ factors: [...draft.factors, f], text: { ...draft.text, [f.id]: '' } });
            setAdding(false);
          }}
        />
      ) : (
        <Button icon={<PlusOutlined />} onClick={() => setAdding(true)}>
          新增變數（用目前的選取）
        </Button>
      )}
      {adding && (
        <Button size="small" type="link" onClick={() => setAdding(false)} style={{ alignSelf: 'flex-start' }}>
          取消新增
        </Button>
      )}

      <Text strong>組合</Text>
      <Segmented
        block
        value={draft.combine}
        onChange={(v) => set({ combine: v as Design['combine'] })}
        options={[
          { label: '逐一掃描', value: 'ofat' },
          { label: '全因子', value: 'full' },
          { label: '手動勾選', value: 'manual' },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {draft.combine === 'ofat'
          ? '每個變數各自掃，其他維持標稱'
          : draft.combine === 'full'
            ? `${design.factors.map((f) => (design.levels[f.id] ?? []).length || 0).join(' × ') || 0} = ${combos.length} 個 split`
            : `勾了 ${combos.length} 個組合`}
      </Text>
      {draft.combine === 'manual' && (
        <Flex vertical gap={2} style={{ maxHeight: 180, overflow: 'auto' }}>
          {allCombos.map((c, i) => {
            const key = JSON.stringify(c);
            return (
              <Checkbox key={key} checked={draft.picks.includes(key)} onChange={(e) => set({ picks: e.target.checked ? [...draft.picks, key] : draft.picks.filter((p) => p !== key) })}>
                {nameOfCombo(design, c, i + 1)}
              </Checkbox>
            );
          })}
        </Flex>
      )}

      <Text strong>從哪裡開始</Text>
      <Segmented
        block
        value={draft.from}
        onChange={(v) => set({ from: v as Design['from'] })}
        options={[
          { label: '原始', value: 'base' },
          { label: '接在目前 split 之後', value: 'active', disabled: !ed.active },
          { label: '套用到所有 split', value: 'all', disabled: !canAll },
        ]}
      />
      {!canAll && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          「套用到所有 split」只在只有一個組合（例如全部加同一個 void）且已有 split 時可用：對每個 split 各加一步，不產生新 split。
        </Text>
      )}

      <Flex align="center" gap={8}>
        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>命名樣板</span>
        <Input size="small" value={draft.nameTemplate} onChange={(e) => set({ nameTemplate: e.target.value })} placeholder={DEFAULT_NAME_TEMPLATE} />
      </Flex>
      <Text type="secondary" style={{ fontSize: 11 }}>
        每個變數一段、用 _ 連；可用 {'{id}'}、{'{name}'}、{'{value}'}、{'{unit}'}、{'{n}'}（序號）。
      </Text>

      {combos.length > 0 && design.factors.length > 0 && (
        <Flex vertical gap={4}>
          <Flex align="center" gap={8}>
            <Text strong style={{ flex: 1 }}>
              會產生
            </Text>
            <Button size="small" onClick={runTrial}>
              試算改動
            </Button>
          </Flex>
          <div className="design-preview">
            {combos.slice(0, 60).map((c, i) => {
              const name = nameOfCombo(design, c, i + 1);
              const t = trial?.[name];
              const isNominal = design.factors.every((f) => deltaOf(f, c[f.id] ?? nominalLevel(f, nm), nm) === 0);
              return (
                <Flex key={name} justify="space-between" gap={8} style={{ fontSize: 12 }}>
                  <span>
                    {name}
                    {isNominal && <Tag style={{ marginLeft: 6, fontSize: 10 }}>標稱</Tag>}
                  </span>
                  {t && (
                    <Text type={t !== 'big' && t.blocked ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                      {t === 'big' ? '範圍太大，不試算' : `改動 ≈ ${t.changed.toLocaleString()} 格${t.blocked ? `、被擋 ${t.blocked.toLocaleString()} 格` : ''}`}
                    </Text>
                  )}
                </Flex>
              );
            })}
            {combos.length > 60 && <Text type="secondary">…還有 {combos.length - 60} 個</Text>}
          </div>
        </Flex>
      )}
      <Button type="primary" block disabled={!design.factors.length || !combos.length || !!ed.busy || (fromAll && !canAll)} loading={!!ed.busy} onClick={generate}>
        {fromAll ? `套用到 ${ed.splits.length} 個 split` : `產生 ${combos.length} 個 split`}
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>
        每個組合用 Op 重播產生（Op 是唯一真相）；水平只是標註，寫進矩陣表與 manifest 的 levels。軸：{AX[axisIndex(ed.editAxis)]}；1 voxel = {nm} nm。
      </Text>
    </Flex>
  );
}

export { dirOptions, dirOf, dirId };
