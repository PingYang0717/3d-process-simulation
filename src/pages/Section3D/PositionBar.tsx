import { useMemo } from 'react';
import { Button, Flex, InputNumber, Segmented, Slider, Space, Tooltip, Typography } from 'antd';
import { LeftOutlined, RightOutlined } from '@ant-design/icons';
import type { Axis, Vec3 } from '../../volume/volume';
import { AXES, type Scope, axisIndex, axisLen, boxRange } from '../../volume/scope';
import type { Editor, ScopeMode } from './editor';
import { memoEd } from '../../ui/memoEd';

const { Text } = Typography;

export const AXIS_TAB: Record<Axis, string> = { z: 'XY 正面', y: 'XZ 上視', x: 'YZ 側面' };

/** 範圍詞：按鈕文字、訊息共用。 */
export function scopeWords(ed: Editor) {
  const a = ed.editAxis;
  if (ed.scopeMode === 'slice') return { short: '此片', long: `此片（${a} = ${ed.scope.lo}）` };
  if (ed.scopeMode === 'custom') return { short: `${a} ${ed.scope.lo}～${ed.scope.hi}`, long: `${a} ${ed.scope.lo}～${ed.scope.hi}` };
  const r = ed.selRange;
  return { short: '整根', long: r ? `整個結構（${a} ${r[0]}～${r[1]}）` : '整個結構' };
}

/**
 * 實際要送出的範圍的字（plan v14 §5.2：顯示層不再自己推算，卡片下方印的就是 op.scope）。
 * 和編輯器的範圍相同＝scopeWords；否則依數字說「此片」「整個結構」或「x 0～287」。
 */
export function scopeWordsOf(ed: Editor, scope?: Scope | null) {
  const s = ed.scope;
  if (!scope || (scope.axis === s.axis && scope.lo === s.lo && scope.hi === s.hi)) return scopeWords(ed);
  const a = scope.axis;
  if (scope.lo === scope.hi) return { short: '此片', long: `此片（${a} = ${scope.lo}）` };
  const r = ed.selBox ? boxRange(ed.selBox, a) : null;
  if (r && r[0] === scope.lo && r[1] === scope.hi) return { short: '整根', long: `整個結構（${a} ${scope.lo}～${scope.hi}）` };
  return { short: `${a} ${scope.lo}～${scope.hi}`, long: `${a} ${scope.lo}～${scope.hi}` };
}

/**
 * 同一片上其他結構沿 axis 的起止（自訂範圍滑桿上的淡灰刻度，例如 fin 上的三個閘極）：
 * 和選取在另外兩軸重疊、沿 axis 不是整段的結構。
 */
function useTicks(ed: Editor, axis: Axis) {
  return useMemo(() => {
    const b = ed.selBox;
    if (!b) return [];
    const a = axisIndex(axis);
    const len = axisLen(ed.vol, axis);
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    const out: { at: number; name: string }[] = [];
    for (const c of ed.comps) {
      if (ed.sel.has(c.key) || ed.hidden.has(c.mat)) continue;
      const cl = [c.bbox.x0, c.bbox.y0, c.bbox.z0];
      const ch = [c.bbox.x1, c.bbox.y1, c.bbox.z1];
      let overlap = true;
      for (let k = 0; k < 3; k++) if (k !== a && (ch[k] < lo[k] || cl[k] > hi[k])) overlap = false;
      if (!overlap || (cl[a] <= 0 && ch[a] >= len - 1)) continue;
      out.push({ at: cl[a], name: `${c.label} ${axis} ${cl[a]}～${ch[a]}` }, { at: ch[a], name: `${c.label} ${axis} ${cl[a]}～${ch[a]}` });
    }
    return out.slice(0, 40);
  }, [ed.selBox, ed.comps, ed.sel, ed.hidden, ed.vol, axis]);
}

