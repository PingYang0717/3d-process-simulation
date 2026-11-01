// 數值操作的卡片（plan v10 §4.4）：每一張都是「參數 → 一句話 → 套用」。
// 參數一變（50 ms）就用既有的拖拉預覽管線畫出結果（3D 即時網格、主切面淡綠／淡紅），按「套用」（Enter）才 commit；
// 點別處、Esc、收合 → 預覽收掉。右欄與 3D／2D 工具列的 Popover 是同一個元件（compact）。
import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Flex, InputNumber, Popover, Segmented, Select, Slider, Tooltip, Typography } from 'antd';
import { BorderOuterOutlined, DownOutlined, DragOutlined, MinusOutlined, PlusOutlined, RadiusSettingOutlined } from '@ant-design/icons';
import { type Axis, type Material, type Vec3, VOID, kindOf, thicknessOf } from '../../volume/volume';
import type { Op, Policy } from '../../volume/ops';
import { levelRefTo } from '../../volume/ops';
import { type Scope, uvTo3D } from '../../volume/scope';
import { MatLabel } from '../../ui/Swatch';
import type { Editor } from './editor';
import { ScopeControl, scopeWords, scopeWordsOf } from './PositionBar';
import { FacePicker } from './FacePicker';
import { type WordsCtx, describeOp, faceName } from './opWords';
import { RoundCard } from './RoundCard';
import type { RoundGesture } from '../../slice/round';
import type { EdKey } from '../../ui/memoEd';

const { Text } = Typography;

/**
 * 參數變了多久之後預覽（plan v10 §4.4 原訂 150 ms）。Worker 一次只算一個拖拉預覽、永遠送最新的，
 * 連續改不會堆積，所以縮短到 50 ms，讓「改數值 → 畫面出現」更接近 200 ms 的目標。
 */
const PREVIEW_DEBOUNCE_MS = 50;

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

export const wordsOf = (ed: Editor, scope?: Scope | null): WordsCtx => ({ L: ed.L, nm: ed.nmPerVoxel, matName: ed.matName, scope: (scope ? scopeWordsOf(ed, scope) : scopeWords(ed)).short });

/** 範圍：卡片下方一行「套用到：整根 ▾」，點開是完整的範圍控制。scope＝實際要送的範圍（op.scope；沒有就用編輯器的）。 */
export function ScopeLine({ ed, scope }: { ed: Editor; scope?: Scope | null }) {
  return (
    <Popover trigger="click" placement="bottomLeft" content={<div style={{ width: 320 }}><ScopeControl ed={ed} showAxis /></div>}>
      <Button type="link" size="small" className="scope-line">
        套用到：{scopeWordsOf(ed, scope).long} <DownOutlined style={{ fontSize: 10 }} />
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
    }, PREVIEW_DEBOUNCE_MS);
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
        <ScopeLine ed={ed} scope={op?.scope} />
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

/** 「允許穿過其他材質」：勾了這一張卡片用 overwrite（plan v11 §4.10）。 */
function PolicyBox({ ed, value, onChange }: { ed: Editor; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Tooltip title={`預設${ed.pushPolicy === 'block' ? '碰到厚的別的材質就擋住（設定裡可改）' : '蓋過去'}`}>
      <Checkbox checked={value} onChange={(e) => onChange(e.target.checked)}>
        允許穿過其他材質
      </Checkbox>
    </Tooltip>
  );
}
const policyOf = (through: boolean): Policy => (through ? 'overwrite' : 'block');
const AXN = ['x', 'y', 'z'] as const;

/**
 * 長／縮（plan v11 §4.5～§4.8）：一面（push）｜兩側（CD）｜整層（保形 dilate）｜側壁斜度（taper）。
 */
