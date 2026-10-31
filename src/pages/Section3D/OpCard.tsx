// 數值操作的卡片（plan v10 §4.4）：每一張都是「參數 → 一句話 → 套用」。
// 參數一變（150 ms）就用既有的拖拉預覽管線畫出結果（3D 即時網格、主切面淡綠／淡紅），按「套用」（Enter）才 commit；
// 點別處、Esc、收合 → 預覽收掉。右欄與 3D／2D 工具列的 Popover 是同一個元件（compact）。
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Flex, InputNumber, Popover, Segmented, Select, Slider, Tooltip, Typography } from 'antd';
import { BorderOuterOutlined, DownOutlined, DragOutlined, MinusOutlined, PlusOutlined, RadiusSettingOutlined } from '@ant-design/icons';
import { type Axis, type Vec3, VOID } from '../../volume/volume';
import type { Op } from '../../volume/ops';
import { uvTo3D } from '../../volume/scope';
import { MatLabel } from '../../ui/Swatch';
import type { Editor } from './editor';
import { ScopeControl, scopeWords } from './PositionBar';
import { FacePicker } from './FacePicker';
import { type WordsCtx, describeOp, faceName } from './opWords';
import { RoundCard } from './RoundCard';
import type { RoundGesture } from '../../slice/round';

const { Text } = Typography;

/** 卡片要的畫面功能：index.tsx 提供（預覽管線、3D 亮面、換材質的即時變色）。 */
export interface CardHost {
  /** 預覽這一步（null＝收掉）；回傳 false＝範圍太大沒畫。 */
  preview: (op: Op | null) => boolean;
  /** 六面小方塊滑過：3D 選取外框那一面亮起（null＝收掉）。 */
  highlight: (dir: Vec3 | null) => void;
  /** 換材質：先在 GPU 上變色再送 Worker。 */
  onMaterial: (id: number) => void;
}
export const CardHostCtx = createContext<CardHost>({ preview: () => false, highlight: () => {}, onMaterial: () => {} });

/** 切面上的四個方向（2D 剖面裡的卡片只開放這些）。 */
export const inPlane = (axis: Axis): Vec3[] => [uvTo3D(axis, 0, -1), uvTo3D(axis, 0, 1), uvTo3D(axis, -1, 0), uvTo3D(axis, 1, 0)];
const sameDir = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** 預設方向：上（−y）；在切面上沒有上就用切面上的第一個。 */
const defaultDir = (plane?: Axis): Vec3 => {
  const up: Vec3 = [0, -1, 0];
  if (!plane) return up;
  const ds = inPlane(plane);
  return ds.find((d) => sameDir(d, up)) ?? ds[0];
};

export const wordsOf = (ed: Editor): WordsCtx => ({ L: ed.L, nm: ed.nmPerVoxel, matName: ed.matName, scope: scopeWords(ed).short });

/** 範圍：卡片下方一行「套用到：整根 ▾」，點開是完整的範圍控制。 */
export function ScopeLine({ ed }: { ed: Editor }) {
  return (
    <Popover trigger="click" placement="bottomLeft" content={<div style={{ width: 320 }}><ScopeControl ed={ed} showAxis /></div>}>
      <Button type="link" size="small" className="scope-line">
        套用到：{scopeWords(ed).long} <DownOutlined style={{ fontSize: 10 }} />
      </Button>
    </Popover>
  );
}

/**
 * 卡片的預覽狀態：按到卡片（或改參數）就 active，op 一變 150 ms 後預覽；點別處、Esc、套用、卸載 → 收掉。
 * previewable＝false（換材質）只有一句話，不畫預覽。
 */
