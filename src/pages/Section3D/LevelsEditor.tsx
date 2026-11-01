// 水平編輯器（plan v12 §5.4 第 2 點、§5.6）：chips（「18 nm（−2）」，可刪；有問題的紅、不改動的灰）＋
// 用使用者單位寫的預設按鈕（±0.5 nm、±1 nm、±10%、3 個等距…）＋「自訂…」才出現語法輸入框。
// 絕對／相對只是顯示切換（格數位移不變）；標稱量不到的操作不顯示絕對模式。
import { useState } from 'react';
import { Button, Flex, Input, InputNumber, Popover, Segmented, Tag, Tooltip, Typography } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { type Factor, type Problem, deltaOf, evenLevels, formatLevel, lockedNominal, otherColumn, parseLevels, presetLevels, switchMode } from '../../volume/factors';

const { Text } = Typography;

const uniqSorted = (vs: number[]) => [...new Set(vs.map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b);

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
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState('');
  const [bad, setBad] = useState(false);
  const [n, setN] = useState(3);
  const [step, setStep] = useState(f.unit === 'nm' ? 1 : 1);
  const fraction = f.op === 'defect' && f.param.startsWith('center');
  const u = fraction ? '' : ` ${f.unit}`;
  const locked = lockedNominal(f);
  const show = (v: number) => {
    const d = deltaOf(f, v, nm);
    const main = `${formatLevel(f, v, f.mode === 'relative')}${u}`;
    if (fraction) return main;
    // 括號：絕對時寫格數位移、相對時寫絕對值
    const other = f.mode === 'absolute' ? `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d)} 格` : `${formatLevel(f, otherColumn(f, v, nm))}${u}`;
    return `${main}（${other}）`;
  };
  const add = (vs: number[]) => onChange(uniqSorted([...levels, ...vs]));
  const commitText = () => {
    const vs = parseLevels(text, f, nm);
    if (!vs) {
      setBad(true);
      return;
    }
    add(vs);
    setText('');
    setBad(false);
  };
  const presets = presetLevels(f, nm);
  return (
    <Flex vertical gap={6} className="levels-editor">
      <Flex align="center" gap={6} wrap="wrap">
        {levels.length === 0 && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            還沒有水平：點下面的預設，或「自訂…」
          </Text>
        )}
        {levels.map((v) => {
          const p = problems.find((x) => x.v === v);
          return (
            <Tooltip key={v} title={p?.msg}>
              <Tag
                closable
                bordered={false}
                color={p?.level === 'error' ? 'error' : p?.level === 'noop' ? 'default' : 'blue'}
                className={'level-chip' + (p ? ` ${p.level}` : '')}
                onClose={(e) => {
                  e.preventDefault();
                  onChange(levels.filter((x) => x !== v));
                }}
              >
                {show(v)}
                {p?.level === 'noop' ? ' · 對照組' : ''}
              </Tag>
            </Tooltip>
          );
        })}
      </Flex>
      {problems.filter((p) => p.level === 'error').length > 0 && (
        <Text type="danger" style={{ fontSize: 12 }}>
          {[...new Set(problems.filter((p) => p.level === 'error').map((p) => p.msg))].join('；')}
        </Text>
      )}
      <Flex align="center" gap={4} wrap="wrap">
        {presets.map((p) => (
          <Button key={p.label} size="small" onClick={() => add(p.values)}>
            {p.label}
          </Button>
        ))}
        {!fraction && (
          <Popover
            trigger="click"
            title="等距的水平（標稱在中間）"
            content={
              <Flex vertical gap={8} style={{ width: 220 }}>
                <Flex align="center" gap={6}>
                  <span style={{ fontSize: 12, width: 40 }}>個數</span>
                  <InputNumber size="small" min={2} max={25} value={n} onChange={(v) => v && setN(v)} />
                </Flex>
                <Flex align="center" gap={6}>
                  <span style={{ fontSize: 12, width: 40 }}>間距</span>
                  <InputNumber size="small" min={0.001} step={f.unit === 'nm' ? 0.5 : 1} value={step} onChange={(v) => v && setStep(v)} suffix={f.unit} />
                </Flex>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {evenLevels(f, nm, n, step).map((v) => formatLevel(f, v, f.mode === 'relative')).join('、')}
                  {u}
                </Text>
                <Button size="small" type="primary" onClick={() => add(evenLevels(f, nm, n, step))}>
                  加入
                </Button>
              </Flex>
            }
          >
            <Button size="small">{n} 個等距…</Button>
          </Popover>
        )}
        <Button size="small" type={custom ? 'primary' : 'text'} ghost={custom} icon={<PlusOutlined />} onClick={() => setCustom(!custom)}>
          自訂…
        </Button>
        <span className="grow" />
        {!locked && !fraction && (
          <Tooltip title="只是換寫法：絕對＝寫新的值、相對＝寫和標稱差多少；實際改幾格不變">
            <Segmented
              size="small"
              value={f.mode}
              onChange={() => {
                const r = switchMode(f, levels, nm);
                onChange(uniqSorted(r.levels), r.factor);
              }}
              options={[
                { label: '絕對', value: 'absolute' },
                { label: '相對', value: 'relative' },
              ]}
            />
          </Tooltip>
        )}
      </Flex>
      {custom && (
        <Flex vertical gap={2}>
          <Input
            size="small"
            autoFocus
            value={text}
            status={bad ? 'error' : undefined}
            onChange={(e) => (setText(e.target.value), setBad(false))}
            onPressEnter={commitText}
            onBlur={() => text && commitText()}
            placeholder={f.mode === 'absolute' ? '例：16, 18, 20　或　±2 step 1　或　nominal ±10%' : '例：-1, 0, 1　或　-2..2 step 1'}
            aria-label="自訂水平"
          />
          <Text type={bad ? 'danger' : 'secondary'} style={{ fontSize: 11 }}>
            {bad ? '讀不懂：用逗號分開數字，或 ±2 step 1、-2..2 step 1、nominal ±10%' : `Enter 加入；單位 ${f.unit}${f.mode === 'relative' ? '（和標稱差多少）' : ''}`}
          </Text>
        </Flex>
      )}
    </Flex>
  );
}
