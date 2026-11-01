// 結果區的卡片網格（plan v12 §5.4）：依設計分組（可收合），卡片固定大小、自己做視窗化（只渲染看得到的列 ± 2 列，
// DOM 裡最多幾十張卡）；縮圖在卡片裡進視窗才畫。只吃 split 清單與頁面自己的狀態，不訂閱游標、hover、預覽。
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Typography } from 'antd';
import { DownOutlined, RightOutlined } from '@ant-design/icons';
import type { Axis, Material, Vec3 } from '../../volume/volume';
import type { EditState } from '../../volume/ops';
import type { Factor } from '../../volume/factors';
import type { Split } from './editor';
import { type CardApi, SplitCard } from './SplitCard';

const { Text } = Typography;

export interface ResultGroup {
  id: string;
  title: string;
  sub: string;
  splits: Split[];
  axis: Axis;
  /** 這個設計改到的結構（對照組的縮圖用）。 */
  keys: string[];
}

export const CARD_W = 232;
export const CARD_H = 292;
const GAP = 12;
const HEAD_H = 44;
const OVERSCAN = 2;

type Row = { kind: 'head'; g: ResultGroup; top: number; h: number } | { kind: 'cards'; g: ResultGroup; splits: Split[]; top: number; h: number };

export const ResultGrid = memo(function ResultGrid({
  groups,
  orig,
  factors,
  fIndex,
  rgb,
  hidden,
  look,
  materials,
  nm,
  hi,
  checked,
  activeId,
  api,
  collapsed,
  onCollapse,
  onSelectGroup,
  scrollTo,
}: {
  groups: ResultGroup[];
  orig: EditState;
  factors: Factor[];
  fIndex: Map<string, number>;
  rgb: Map<number, Vec3>;
  hidden: Set<number>;
  look: string;
  materials: Material[];
  nm: number;
  hi: string | null;
  checked: Set<string>;
  activeId: string;
  api: CardApi;
  collapsed: Set<string>;
  onCollapse: (id: string) => void;
  onSelectGroup: (g: ResultGroup) => void;
  /** 捲到這個 split（產生完、從表格點過來）；nonce 變了才捲。 */
  scrollTo: { id: string; nonce: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 600, w: 900 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const measure = () => setView((v) => ({ ...v, h: el.clientHeight, w: el.clientWidth }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setView((v) => (v.top === el.scrollTop ? v : { ...v, top: el.scrollTop }));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);
  const cols = Math.max(1, Math.floor((view.w - 2 * GAP + GAP) / (CARD_W + GAP)));
  const { rows, total } = useMemo(() => {
    const out: Row[] = [];
    let y = GAP;
    for (const g of groups) {
      out.push({ kind: 'head', g, top: y, h: HEAD_H });
      y += HEAD_H;
      if (collapsed.has(g.id)) continue;
      for (let i = 0; i < g.splits.length; i += cols) {
        out.push({ kind: 'cards', g, splits: g.splits.slice(i, i + cols), top: y, h: CARD_H + GAP });
        y += CARD_H + GAP;
      }
    }
    return { rows: out, total: y + GAP };
  }, [groups, collapsed, cols]);
  // 捲到指定的 split
  useEffect(() => {
    if (!scrollTo || !ref.current) return;
    const r = rows.find((x) => x.kind === 'cards' && x.splits.some((s) => s.id === scrollTo.id));
    const head = r && rows.find((x) => x.kind === 'head' && x.g === r.g);
    if (r) ref.current.scrollTo({ top: Math.max(0, (head?.top ?? r.top) - GAP), behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTo?.nonce]);
  const pad = OVERSCAN * (CARD_H + GAP);
  const shown = rows.filter((r) => r.top + r.h >= view.top - pad && r.top <= view.top + view.h + pad);
  if (import.meta.env.DEV) (window as unknown as { __gridRows?: number }).__gridRows = shown.length;

  return (
    <div className="lab-grid" ref={ref} role="grid" aria-label="split 卡片">
      <div style={{ position: 'relative', height: total }}>
        {shown.map((r) =>
          r.kind === 'head' ? (
            <div key={`h:${r.g.id}`} className="lab-group-head" style={{ position: 'absolute', top: r.top, left: GAP, right: GAP, height: HEAD_H }}>
              <Button type="text" size="small" icon={collapsed.has(r.g.id) ? <RightOutlined /> : <DownOutlined />} onClick={() => onCollapse(r.g.id)} aria-label={collapsed.has(r.g.id) ? '展開' : '收合'} />
              <b className="lab-group-title">{r.g.title}</b>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {r.g.sub}
              </Text>
              <span className="grow" />
              <Button size="small" type="link" onClick={() => onSelectGroup(r.g)}>
                全選這組
              </Button>
            </div>
          ) : (
            <div key={`r:${r.g.id}:${r.top}`} className="lab-card-row" style={{ position: 'absolute', top: r.top, left: GAP, height: CARD_H, display: 'flex', gap: GAP }}>
              {r.splits.map((s) => (
                <SplitCard
                  key={s.id}
                  split={s}
                  orig={orig}
                  axis={r.g.axis}
                  factors={factors}
                  fIndex={fIndex}
                  rgb={rgb}
                  hidden={hidden}
                  look={look}
                  keys={r.g.keys}
                  materials={materials}
                  nm={nm}
                  hi={hi === s.id}
                  checked={checked.has(s.id)}
                  current={activeId === s.id}
                  api={api}
                />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
});