function useCardPreview(op: Op | null, previewable = true) {
  const host = useContext(CardHostCtx);
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [big, setBig] = useState(false);
  const was = useRef(false);
  useEffect(() => {
    if (!active) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t as Node)) return;
      // 卡片裡的下拉、popover 是 portal，不算點別處
      if (t?.closest?.('.ant-select-dropdown,.ant-popover,.ant-dropdown,.ant-tooltip,.ant-slider')) return;
      setActive(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 先收預覽，不清選取
      e.stopImmediatePropagation();
      setActive(false);
    };
    window.addEventListener('pointerdown', away, { capture: true });
    window.addEventListener('keydown', esc, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', away, { capture: true });
      window.removeEventListener('keydown', esc, { capture: true });
    };
  }, [active]);
  useEffect(() => {
    if (!active || !op || !previewable) return;
    const t = setTimeout(() => {
      was.current = true;
      setBig(!host.preview(op));
    }, 150);
    return () => clearTimeout(t);
  }, [active, op, previewable, host]);
  useEffect(() => {
    if (active || !was.current) return;
    was.current = false;
    host.preview(null);
    setBig(false);
  }, [active, host]);
  // 卸載（Popover 收合、換選取）：預覽收掉
  useEffect(
    () => () => {
      if (was.current) host.preview(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  return { ref, active, activate: () => setActive(true), deactivate: () => setActive(false), big: big && active };
}

/** 卡片外殼：一句話 → 參數 → 套用到／套用。 */
export function CardShell({
  ed,
  op,
  words,
  previewable = true,
  compact,
  extra,
  children,
  onApply,
  applyText = '套用',
  note,
}: {
  ed: Editor;
  op: Op | null;
  words: string;
  previewable?: boolean;
  compact?: boolean;
  extra?: ReactNode;
  children: ReactNode;
  /** 自己套用（換材質要先變色）；省略＝ed.commit(op)。 */
  onApply?: (op: Op) => void;
  applyText?: string;
  note?: ReactNode;
}) {
  const pv = useCardPreview(op, previewable);
  const busy = !!ed.busy && ed.queued >= 3;
  const apply = () => {
    if (!op || busy) return;
    pv.deactivate();
    if (onApply) onApply(op);
    else ed.commit(op);
  };
  return (
    <div
      ref={pv.ref}
      className={'op-card' + (compact ? ' compact' : '') + (pv.active ? ' active' : '')}
      onPointerDownCapture={pv.activate}
      onFocusCapture={pv.activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !(e.target as Element).closest('.ant-select')) {
          e.preventDefault();
          apply();
        }
      }}
    >
      <Flex align="start" gap={8}>
        <Text className="op-card-words" style={{ flex: 1 }}>
          {op || words ? words || '先調參數' : '先調參數'}
        </Text>
        {extra}
      </Flex>
      {children}
      {pv.big && (
        <Text type="warning" style={{ fontSize: 12 }}>
          範圍太大，不先畫，套用後 Worker 幾秒內顯示
        </Text>
      )}
      {note}
      <Flex align="center" gap={8} wrap>
        <ScopeLine ed={ed} />
        <span style={{ flex: 1 }} />
        <Tooltip title="Enter">
          <Button type="primary" size={compact ? 'small' : 'middle'} disabled={!op || busy} loading={!!ed.busy && !busy} onClick={apply}>
            {applyText}
          </Button>
        </Tooltip>
      </Flex>
    </div>
  );
}

/** 格數：滑桿＋輸入＋±＋nm。 */
function Steps({ ed, value, onChange, min = -32, max = 32, label = '格數' }: { ed: Editor; value: number; onChange: (v: number) => void; min?: number; max?: number; label?: string }) {
  return (
    <Flex vertical gap={4}>
      <Flex align="center" gap={6}>
        <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{label}</span>
        <Slider min={min} max={max} value={value} onChange={onChange} style={{ flex: 1, minWidth: 60, margin: '0 6px' }} />
      </Flex>
      <Flex align="center" gap={4}>
        <Button size="small" icon={<MinusOutlined />} aria-label="少一格" onClick={() => onChange(value - 1)} />
        <InputNumber size="small" value={value} onChange={(v) => v !== null && onChange(Math.round(v))} precision={0} suffix="vx" style={{ width: 76 }} aria-label={label} />
        <Button size="small" icon={<PlusOutlined />} aria-label="多一格" onClick={() => onChange(value + 1)} />
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap', marginLeft: 4 }}>
          {(Math.abs(value) * ed.nmPerVoxel).toFixed(1)} nm
        </Text>
      </Flex>
    </Flex>
  );
}

