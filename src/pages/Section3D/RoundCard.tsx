// 圓頭面板（plan v10 §4.6）：OpCard 的一種。2D 浮動列、2D 角節點右鍵、3D 角把手、3D 右鍵、右欄開的都是它，產生同一個 Op。
// 剖面＝結構最長軸的法線（和 2D 自動選的一樣；2D 剖面裡就是主切面的方向），參考片＝十字那一片（沒有結構就最近的一片）。
import { useMemo, useState } from 'react';
import { Flex, InputNumber, Segmented, Slider, Switch, Tooltip, Typography } from 'antd';
import type { Axis } from '../../volume/volume';
import { axisIndex, fullScope, planeAxes } from '../../volume/scope';
import { type CornerId, type RoundGesture, roundBuild, roundOutline } from '../../slice/round';
import { type Editor, slicesWith } from './editor';
import { CardShell, wordsOf } from './OpCard';
import { longestAxis, nearestSlice } from './PositionBar';
import { whoText } from './opWords';

const { Text } = Typography;

type CornerKind = 'none' | 'convex' | 'concave';
const CORNERS: CornerId[] = ['ul', 'ur', 'll', 'lr'];
const NEXT: Record<CornerKind, CornerKind> = { none: 'convex', convex: 'concave', concave: 'none' };
const KIND_WORD: Record<CornerKind, string> = { none: '不圓', convex: '外圓角', concave: '內圓角（往外填）' };

/** 這個軸的剖面與參考片：axis 有給（2D）就用它，否則選取最長軸的法線；片＝十字那一片或最近有結構的一片。 */
export function roundFrame(ed: Editor, plane?: Axis) {
  const axis = plane ?? longestAxis(ed) ?? ed.editAxis;
  const t = ed.cursor[axisIndex(axis)];
  const at = ed.selMask ? (nearestSlice(slicesWith(ed.selMask, ed.vol, axis, ed.selBox), t) ?? t) : t;
  const scope = ed.scope.axis === axis ? ed.scope : fullScope(ed.vol, axis);
  return { axis, at, scope };
}