export function PushCard({ ed, compact, plane, initialDir }: { ed: Editor; compact?: boolean; plane?: Axis; initialDir?: Vec3 }) {
  const host = useContext(CardHostCtx);
  const [mode, setMode] = useState<'face' | 'cd' | 'dilate' | 'taper'>('face');
  const [dir, setDir] = useState<Vec3>(() => initialDir ?? defaultDir(plane));
  const [n, setN] = useState(1);
  const [through, setThrough] = useState(ed.pushPolicy === 'overwrite');
  const [anchor, setAnchor] = useState<'center' | 'lo' | 'hi'>('center');
  const a = (dir[0] ? 0 : dir[1] ? 1 : 2) as 0 | 1 | 2;
  const [along, setAlong] = useState<0 | 1 | 2>(1);
  const alongOk = along !== a ? along : (((a + 1) % 3) as 0 | 1 | 2);
  const [top, setTop] = useState(-1);
  const [bottom, setBottom] = useState(2);
  const [both, setBoth] = useState(true);
  const pol = policyOf(through);
  const op = useMemo(() => {
    if (mode === 'cd') return ed.cdOp(a, n, anchor, pol);
    if (mode === 'dilate') return ed.dilateOp(n);
    if (mode === 'taper') return ed.taperOp(dir, alongOk, top, bottom, both, pol);
    return ed.pushOp(dir, n, undefined, pol);
  }, [mode, ed.cdOp, ed.dilateOp, ed.taperOp, ed.pushOp, a, n, anchor, pol, dir, alongOk, top, bottom, both]); // eslint-disable-line react-hooks/exhaustive-deps
  const thick = useMemo(() => (mode === 'dilate' && ed.selMask ? thicknessOf(ed.vol, ed.selMask, ed.selBox) : 0), [mode, ed.selMask, ed.vol, ed.selBox]);
  const [t0, t1] = alongOk === 1 ? ['頂', '底'] : alongOk === 0 ? ['左端', '右端'] : ['前端', '後端'];
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} compact={compact}>
      <Segmented
        size="small"
        block
        value={mode}
        onChange={(v) => setMode(v as typeof mode)}
        options={[
          { label: '一面', value: 'face' },
          { label: '兩側（CD）', value: 'cd' },
          { label: '整層（保形）', value: 'dilate' },
          { label: '側壁斜度', value: 'taper' },
        ]}
      />
      <Flex align="center" gap={12}>
        {mode !== 'dilate' && <FacePicker value={dir} onChange={setDir} onHover={host.highlight} allowed={plane ? inPlane(plane) : undefined} size={compact ? 80 : 96} pair={mode === 'cd'} />}
        <Flex vertical gap={6} style={{ flex: 1, minWidth: 0 }}>
          {mode === 'face' && (
            <Text style={{ fontSize: 12 }}>
              {faceName(dir)}沿法線{n >= 0 ? '往外長' : '往內縮'}；整面一起，只推最外側的表面。
            </Text>
          )}
          {mode === 'cd' && (
            <>
              <Text style={{ fontSize: 12 }}>沿 {AXN[a]} 的總寬；奇數格時多的一格給 {AXN[a]} 大的一側。</Text>
              <Segmented
                size="small"
                value={anchor}
                onChange={(v) => setAnchor(v as typeof anchor)}
                options={[
                  { label: '中心不動', value: 'center' },
                  { label: `${AXN[a]} 小端不動`, value: 'lo' },
                  { label: `${AXN[a]} 大端不動`, value: 'hi' },
                ]}
              />
            </>
          )}
          {mode === 'dilate' && (
            <Text style={{ fontSize: 12 }}>
              沿每一面一起長（歐氏距離，角是圓的）；外面的薄層{ed.follow ? '跟著推開' : '會擋住'}，厚的鄰居擋住。目前厚度約 {thick} 格（{(thick * ed.nmPerVoxel).toFixed(1)} nm）。
            </Text>
          )}
          {mode === 'taper' ? (
            <>
              <Flex align="center" gap={6}>
                <span style={{ fontSize: 12 }}>高度軸</span>
                <Segmented size="small" value={alongOk} onChange={(v) => setAlong(v as 0 | 1 | 2)} options={[0, 1, 2].filter((k) => k !== a).map((k) => ({ label: AXN[k], value: k }))} />
              </Flex>
              <Flex align="center" gap={6}>
                <span style={{ fontSize: 12 }}>{t0}</span>
                <InputNumber size="small" value={top} onChange={(v) => v !== null && setTop(Math.round(v))} suffix="vx" style={{ width: 76 }} aria-label={t0} />
                <span style={{ fontSize: 12 }}>{t1}</span>
                <InputNumber size="small" value={bottom} onChange={(v) => v !== null && setBottom(Math.round(v))} suffix="vx" style={{ width: 76 }} aria-label={t1} />
              </Flex>
              <Checkbox checked={both} onChange={(e) => setBoth(e.target.checked)}>
                兩側對稱
              </Checkbox>
            </>
          ) : (
            <Steps ed={ed} value={n} onChange={setN} label={mode === 'cd' ? '總寬 +' : mode === 'dilate' ? '厚度 +' : '格數'} />
          )}
          {mode !== 'dilate' && <PolicyBox ed={ed} value={through} onChange={setThrough} />}
        </Flex>
      </Flex>
    </CardShell>
  );
}