/** 長／縮：選一面、沿法線幾格（負＝縮）。 */
export function PushCard({ ed, compact, plane, initialDir }: { ed: Editor; compact?: boolean; plane?: Axis; initialDir?: Vec3 }) {
  const host = useContext(CardHostCtx);
  const [dir, setDir] = useState<Vec3>(() => initialDir ?? defaultDir(plane));
  const [n, setN] = useState(1);
  const op = useMemo(() => ed.pushOp(dir, n), [ed.pushOp, dir, n]);
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} compact={compact}>
      <Flex align="center" gap={12}>
        <FacePicker value={dir} onChange={setDir} onHover={host.highlight} allowed={plane ? inPlane(plane) : undefined} size={compact ? 80 : 96} />
        <Flex vertical gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Text style={{ fontSize: 12 }}>
            {faceName(dir)}沿法線{n >= 0 ? '往外長' : '往內縮'}；整面一起，只推最外側的表面。
          </Text>
          <Steps ed={ed} value={n} onChange={setN} />
        </Flex>
      </Flex>
    </CardShell>
  );
}

/** 方頭：選一面，每一排補到那一面最外側那一點（圓頭、斜角變方頭）。 */
function LevelPart({ ed, compact, plane }: { ed: Editor; compact?: boolean; plane?: Axis }) {
  const host = useContext(CardHostCtx);
  const [dir, setDir] = useState<Vec3>(() => defaultDir(plane));
  const op = useMemo(() => ed.levelOp(dir), [ed.levelOp, dir]);
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} compact={compact} applyText="套用方頭">
      <Flex align="center" gap={12}>
        <FacePicker value={dir} onChange={setDir} onHover={host.highlight} allowed={plane ? inPlane(plane) : undefined} size={compact ? 80 : 96} />
        <Text type="secondary" style={{ fontSize: 12, flex: 1 }}>
          {faceName(dir)}每一排補到最外側那一點。只填空氣；薄襯層{ed.follow ? '跟著往外走' : '會擋住（設定裡開「襯層一起推」才跟著走）'}，厚的鄰居不吃。
        </Text>
      </Flex>
    </CardShell>
  );
}

/**
 * 方頭／圓頭：同一個地方決定頭型（plan v10 §4.6）。右上角切換；initial＝從角把手／右鍵帶進來的圓頭參數。
 */
export function ShapeCard({ ed, compact, plane, start = 'round', initial }: { ed: Editor; compact?: boolean; plane?: Axis; start?: 'round' | 'level'; initial?: Partial<RoundGesture> }) {
  const [kind, setKind] = useState<'round' | 'level'>(start);
  return (
    <Flex vertical gap={8}>
      <Segmented
        size="small"
        value={kind}
        onChange={(v) => setKind(v as 'round' | 'level')}
        options={[
          { label: '圓頭', value: 'round' },
          { label: '方頭', value: 'level' },
        ]}
        style={{ alignSelf: 'flex-end' }}
      />
      {kind === 'round' ? <RoundCard ed={ed} compact={compact} plane={plane} initial={initial} /> : <LevelPart ed={ed} compact={compact} plane={plane} />}
    </Flex>
  );
}

/** 移動：選方向、幾格；方向鍵也可以（1 格、Shift 10 格、PgUp／PgDn 前後）。 */
export function MoveCard({ ed, compact, plane }: { ed: Editor; compact?: boolean; plane?: Axis }) {
  const host = useContext(CardHostCtx);
  const [dir, setDir] = useState<Vec3>(() => defaultDir(plane));
  const [n, setN] = useState(1);
  const [shell, setShell] = useState(ed.follow);
  const d: Vec3 = [dir[0] * n, dir[1] * n, dir[2] * n];
  const op = useMemo(() => ed.translateOp(d, shell), [ed.translateOp, d[0], d[1], d[2], shell]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <CardShell
      ed={ed}
      op={op}
      words={op ? describeOp(wordsOf(ed), op) : ''}
      compact={compact}
      note={
        <Text type="secondary" style={{ fontSize: 12 }}>
          也可以用方向鍵：1 格、<kbd>Shift</kbd> 10 格，<kbd>PgUp</kbd>／<kbd>PgDn</kbd> 走前後（直接套用）。
        </Text>
      }
    >
      <Flex align="center" gap={12}>
        <FacePicker value={dir} onChange={setDir} onHover={host.highlight} allowed={plane ? inPlane(plane) : undefined} size={compact ? 80 : 96} />
        <Flex vertical gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Steps ed={ed} value={n} onChange={setN} min={0} max={32} label="幾格" />
          <Checkbox checked={shell} onChange={(e) => setShell(e.target.checked)}>
            外面的薄襯層一起搬
          </Checkbox>
        </Flex>
      </Flex>
    </CardShell>
  );
}