export function RoundCard({ ed, compact, plane, initial }: { ed: Editor; compact?: boolean; plane?: Axis; initial?: Partial<RoundGesture> }) {
  const [corners, setCorners] = useState<Record<CornerId, CornerKind>>(() => {
    const c: Record<CornerId, CornerKind> = { ul: 'none', ur: 'none', ll: 'none', lr: 'none' };
    for (const x of initial?.corners ?? [{ id: 'ul' }, { id: 'ur' }]) c[x.id] = x.concave ? 'concave' : 'convex';
    return c;
  });
  const [r, setR] = useState(initial?.r ?? 6);
  const [asym, setAsym] = useState(initial?.ru !== undefined || initial?.rv !== undefined);
  const [ru, setRu] = useState(initial?.ru ?? initial?.r ?? 6);
  const [rv, setRv] = useState(initial?.rv ?? initial?.r ?? 6);
  const [n, setN] = useState(initial?.n ?? 2);
  const [mode, setMode] = useState<RoundGesture['mode']>(initial?.mode ?? 'match');
  const { axis, at, scope } = roundFrame(ed, plane);
  const g: RoundGesture = useMemo(
    () => ({
      kind: 'round',
      corners: CORNERS.filter((id) => corners[id] !== 'none').map((id) => (corners[id] === 'concave' ? { id, concave: true } : { id })),
      r,
      ...(asym ? { ru, rv } : {}),
      n,
      mode,
    }),
    [corners, r, asym, ru, rv, n, mode],
  );
  const keys = useMemo(() => [...ed.sel], [ed.sel]);
  // Op 與參考片統計一次算好（plan v14 P5）
  const built = useMemo(
    () => (g.corners.length && keys.length ? roundBuild(ed.L, ed.vol, keys, scope, at, g, ed.follow, ed.backfill, ed.nmPerVoxel) : null),
    [g, keys, ed.L, ed.vol, scope, at, ed.follow, ed.backfill, ed.nmPerVoxel],
  );
  const op = built?.op ?? null;
  const stats = built?.stats ?? null;
  // 剖面小圖：選取外框投影到切面（示意，比例照實際）
  const [ua, va] = planeAxes(axis);
  const b = ed.selBox;
  const lo = b ? [b.x0, b.y0, b.z0] : [0, 0, 0];
  const hi = b ? [b.x1, b.y1, b.z1] : [7, 7, 7];
  const box = { u0: lo[ua], v0: lo[va], u1: hi[ua], v1: hi[va] };
  const W = box.u1 - box.u0 + 1;
  const H = box.v1 - box.v0 + 1;
  const outline = useMemo(() => roundOutline(box, g), [box.u0, box.v0, box.u1, box.v1, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const limit = Math.max(1, Math.floor(stats?.limit || Math.min(W, H) / 2));
  const pad = Math.max(W, H) * 0.35;
  const vb = `${box.u0 - pad} ${box.v0 - pad} ${W + 2 * pad} ${H + 2 * pad}`;
  const cornerAt: Record<CornerId, [number, number]> = { ul: [box.u0, box.v0], ur: [box.u1 + 1, box.v0], ll: [box.u0, box.v1 + 1], lr: [box.u1 + 1, box.v1 + 1] };
  const nm = (v: number) => `${(v * ed.nmPerVoxel).toFixed(1)} nm`;
  const words = op
    ? `${whoText(ed.L, op.keys, ed.matName)} ${op.text ?? ''} · 削 ${(stats?.cut ?? 0).toLocaleString()} 格、填 ${(stats?.fill ?? 0).toLocaleString()} 格（參考片 ${axis} = ${at}）· ${wordsOf(ed).scope}`
    : g.corners.length
      ? '這個設定不會改到任何格子'
      : '點小圖的角選要圓哪幾個';
  const small = Math.min(asym ? Math.min(ru, rv) : r, limit) < 3;
  return (
    <CardShell
      ed={ed}
      op={op}
      words={words}
      compact={compact}
      applyText="套用圓頭"
      note={
        <>
          {stats?.clamped && (
            <Text type="warning" style={{ fontSize: 12 }}>
              半徑超過半寬／半高，已夾到 {limit} 格
            </Text>
          )}
          {small && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              體素太粗：r &lt; 3 格看起來會像斜切
            </Text>
          )}
        </>
      }
    >
      <Flex gap={12} align="start">
        <svg className="round-sketch" width={compact ? 112 : 124} height={compact ? 112 : 124} viewBox={vb} aria-label="剖面小圖：點角切換不圓／外圓角／內圓角">
          <rect x={box.u0} y={box.v0} width={W} height={H} className="rs-box" vectorEffect="non-scaling-stroke" />
          <polygon points={outline.map((p) => p.join(',')).join(' ')} className="rs-shape" vectorEffect="non-scaling-stroke" />
          {CORNERS.map((id) => (
            <Tooltip key={id} title={`${KIND_WORD[corners[id]]}（點一下換）`}>
              <circle
                cx={cornerAt[id][0]}
                cy={cornerAt[id][1]}
                r={Math.max(W, H) * 0.09}
                className={'rs-dot ' + corners[id]}
                role="button"
                tabIndex={0}
                aria-label={`${id} 角：${KIND_WORD[corners[id]]}`}
                onClick={() => setCorners((c) => ({ ...c, [id]: NEXT[c[id]] }))}
                onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.stopPropagation(), e.preventDefault(), setCorners((c) => ({ ...c, [id]: NEXT[c[id]] })))}
              />
            </Tooltip>
          ))}
        </svg>
        <Flex vertical gap={6} style={{ flex: 1, minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            剖面 {'xyz'[ua]}–{'xyz'[va]}（沿 {axis}）；點角：不圓 → 外圓角 → 內圓角
          </Text>
          {!asym ? (
            <Flex align="center" gap={6}>
              <span style={{ fontSize: 12, width: 40 }}>半徑</span>
              <Slider min={1} max={limit} value={Math.min(r, limit)} onChange={setR} style={{ flex: 1, margin: '0 4px' }} />
              <InputNumber size="small" min={1} value={r} onChange={(v) => v && setR(Math.round(v))} precision={0} suffix="vx" style={{ width: 72 }} aria-label="半徑" />
            </Flex>
          ) : (
            <>
              <Flex align="center" gap={6}>
                <span style={{ fontSize: 12, width: 40 }}>寬 ru</span>
                <Slider min={1} max={limit * 2} value={ru} onChange={setRu} style={{ flex: 1, margin: '0 4px' }} />
                <InputNumber size="small" min={1} value={ru} onChange={(v) => v && setRu(Math.round(v))} precision={0} suffix="vx" style={{ width: 72 }} aria-label="寬 ru" />
              </Flex>
              <Flex align="center" gap={6}>
                <span style={{ fontSize: 12, width: 40 }}>肩高</span>
                <Slider min={1} max={limit * 2} value={rv} onChange={setRv} style={{ flex: 1, margin: '0 4px' }} />
                <InputNumber size="small" min={1} value={rv} onChange={(v) => v && setRv(Math.round(v))} precision={0} suffix="vx" style={{ width: 72 }} aria-label="肩高 rv" />
              </Flex>
            </>
          )}
          <Text type="secondary" style={{ fontSize: 11 }}>
            {asym ? `ru ${nm(ru)} · 肩高 ${nm(rv)}` : `r = ${nm(r)}`}
          </Text>
          <Flex align="center" gap={6}>
            <Switch size="small" checked={asym} onChange={setAsym} />
            <span style={{ fontSize: 12 }}>不對稱（寬／肩高分開）</span>
          </Flex>
        </Flex>
      </Flex>
      <Flex align="center" gap={6}>
        <span style={{ fontSize: 12, width: 48 }}>方圓度</span>
        <Slider min={1} max={8} step={0.5} value={n} onChange={setN} marks={{ 1: '斜切', 2: '圓', 8: '方' }} style={{ flex: 1, margin: '0 8px 14px' }} />
      </Flex>
      <Segmented
        size="small"
        block
        value={mode}
        onChange={(v) => setMode(v as RoundGesture['mode'])}
        options={[
          { label: '對齊形狀', value: 'match' },
          { label: '只削', value: 'cut' },
          { label: '只填', value: 'fill' },
        ]}
      />
    </CardShell>
  );
}