/** level 的參照候選：同一平面上和選取外框相交的結構先列（例如 fin、STI），再列其他（plan v11 §4.9）。 */
export function refCandidates(ed: Editor, dir: Vec3) {
  const b = ed.selBox;
  if (!b) return [];
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  const overlaps = (c: Editor['comps'][number]) => {
    const cl = [c.bbox.x0, c.bbox.y0, c.bbox.z0];
    const ch = [c.bbox.x1, c.bbox.y1, c.bbox.z1];
    return [0, 1, 2].every((k) => k === a || (cl[k] <= hi[k] && ch[k] >= lo[k]));
  };
  return ed.comps
    .filter((c) => !ed.sel.has(c.key))
    .sort((p, q) => Number(overlaps(q)) - Number(overlaps(p)) || q.count - p.count)
    .slice(0, 40)
    .map((c) => ({ value: c.key, label: `${c.label}${overlaps(c) ? '' : '（不相交）'}` }));
}

/** 方頭：選一面，每一排補到那一面最外側那一點（圓頭、斜角變方頭）；或「相對於」另一個結構的面（相對 recess）。 */
function LevelPart({ ed, compact, plane }: { ed: Editor; compact?: boolean; plane?: Axis }) {
  const host = useContext(CardHostCtx);
  const [dir, setDir] = useState<Vec3>(() => defaultDir(plane));
  const [refKey, setRefKey] = useState<string | null>(null);
  const [side, setSide] = useState<'lo' | 'hi'>('lo');
  const [offNm, setOffNm] = useState(3);
  const offset = Math.round(offNm / ed.nmPerVoxel);
  const ref = refKey ? { key: refKey, side, offset } : undefined;
  const op = useMemo(() => ed.levelOp(dir, ref), [ed.levelOp, dir, refKey, side, offset]); // eslint-disable-line react-hooks/exhaustive-deps
  const refs = useMemo(() => refCandidates(ed, dir), [ed.comps, ed.sel, ed.selBox, dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const to = ref ? levelRefTo(ed.L, dir, ref) : null;
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} compact={compact} applyText="套用方頭">
      <Flex align="center" gap={12}>
        <FacePicker value={dir} onChange={setDir} onHover={host.highlight} allowed={plane ? inPlane(plane) : undefined} size={compact ? 80 : 96} />
        <Flex vertical gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {faceName(dir)}每一排補到{ref ? '參照面＋偏移' : '最外側那一點'}。只填空氣；薄襯層{ed.follow ? '跟著往外走' : '會擋住（設定裡開「襯層一起推」才跟著走）'}，厚的鄰居不吃。
          </Text>
          <Flex align="center" gap={6}>
            <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>相對於</span>
            <Select size="small" allowClear style={{ flex: 1, minWidth: 0 }} placeholder="（絕對：最外側那一點）" value={refKey} onChange={(v) => setRefKey(v ?? null)} options={refs} aria-label="相對於" />
          </Flex>
          {refKey && (
            <Flex align="center" gap={6} wrap>
              <Segmented
                size="small"
                value={side}
                onChange={(v) => setSide(v as 'lo' | 'hi')}
                options={[
                  { label: a === 1 ? '頂' : `${AXN[a]} 小端`, value: 'lo' },
                  { label: a === 1 ? '底' : `${AXN[a]} 大端`, value: 'hi' },
                ]}
              />
              <InputNumber size="small" value={offNm} step={ed.nmPerVoxel} onChange={(v) => v !== null && setOffNm(v)} suffix="nm" style={{ width: 96 }} aria-label="偏移" />
              <Text type="secondary" style={{ fontSize: 12 }}>
                = {offset > 0 ? '+' : ''}
                {offset} 格 → {AXN[a]} = {to ?? '—'}（唯讀）
              </Text>
            </Flex>
          )}
        </Flex>
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

/**
 * 合理的目標材質（plan v11 §4.10 P14）：VOID、這些格子在原始檔裡的材質（若不同）、同類（kind）的材質；
 * 其他放在「全部…」裡。
 */
export function materialGroups(ed: Editor): { sane: Material[]; rest: Material[] } {
  const selMats = new Set(ed.selComps.map((c) => c.mat));
  const origMats = new Set(ed.selComps.map((c) => ed.origByKey.get(c.key)?.mat).filter((m): m is number => m !== undefined));
  const kinds = new Set([...selMats].map((id) => ed.materials.find((m) => m.id === id)).filter((m): m is Material => !!m).map(kindOf));
  const all = ed.materials.filter((x) => x.id !== 0);
  const isSane = (m: Material) => m.id === VOID || origMats.has(m.id) || selMats.has(m.id) || kinds.has(kindOf(m));
  const sane = all.filter(isSane).sort((p, q) => Number(q.id === VOID) - Number(p.id === VOID));
  return { sane, rest: all.filter((m) => !isSane(m)) };
}

/** 材質：換成哪一種。合理的在前（VOID 第一），其他收在「全部…」。換材質不先畫預覽，套用時 3D 先在 GPU 上變色。 */
export function MaterialCard({ ed, compact }: { ed: Editor; compact?: boolean }) {
  const host = useContext(CardHostCtx);
  const mats = new Set(ed.selComps.map((c) => c.mat));
  const [m, setM] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const op = useMemo(() => (m === null || (mats.size === 1 && mats.has(m)) ? null : ed.materialOp(m)), [ed.materialOp, m, mats.size === 1 && [...mats][0]]); // eslint-disable-line react-hooks/exhaustive-deps
  const { sane, rest } = materialGroups(ed);
  const label = (x: Material) => <MatLabel mat={x.id === VOID ? { ...x, name: `${x.name}（設為空洞）` } : x} />;
  const opts = [
    { label: '合理的目標', options: sane.map((x) => ({ value: x.id, label: label(x) })) },
    ...(all && rest.length ? [{ label: '全部（通常沒有製程意義）', options: rest.map((x) => ({ value: x.id, label: label(x) })) }] : []),
  ];
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} previewable={false} compact={compact} onApply={(o) => o.kind === 'material' && host.onMaterial(o.m)} applyText="換材質">
      <Select style={{ width: '100%' }} value={m ?? (mats.size === 1 ? [...mats][0] : undefined)} placeholder="換成…" onChange={setM} options={opts} />
      {rest.length > 0 && (
        <Flex vertical gap={2}>
          <Button size="small" type="link" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={() => setAll(!all)}>
            {all ? '收起其他材質' : `全部…（另外 ${rest.length} 種）`}
          </Button>
          {all && (
            <Text type="warning" style={{ fontSize: 12 }}>
              換成不同類的材質通常沒有製程意義（例如 fin 換成 TiN）。
            </Text>
          )}
        </Flex>
      )}
    </CardShell>
  );
}