/** 材質：換成哪一種（VOID 在最後一項）。換材質不先畫預覽，套用時 3D 先在 GPU 上變色。 */
export function MaterialCard({ ed, compact }: { ed: Editor; compact?: boolean }) {
  const host = useContext(CardHostCtx);
  const mats = new Set(ed.selComps.map((c) => c.mat));
  const [m, setM] = useState<number | null>(null);
  const op = useMemo(() => (m === null || (mats.size === 1 && mats.has(m)) ? null : ed.materialOp(m)), [ed.materialOp, m, mats.size === 1 && [...mats][0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const opts = ed.materials.filter((x) => x.id !== 0 && x.id !== VOID).map((x) => ({ value: x.id, label: <MatLabel mat={x} /> }));
  const v = ed.materials.find((x) => x.id === VOID);
  if (v) opts.push({ value: VOID, label: <MatLabel mat={{ ...v, name: `${v.name}（設為空洞）` }} /> });
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} previewable={false} compact={compact} onApply={(o) => o.kind === 'material' && host.onMaterial(o.m)} applyText="換材質">
      <Select style={{ width: '100%' }} value={m ?? (mats.size === 1 ? [...mats][0] : undefined)} placeholder="換成…" onChange={setM} options={opts} />
    </CardShell>
  );
}

/**
 * 五顆操作按鈕（plan v10 §4.7）：長／縮 · 方頭／圓頭 · 移動 · 材質 · 對應（多選）；每顆開對應卡片的 Popover。
 * 3D 的編輯工具列與 2D 浮動列共用（plane＝2D 剖面的法線軸，卡片只開放切面上的方向）。
 */
export function OpButtons({ ed, plane }: { ed: Editor; plane?: Axis }) {
  const busy = !!ed.busy && ed.queued >= 3;
  const pop = (content: ReactNode) => <div style={{ width: 380 }}>{content}</div>;
  return (
    <>
      <Popover trigger="click" placement="bottom" destroyOnHidden content={pop(<PushCard ed={ed} compact plane={plane} />)}>
        <Button size="small" icon={<BorderOuterOutlined />} disabled={busy}>
          長／縮
        </Button>
      </Popover>
      <Popover trigger="click" placement="bottom" destroyOnHidden content={pop(<ShapeCard ed={ed} compact plane={plane} />)}>
        <Button size="small" icon={<RadiusSettingOutlined />} disabled={busy}>
          方頭／圓頭
        </Button>
      </Popover>
      <Popover trigger="click" placement="bottom" destroyOnHidden content={pop(<MoveCard ed={ed} compact plane={plane} />)}>
        <Button size="small" icon={<DragOutlined />} disabled={busy}>
          移動
        </Button>
      </Popover>
      <Popover trigger="click" placement="bottom" destroyOnHidden content={pop(<MaterialCard ed={ed} compact />)}>
        <Button size="small" disabled={busy}>
          材質 <DownOutlined style={{ fontSize: 10 }} />
        </Button>
      </Popover>
      {ed.sel.size > 1 && (
        <Tooltip title="多選時，在一個結構上的手勢也做在長得一樣的結構上（同材質、長寬比與面積相近）">
          <Button size="small" type={ed.mirror ? 'primary' : 'default'} onClick={() => ed.setMirror(!ed.mirror)}>
            對應 {ed.mirror ? '●' : '○'}
          </Button>
        </Tooltip>
      )}
    </>
  );
}
