import { useState, type ReactNode } from 'react';
import { Alert, App, Flex, Input, Modal, Radio, Segmented, Tag, Typography } from 'antd';
import { type Axis, DIRECTIONS } from '../../volume/volume';
import type { Editor } from './editor';

const { Text } = Typography;

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="sweep-step">
      <div className="sweep-step-head">
        <span className="sweep-n">{n}</span>
        <b>{title}</b>
      </div>
      {children}
    </div>
  );
}

const PRESETS = ['1, 2, 3', '0.5, 1, 1.5, 2', '-1, 1', '2, 4, 6'];

/** 掃描產生：① 要變的結構 ② 做什麼 ③ 哪幾個數值 ④ 從哪裡開始。 */
export function SweepModal({
  ed,
  open,
  onClose,
  onMade,
}: {
  ed: Editor;
  open: boolean;
  onClose: () => void;
  onMade: (axis: Axis) => void;
}) {
  const { message } = App.useApp();
  const [kind, setKind] = useState<'push' | 'move'>('push');
  const [dirId, setDirId] = useState('up');
  const [unit, setUnit] = useState<'nm' | 'vx'>('nm');
  const [text, setText] = useState('1, 2, 3');
  const [extend, setExtend] = useState(false);
  const [prefix, setPrefix] = useState('');
  const values = text
    .split(/[,\s，、]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v) && v !== 0);
  const mats = new Set(ed.selComps.map((c) => c.mat));
  const who =
    ed.selComps.length === 1
      ? ed.selComps[0].label
      : mats.size === 1 && ed.selComps.length
        ? `${ed.matName([...mats][0])} ×${ed.selComps.length}`
        : `${ed.selComps.length} 個結構`;
  const dir = DIRECTIONS.find((d) => d.id === dirId)!;
  const verb = kind === 'move' ? `${dir.name}移` : `${dir.name}長`;
  const nameOf = (v: number) => `${prefix || who} ${verb} ${v > 0 ? '+' : ''}${v}${unit}`;
  const toVx = (v: number) => Math.round(unit === 'nm' ? v / ed.nmPerVoxel : v);
  const whole = ed.scopeMode === 'whole';

  const ok = () => {
    if (!values.length) {
      message.warning('請填數值，用逗號分開');
      return;
    }
    if (values.some((v) => toVx(v) === 0)) {
      message.warning(`有數值小於半個 voxel（${ed.nmPerVoxel / 2} nm），會變成 0`);
      return;
    }
    const sign = kind === 'move' ? dir.d[0] + dir.d[1] + dir.d[2] : 1;
    ed.addSweep(
      kind === 'move' ? { kind: 'translate', axis: ({ x: 0, y: 1, z: 2 } as const)[dir.axis] } : { kind: 'push', dir: dir.d },
      values.map((v) => v * sign),
      unit,
      (v) => nameOf(v * sign),
      extend,
    );
    onMade(dir.axis);
    onClose();
  };

  return (
    <Modal
      title="一次產生多個 split"
      open={open}
      onCancel={onClose}
      onOk={ok}
      okText={values.length ? `產生 ${values.length} 個 split` : '產生 split'}
      okButtonProps={{ disabled: !values.length || !ed.sel.size }}
      width={560}
    >
      <Flex vertical gap={18} style={{ paddingTop: 8 }}>
        <Step n={1} title="要變的結構">
          {ed.sel.size ? (
            <Flex align="center" gap={8} wrap="wrap">
              <Tag color="blue" bordered={false} style={{ fontSize: 13, padding: '2px 10px' }}>
                {who}
              </Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {whole ? '整塊' : `只改 ${ed.scope.axis} ${ed.scope.lo}～${ed.scope.hi}`}。要換，關掉視窗後在 3D 或左邊清單重選（Shift 多選）。
              </Text>
            </Flex>
          ) : (
            <Alert type="warning" showIcon message="還沒選結構：關掉視窗，在 3D 或左邊清單點一塊（Shift 可多選），再回來" />
          )}
        </Step>
        <Step n={2} title="做什麼">
          <Flex vertical gap={10}>
            <Segmented
              block
              value={kind}
              onChange={(v) => setKind(v as 'push' | 'move')}
              options={[
                { label: '長高／縮短（只推一面）', value: 'push' },
                { label: '整塊移動', value: 'move' },
              ]}
            />
            <Radio.Group value={dirId} onChange={(e) => setDirId(e.target.value)} className="dir-grid">
              {DIRECTIONS.map((d) => (
                <Radio.Button value={d.id} key={d.id} className="dir-btn">
                  <span className="dir-arrow">{d.arrow}</span>
                  <span>{d.name}</span>
                  <small>{d.hint}</small>
                </Radio.Button>
              ))}
            </Radio.Group>
          </Flex>
        </Step>
        <Step n={3} title="哪幾個數值（每個數值一個 split）">
          <Flex gap={10}>
            <label className="field" style={{ flex: 2 }}>
              <span>數值，用逗號分開（負值＝{kind === 'move' ? '反方向' : '縮短'}）</span>
              <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="例如 1, 2, 3" />
            </label>
            <label className="field">
              <span>單位</span>
              <Segmented
                block
                value={unit}
                onChange={(v) => setUnit(v as 'nm' | 'vx')}
                options={[
                  { label: 'nm', value: 'nm' },
                  { label: 'voxel', value: 'vx' },
                ]}
              />
            </label>
          </Flex>
          <Flex gap={6} wrap="wrap" align="center" style={{ marginTop: 6 }}>
            {PRESETS.map((p) => (
              <Tag key={p} style={{ cursor: 'pointer' }} onClick={() => setText(p)}>
                {p}
              </Tag>
            ))}
            {unit === 'nm' && values.length > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                → {values.map((v) => `${toVx(v)} vx`).join(' / ')}（1 vx = {ed.nmPerVoxel} nm）
              </Text>
            )}
          </Flex>
        </Step>
        <Step n={4} title="從哪裡開始">
          <Segmented
            block
            value={extend ? 'ext' : 'base'}
            onChange={(v) => setExtend(v === 'ext')}
            options={[
              { label: '從原始模型', value: 'base' },
              {
                label: `接在目前 split 之後${ed.active?.ops.length ? `（${ed.active.name}）` : ''}`,
                value: 'ext',
                disabled: !ed.active || !ed.active.ops.length,
              },
            ]}
          />
        </Step>
        <Flex vertical gap={6}>
          <Flex align="center" gap={8}>
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              會產生：
            </Text>
            {values.length > 0 && ed.sel.size > 0 ? (
              <div className="sweep-preview">
                {values.map((v) => (
                  <Tag bordered={false} color="blue" key={v}>
                    {nameOf(v)}
                  </Tag>
                ))}
              </div>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                —
              </Text>
            )}
          </Flex>
          <Input size="small" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder={`名稱前綴（留白用「${who}」）`} style={{ maxWidth: 320 }} />
        </Flex>
      </Flex>
    </Modal>
  );
}