/** 缺陷注入（plan v11 §4.7）：形狀、中心（相對結構外框 0～1）、大小（nm）、材質（VOID 在前）。 */
export function DefectCard({ ed, compact }: { ed: Editor; compact?: boolean }) {
  const [shape, setShape] = useState<'slab' | 'sphere' | 'box'>('slab');
  const [center, setCenter] = useState<Vec3>([0.5, 0.5, 0.5]);
  const [sizeNm, setSizeNm] = useState<Vec3>(() => [10, ed.nmPerVoxel, 10]);
  const [mat, setMat] = useState(VOID);
  const size = sizeNm.map((v) => Math.max(0, Math.round(v / ed.nmPerVoxel))) as Vec3;
  const op = useMemo(() => ed.defectOp(shape, center, size, mat), [ed.defectOp, shape, center, size[0], size[1], size[2], mat]); // eslint-disable-line react-hooks/exhaustive-deps
  const b = ed.selBox;
  const { sane } = materialGroups(ed);
  if (ed.sel.size !== 1)
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        缺陷放在一個結構裡：只選一個結構。
      </Text>
    );
  return (
    <CardShell ed={ed} op={op} words={op ? describeOp(wordsOf(ed), op) : ''} compact={compact} applyText="放缺陷">
      <Segmented
        size="small"
        value={shape}
        onChange={(v) => setShape(v as typeof shape)}
        options={[
          { label: '片', value: 'slab' },
          { label: '球', value: 'sphere' },
          { label: '盒', value: 'box' },
        ]}
      />
      {AXN.map((ax, k) => {
        const lo = b ? [b.x0, b.y0, b.z0][k] : 0;
        const len = b ? [b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0][k] + 1 : 1;
        const abs = Math.round(lo + center[k] * len);
        return (
          <Flex key={ax} align="center" gap={6}>
            <span style={{ fontSize: 12, width: 44 }}>中心 {ax}</span>
            <Slider style={{ flex: 1, margin: '0 6px' }} min={0} max={1} step={0.01} value={center[k]} onChange={(v) => setCenter((c) => c.map((x, i) => (i === k ? v : x)) as Vec3)} />
            <Text type="secondary" style={{ fontSize: 11, width: 92, textAlign: 'right' }}>
              {ax} = {abs}（{(abs * ed.nmPerVoxel).toFixed(1)} nm）
            </Text>
          </Flex>
        );
      })}
      <Flex align="center" gap={4} wrap>
        <span style={{ fontSize: 12 }}>大小</span>
        {AXN.map((ax, k) => (
          <InputNumber key={ax} size="small" min={0} step={ed.nmPerVoxel} value={sizeNm[k]} onChange={(v) => v !== null && setSizeNm((s) => s.map((x, i) => (i === k ? v : x)) as Vec3)} prefix={ax} suffix="nm" style={{ width: 96 }} aria-label={`大小 ${ax}`} />
        ))}
        <Text type="secondary" style={{ fontSize: 11 }}>= {size.join('×')} 格</Text>
      </Flex>
      <Select size="small" value={mat} onChange={setMat} options={sane.map((x) => ({ value: x.id, label: <MatLabel mat={x} /> }))} aria-label="缺陷材質" />
    </CardShell>
  );
}