/** 範圍控制：整個結構／此片／自訂（雙把手滑桿）。只在卡片下方「套用到：… ▾」點開（plan v10 §4.7）；位置列只顯示。 */
export function ScopeControl({ ed, compact = false, showAxis = false }: { ed: Editor; compact?: boolean; showAxis?: boolean }) {
  const axis = ed.editAxis;
  const max = axisLen(ed.vol, axis) - 1;
  const r = ed.selRange;
  const ticks = useTicks(ed, axis);
  const at = ed.cursor[axisIndex(axis)];
  const marks: Record<number, { label: React.ReactNode; style?: React.CSSProperties }> = {};
  ticks.forEach((t) => {
    marks[t.at] = {
      label: (
        <Tooltip title={t.name}>
          <span className="tick-gray" />
        </Tooltip>
      ),
    };
  });
  if (r) {
    marks[r[0]] = { label: <small className="tick-sel">{r[0]}</small> };
    marks[r[1]] = { label: <small className="tick-sel">{r[1]}</small> };
  }
  const n = ed.scope.hi - ed.scope.lo + 1;
  const custom = ed.scopeMode === 'custom';
  return (
    <Flex vertical={!compact} gap={compact ? 8 : 6} align={compact ? 'center' : undefined} className={compact ? 'scope-ctl compact' : 'scope-ctl'}>
      {showAxis && (
        <Flex align="center" gap={8}>
          <span style={{ fontSize: 12 }}>沿哪一軸</span>
          <Segmented
            size="small"
            value={axis}
            onChange={(v) => ed.setEditAxis(v as Axis)}
            options={AXES.map((a) => ({ label: a.toUpperCase(), value: a }))}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {AXIS_TAB[axis]}的法線
          </Text>
        </Flex>
      )}
      {compact && <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>套用到：</span>}
      <Segmented
        size="small"
        block={!compact}
        value={ed.scopeMode}
        onChange={(v) => {
          const m = v as ScopeMode;
          // 第一次切到自訂：從結構中間三分之一開始，比較看得出來是一段
          if (m === 'custom' && r && ed.customRange[0] <= r[0] && ed.customRange[1] >= r[1])
            ed.setCustom(Math.round((r[0] * 2 + r[1]) / 3), Math.round((r[0] + r[1] * 2) / 3));
          ed.setScopeMode(m);
        }}
        options={[
          { label: compact && r ? `整個結構 (${axis} ${r[0]}～${r[1]})` : '整個結構', value: 'whole' },
          { label: compact ? `此片 (${axis} = ${at})` : '此片', value: 'slice' },
          { label: '自訂', value: 'custom' },
        ]}
      />
      {custom && (
        <Flex align="center" gap={8} style={compact ? { minWidth: 260, flex: 1 } : undefined} wrap={!compact}>
          <Slider
            range
            min={0}
            max={max}
            value={[ed.scope.lo, ed.scope.hi]}
            onChange={(v) => ed.setCustom(v[0], v[1])}
            tooltip={{ formatter: (v) => `${axis} = ${v}` }}
            marks={marks}
            style={{ flex: 1, minWidth: 140, margin: compact ? '0 6px' : '4px 8px 18px' }}
          />
          {!compact && (
            <Flex align="center" gap={6}>
              <span style={{ fontSize: 12 }}>{axis} 從</span>
              <InputNumber size="small" min={0} max={max} value={ed.scope.lo} onChange={(v) => v !== null && ed.setCustom(v, ed.scope.hi)} precision={0} style={{ width: 64 }} />
              <span style={{ fontSize: 12 }}>到</span>
              <InputNumber size="small" min={0} max={max} value={ed.scope.hi} onChange={(v) => v !== null && ed.setCustom(ed.scope.lo, v)} precision={0} style={{ width: 64 }} />
            </Flex>
          )}
        </Flex>
      )}
      {(custom || !compact) && (
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: compact ? 'nowrap' : undefined }}>
          {ed.scopeMode === 'whole'
            ? compact
              ? ''
              : `整根一起改${r ? `（${axis} ${r[0]}～${r[1]}）` : ''}；3D 上藍色的部分就是會被改到的範圍`
            : `${axis} ${ed.scope.lo}～${ed.scope.hi} · ${n} 片 · ${(n * ed.nmPerVoxel).toFixed(1)} nm`}
        </Text>
      )}
    </Flex>
  );
}

