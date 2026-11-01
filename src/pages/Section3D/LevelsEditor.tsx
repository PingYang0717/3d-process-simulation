// 水平編輯器：「要試的值」。
// 每個值是一顆 chip，點一下就能改數字（不用刪掉重加）；下面一列「快速產生」：起始／間距／個數三個欄位可以直接調，
// 預設按鈕只是把這三格填好並套用；「輸入清單…」才出現語法輸入框。右上角「寫法」切換絕對／相對，旁邊一句說明。
import { useEffect, useState } from 'react';
import { Button, Flex, Input, InputNumber, Popover, Segmented, Tooltip, Typography } from 'antd';
import { CloseOutlined, InfoCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { type Factor, type Problem, deltaOf, formatLevel, fromVx, lockedNominal, nominalLevel, otherColumn, parseLevels, presetLevels, switchMode } from '../../volume/factors';

const { Text } = Typography;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const uniqSorted = (vs: number[]) => [...new Set(vs.map(r6))].sort((a, b) => a - b);
const isFraction = (f: Factor) => f.op === 'defect' && f.param.startsWith('center');

/** 快速產生的三格：起始、間距、個數。 */
interface Gen {
  start: number;
  step: number;
  n: number;
}
const genValues = (g: Gen) => Array.from({ length: Math.max(1, Math.min(25, Math.round(g.n))) }, (_, i) => r6(g.start + i * g.step));
/** 一組預設水平 → 等價的三格（等距才算得出來；不等距就只填起始）。 */
function genOf(values: number[]): Gen {
  if (values.length < 2) return { start: values[0] ?? 0, step: 1, n: values.length || 3 };
  const step = r6(values[1] - values[0]);
  const even = values.every((v, i) => !i || Math.abs(v - values[i - 1] - step) < 1e-6);
  return { start: values[0], step: even ? step : 1, n: values.length };
}

/** 一顆 chip：主字＋小字；點開可以改數字或刪掉。 */
function Chip({ main, sub, problem, onEdit, onRemove, unit, value, step }: { main: string; sub: string; problem?: Problem; onEdit: (v: number) => void; onRemove: () => void; unit: string; value: number; step: number }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<number | null>(value);
  useEffect(() => setV(value), [value, open]);
  const commit = () => {
    if (v !== null && Number.isFinite(v)) onEdit(v);
    setOpen(false);
  };
  return (
    <Popover
      trigger="click"
      open={open}
      onOpenChange={setOpen}
      placement="bottom"
      content={
        <Flex vertical gap={8} style={{ width: 200 }}>
          <Text style={{ fontSize: 12 }}>改成</Text>
          <InputNumber autoFocus size="small" value={v} step={step} onChange={setV} onPressEnter={commit} suffix={unit} style={{ width: '100%' }} aria-label="水平的值" />
          {problem && (
            <Text type={problem.level === 'error' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {problem.msg}
            </Text>
          )}
          <Flex gap={6} justify="space-between">
            <Button size="small" type="text" danger onClick={() => (setOpen(false), onRemove())}>
              刪掉
            </Button>
            <Button size="small" type="primary" onClick={commit}>
              確定
            </Button>
          </Flex>
        </Flex>
      }
    >
      <Tooltip title={problem?.msg ?? '點一下改數字'} mouseEnterDelay={0.4} open={open ? false : undefined}>
        <button type="button" className={'level-chip' + (problem ? ` ${problem.level}` : '')} aria-label={`水平 ${main}，點一下修改`}>
          <b>{main}</b>
          {problem?.level === 'noop' ? <small>對照組</small> : sub ? <small>{sub}</small> : null}
          <span
            className="level-chip-x"
            role="button"
            aria-label={`刪掉 ${main}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <CloseOutlined />
          </span>
        </button>
      </Tooltip>
    </Popover>
  );
}

export function LevelsEditor({
  f,
  levels,
  problems,
  nm,
  onChange,
}: {
  f: Factor;
  levels: number[];
  problems: Problem[];
  nm: number;
  /** 改水平；換顯示模式時 factor 也一起換。 */
  onChange: (levels: number[], f?: Factor) => void;
}) {
  const fraction = isFraction(f);
  const unit = fraction ? '' : f.unit;
  const u = unit ? ` ${unit}` : '';
  const locked = lockedNominal(f);
  const presets = presetLevels(f, nm);
  const [gen, setGen] = useState<Gen>(() => genOf(levels.length ? levels : (presets[0]?.values ?? [])));
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const stepU = fraction ? 0.05 : f.unit === 'nm' ? Math.max(0.1, r6(nm)) : 1;
  const nomU = nominalLevel(f, nm);

  /** chip 的主字與小字：絕對時小字寫格數位移、相對時寫改完的絕對值。 */
  const show = (v: number): { main: string; sub: string } => {
    const d = deltaOf(f, v, nm);
    const main = `${formatLevel(f, v, f.mode === 'relative')}${u}`;
    if (fraction) return { main, sub: '' };
    const sub = f.mode === 'absolute' ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} 格` : `→ ${formatLevel(f, otherColumn(f, v, nm))}${u}`;
    return { main, sub };
  };
  const replace = (vs: number[]) => onChange(uniqSorted(vs));
  const applyGen = (g: Gen) => {
    setGen(g);
    replace(genValues(g));
  };
  const commitText = () => {
    const vs = parseLevels(text, f, nm);
    if (!vs) return void setBad(true);
    replace([...levels, ...vs]);
    setText('');
    setBad(false);
    setCustom(false);
  };
  const errors = [...new Set(problems.filter((p) => p.level === 'error').map((p) => p.msg))];
  const preview = genValues(gen);
  const sameAsGen = preview.length === levels.length && preview.every((v, i) => Math.abs(v - levels[i]) < 1e-6);
  const nowText = locked ? (fraction ? `現在 ${f.nominal.toFixed(2)}` : '從 0 起算') : `現在 ${formatLevel(f, fromVx(f, f.nominal, nm))}${u}`;

  return (
    <div className="levels-editor">
      <div className="le-head">
        <span className="le-title">要試的值</span>
        <span className="le-count">{levels.length ? `${levels.length} 個 → ${levels.length} 個 split` : '還沒有'}</span>
        {levels.length > 0 && (
          <button type="button" className="le-clear" onClick={() => replace([])}>
            清空
          </button>
        )}
        <span className="grow" />
        {!locked && !fraction && (
          <Tooltip
            title={
              <span>
                只是換寫法，實際改幾格不變。
                <br />
                絕對＝直接寫改完的值（例 18 nm）
                <br />
                相對＝寫和現在差多少（例 −2 nm）
              </span>
            }
          >
            <span className="le-mode-wrap">
              <Segmented
                size="small"
                className="le-mode"
                value={f.mode}
                onChange={() => {
                  const r = switchMode(f, levels, nm);
                  onChange(uniqSorted(r.levels), r.factor);
                  setGen(genOf(uniqSorted(r.levels)));
                }}
                options={[
                  { label: '絕對', value: 'absolute' },
                  { label: '相對', value: 'relative' },
                ]}
                aria-label="水平的寫法"
              />
              <InfoCircleOutlined className="le-mode-info" />
            </span>
          </Tooltip>
        )}
      </div>
      <div className="le-chips" role="list" aria-label="水平">
        {levels.length === 0 && <span className="le-empty">點下面的預設，或自己填起始／間距／個數</span>}
        {levels.map((v) => {
          const p = problems.find((x) => x.v === v);
          const { main, sub } = show(v);
          return (
            <Chip
              key={v}
              value={v}
              step={stepU}
              unit={unit}
              main={main}
              sub={sub}
              problem={p}
              onEdit={(nv) => replace(levels.map((x) => (x === v ? nv : x)))}
              onRemove={() => replace(levels.filter((x) => x !== v))}
            />
          );
        })}
        <Tooltip title="加一個值（也可以點任何一顆 chip 直接改）">
          <button type="button" className="level-chip add" aria-label="加一個水平" onClick={() => setCustom(!custom)}>
            <PlusOutlined />
          </button>
        </Tooltip>
      </div>
      {errors.length > 0 && (
        <Text type="danger" className="dp-hint le-error" role="alert">
          {errors.join('；')}
        </Text>
      )}
      {custom && (
        <div className="le-custom">
          <Input
            size="small"
            autoFocus
            value={text}
            status={bad ? 'error' : undefined}
            onChange={(e) => (setText(e.target.value), setBad(false))}
            onPressEnter={commitText}
            placeholder={f.mode === 'absolute' ? '例：16, 18, 20　或　±2 step 1　或　nominal ±10%' : '例：-1, 0, 1　或　-2..2 step 1'}
            aria-label="輸入水平清單"
          />
          <Button size="small" type="primary" onClick={commitText}>
            加入
          </Button>
          <Text type={bad ? 'danger' : 'secondary'} className="dp-hint">
            {bad ? '讀不懂：用逗號分開數字，或 ±2 step 1、-2..2 step 1、nominal ±10%' : `單位 ${unit || '0～1'}${f.mode === 'relative' ? '，寫和現在差多少' : ''}；Enter 加入`}
          </Text>
        </div>
      )}
      <div className="le-gen-title">
        快速產生<span>等距的一組值，會取代上面的</span>
      </div>
      <div className="le-gen">
        <InputNumber size="small" className="le-gen-n" prefix={<span className="le-pf">起始</span>} value={gen.start} step={stepU} onChange={(v) => v !== null && setGen({ ...gen, start: v })} suffix={unit || undefined} aria-label="起始值" />
        <InputNumber size="small" className="le-gen-n" prefix={<span className="le-pf">間距</span>} value={gen.step} step={stepU} onChange={(v) => v !== null && setGen({ ...gen, step: v })} suffix={unit || undefined} aria-label="間距" />
        <InputNumber size="small" className="le-gen-n short" prefix={<span className="le-pf">個數</span>} min={1} max={25} value={gen.n} onChange={(v) => v !== null && setGen({ ...gen, n: v })} aria-label="個數" />
        <Button size="small" type={sameAsGen ? 'default' : 'primary'} ghost={!sameAsGen} disabled={sameAsGen} onClick={() => applyGen(gen)}>
          {sameAsGen ? '已套用' : '套用'}
        </Button>
      </div>
      <div className="le-gen-preview">
        <Text type="secondary">
          → {preview.map((v) => formatLevel(f, v, f.mode === 'relative')).join('、')}
          {u} · {nowText}
        </Text>
      </div>
      <div className="le-presets">
        <span className="le-gen-label">預設</span>
        {presets.map((p) => (
          <Tooltip key={p.label} title={`${p.values.map((v) => formatLevel(f, v, f.mode === 'relative')).join('、')}${u}（填進上面三格並套用）`}>
            <Button size="small" onClick={() => applyGen(genOf(p.values))}>
              {p.label}
            </Button>
          </Tooltip>
        ))}
        {!locked && !fraction && (
          <Tooltip title={`只試現在的值（${formatLevel(f, nomU, f.mode === 'relative')}${u}），當對照組`}>
            <Button size="small" onClick={() => replace([...levels, nomU])}>
              + 對照組
            </Button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