/**
 * 五顆操作按鈕（plan v10 §4.7）：長／縮 · 方頭／圓頭 · 移動 · 材質 · 對應（多選）；每顆開對應卡片的 Popover。
 * 3D 的編輯工具列與 2D 浮動列共用（plane＝2D 剖面的法線軸，卡片只開放切面上的方向）。
 */
/**
 * 卡片（長／縮、方頭／圓頭、移動、材質、缺陷）與範圍控制 render 期間會讀的 ed 欄位（plan v15 B2）：
 * 掛著卡片的 memoEd 元件（EditToolbar、FloatingToolbar、Inspector）把它併進 uses。
 */
/** 卡片 render 會讀的 ed 欄位（memoEd 的 uses）。`cursor` 不在這裡：只有圓頭卡片讀它，它自己是 memoEd（換 cursor 時 Inspector／工具列不必跟著 render，plan v15 §7 e2e 2）。 */
export const CARD_USES: readonly EdKey[] = [
  'L', 'vol', 'comps', 'materials', 'matName', 'origByKey', 'sel', 'selComps', 'selBox', 'selMask', 'selRange', 'scope', 'scopeMode', 'customRange', 'editAxis',
  'busy', 'queued', 'report', 'follow', 'backfill', 'mirror', 'pushPolicy', 'nmPerVoxel', 'hidden',
  'pushOp', 'cdOp', 'dilateOp', 'taperOp', 'translateOp', 'materialOp', 'levelOp', 'defectOp', 'commit',
];

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
      <Popover trigger="click" placement="bottom" destroyOnHidden content={pop(<DefectCard ed={ed} compact />)}>
        <Button size="small" disabled={busy || ed.sel.size !== 1}>
          缺陷
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