/** 第幾片：◀ ▶、輸入框、nm。 */
export function SliceNav({ ed, axis }: { ed: Editor; axis: Axis }) {
  const at = ed.cursor[axisIndex(axis)];
  const max = axisLen(ed.vol, axis) - 1;
  const set = (v: number) => {
    const next: Vec3 = [...ed.cursor];
    next[axisIndex(axis)] = Math.max(0, Math.min(max, Math.round(v)));
    ed.setCursor(next);
  };
  return (
    <Flex align="center" gap={6} style={{ whiteSpace: 'nowrap' }}>
      <Space.Compact size="small">
        <Button icon={<LeftOutlined />} onClick={() => ed.stepCursor(axis, -1)} aria-label="上一片" />
        <InputNumber
          size="small"
          min={0}
          max={max}
          value={at}
          onChange={(v) => v !== null && set(v)}
          precision={0}
          prefix={<span style={{ color: 'var(--c-text-3)' }}>{axis} =</span>}
          style={{ width: 92 }}
        />
        <Button icon={<RightOutlined />} onClick={() => ed.stepCursor(axis, 1)} aria-label="下一片" />
      </Space.Compact>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {(at * ed.nmPerVoxel).toFixed(1)} nm
      </Text>
    </Flex>
  );
}

/** 最近有選取結構的一片（沒有選取或整根都沒有回傳 null）。 */
export function nearestSlice(has: Uint8Array | null, at: number) {
  if (!has) return null;
  if (has[at]) return at;
  for (let d = 1; d < has.length; d++) {
    if (at - d >= 0 && has[at - d]) return at - d;
    if (at + d < has.length && has[at + d]) return at + d;
  }
  return null;
}

/**
 * 位置列（編輯狀態的主切面上方）：第幾片 │ 套用到哪裡 │ 提示（這一片沒有選取、不在範圍內）。
 * has = 選取沿 axis 每一片有沒有體素。
 */
function PositionBarImpl({ ed, axis, has, onJumpBlocked }: { ed: Editor; axis: Axis; has: Uint8Array | null; onJumpBlocked?: () => void }) {
  const at = ed.cursor[axisIndex(axis)];
  const sel = ed.selComps;
  const name = sel.length === 1 ? sel[0].label : sel.length ? `已選的 ${sel.length} 個結構` : '';
  const near = sel.length ? nearestSlice(has, at) : null;
  const jump = (t: number) => {
    const next: Vec3 = [...ed.cursor];
    next[axisIndex(axis)] = t;
    ed.setCursor(next);
  };
  const outOfScope = sel.length > 0 && (at < ed.scope.lo || at > ed.scope.hi);
  return (
    <div className="position-bar">
      <SliceNav ed={ed} axis={axis} />
      <span className="pb-sep" />
      {sel.length ? (
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          套用到：{scopeWords(ed).long}（在卡片下方改）
        </Text>
      ) : (
        <Text type="secondary" style={{ fontSize: 12 }}>
          點一塊結構選取
        </Text>
      )}
      {sel.length > 0 && near !== null && near !== at && (
        <Text type="warning" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          這一片沒有 {name} ·{' '}
          <Typography.Link onClick={() => jump(near)}>
            跳到最近的一片（{axis} = {near}）
          </Typography.Link>
        </Text>
      )}
      {!!ed.report?.slices.length && ed.report.axis === axis && (
        <Text type="danger" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          上一步 {ed.report.slices.length} 片有格子被擋住
          {ed.report.slices.some((s) => s.at === at) ? '（這一片有，標紅）' : ''} · <Typography.Link onClick={onJumpBlocked}>下一片</Typography.Link>
        </Text>
      )}
      {ed.queued > 0 && (
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          排隊 {ed.queued} 步
        </Text>
      )}
      {outOfScope && (near === null || near === at) && (
        <Text type="warning" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          這一片不在範圍內（{axis} {ed.scope.lo}～{ed.scope.hi}），改動會套用到範圍，不會套到這一片
        </Text>
      )}
    </div>
  );
}

/** 自動選切面方向：選取最長的那一軸當法線（fin 沿 z → XY 正面；poly 沿 x → YZ 側面）。 */
export function longestAxis(ed: Pick<Editor, 'selComps'>): Axis | null {
  const b = ed.selComps[0]?.bbox;
  if (!b) return null;
  const len = AXES.map((a) => {
    const [l, h] = boxRange(b, a);
    return h - l + 1;
  });
  // 一樣長時優先 z（XY 正面最常用）
  const order: (0 | 1 | 2)[] = [2, 0, 1];
  let best = order[0];
  for (const k of order) if (len[k] > len[best]) best = k;
  return AXES[best];
}

export const PositionBar = memoEd(PositionBarImpl, ['comps', 'cursor', 'customRange', 'editAxis', 'hidden', 'nmPerVoxel', 'queued', 'report', 'scope', 'scopeMode', 'sel', 'selBox', 'selComps', 'selRange', 'vol'], 'PositionBar');
