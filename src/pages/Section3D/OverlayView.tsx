// 疊圖（plan v11 §4.4）：一張大切面，底圖是基準那一片；每個 split 一條輪廓（不同色 1.5 px，基準黑色 2 px），
// 自動放大到所有 split 在這一片的差異聯集外框（＋4 格），圖例可切 split、暫時隱藏一條、滑過加粗。
// plan v15 §5.6 C5：lines（輪廓＋差異）進 useMemo，deps 是 split 版本串、基準版本、軸、片、keys；快取值含 diff、key 含基準版本；
// 圖例是 memo(Legend)，hover 只是圖例自己的 state，線條加粗靠 svg 裡的 data-hover 屬性＋樣式，不經過父元件 render。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Flex, Switch, Typography } from 'antd';
import { type Axis, type Vec3, hexToRgb } from '../../volume/volume';
import { BASE_ID, type Editor, type Split } from './editor';
import { drawSlice } from './drawSlice';
import { CATEGORY } from './colors';
import { type OverlayEntry, type UVBox, contourCache, contourOf, loopsPath, overlayEntry, overlayKey, sliceGeom, unionUV } from './overlay';
import { slabOf, versionOf } from './slabs';

const { Text } = Typography;
/** 疊圖快取：每筆只有 loops 與一個外框，很小，上限 1,000 筆（200 個 split × 幾片都留得住）。 */
const cache = contourCache<OverlayEntry>(1000);

interface Line {
  s: Split;
  k: number;
  d: string;
  diff: OverlayEntry['diff'];
}

type Win = Window & { __overlayMs?: number; __overlayMemoHits?: number };

/** 圖例（memo）：滑過只改自己的 state 與 svg 路徑的 data-hover，父元件不 render。 */
const Legend = memo(function Legend({
  lines,
  many,
  hidden,
  activeId,
  onToggle,
  onOpen,
  onHover,
}: {
  lines: Line[];
  many: boolean;
  hidden: Set<string>;
  activeId: string | null;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const enter = (id: string) => {
    setHover(id);
    onHover(id);
  };
  const leave = () => {
    setHover(null);
    onHover(null);
  };
  return (
    <>
      {lines.map(({ s, k, diff }) => (
        <div
          key={s.id}
          className={'legend-row' + (hidden.has(s.id) ? ' off' : '') + (s.id === activeId ? ' on' : '')}
          data-hover={hover === s.id ? 1 : undefined}
          onMouseEnter={() => enter(s.id)}
          onMouseLeave={leave}
        >
          <button className="legend-swatch" style={{ background: CATEGORY[k % CATEGORY.length], opacity: many ? 0.6 : 1 }} aria-label={`${hidden.has(s.id) ? '顯示' : '隱藏'} ${s.name}`} onClick={() => onToggle(s.id)} />
          <Typography.Link onClick={() => onOpen(s.id)} style={{ fontSize: 12 }}>
            {s.name}
          </Typography.Link>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {diff.count.toLocaleString()} 格
          </Text>
        </div>
      ))}
    </>
  );
});

/** ids＝要疊的 split（省略＝全部）；切面來源 slabOf（parked 不還原，plan v12 §5.3）；圖例點名字＝onOpen。 */
export function OverlayView({ ed, axis, at, ids, onOpen }: { ed: Editor; axis: Axis; at: number; ids?: string[]; onOpen?: (id: string) => void }) {
  const baseSplit = ed.compareBase === BASE_ID ? null : ed.splits.find((s) => s.id === ed.compareBase) ?? null;
  const base = slabOf(ed.orig, baseSplit, axis, at);
  const baseName = baseSplit ? baseSplit.name : '原始';
  const splits = ed.splits.filter((s) => s.id !== baseSplit?.id && (!ids || ids.includes(s.id)));
  const setActiveId = ed.setActiveId;
  const open = useCallback((id: string) => (onOpen ? onOpen(id) : void setActiveId(id)), [onOpen, setActiveId]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleHidden = useCallback(
    (id: string) =>
      setHidden((h) => {
        const next = new Set(h);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const [zoom, setZoom] = useState(true);
  const { W, H } = sliceGeom(ed.vol, axis);
  // 身分會每次 render 換的東西都換成值的簽名當 deps：split 的 id|版本 串、基準版本、keys 串
  const splitsKey = splits.map((s) => `${s.id}|${versionOf(ed.orig, s)}`).join(',');
  const baseVersion = versionOf(ed.orig, baseSplit);
  // 輪廓的結構：選到的；沒選就用每個 split 改到的結構（ops 的 keys）聯集
  const keysOf = (ops: { keys: string[] }[]) => (ed.sel.size ? [...ed.sel] : [...new Set(ops.flatMap((o) => o.keys))]);
  const allKeys = useMemo(() => keysOf(splits.flatMap((s) => s.ops)), [splitsKey, ed.sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const allKeysKey = allKeys.join(',');
  const calcs = useRef(0);
  const { lines, baseD, ms } = useMemo(() => {
    calcs.current++;
    const t0 = performance.now();
    const lines: Line[] = splits.map((s, k) => {
      const own = keysOf(s.ops);
      const keys = own.length ? own : allKeys;
      const sl = slabOf(ed.orig, s, axis, at);
      const e = cache.get(overlayKey(versionOf(ed.orig, s), axis, at, keys, baseVersion), () => overlayEntry(sl.L, sl.vol, base.vol.data, keys, axis, 0));
      return { s, k, d: loopsPath(e.loops), diff: e.diff };
    });
    // 基準對自己沒有差異，不用掃
    const baseLoops = cache.get(overlayKey(baseVersion, axis, at, allKeys, baseVersion), () => ({ loops: contourOf(base.L, base.vol, allKeys, axis, 0), diff: { box: null, count: 0 } })).loops;
    const ms = performance.now() - t0;
    if (import.meta.env.DEV) (window as unknown as Win).__overlayMs = ((window as unknown as Win).__overlayMs ?? 0) + ms;
    return { lines, baseD: loopsPath(baseLoops), ms };
  }, [splitsKey, baseVersion, axis, at, allKeysKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 開發模式計數：這次 render 沒重算 lines ＝ memo 命中（e2e m15 §8）
  const seen = useRef(0);
  if (import.meta.env.DEV) {
    const w = window as unknown as Win;
    if (calcs.current === seen.current) w.__overlayMemoHits = (w.__overlayMemoHits ?? 0) + 1;
    seen.current = calcs.current;
  }
  // 自動放大：差異聯集外框（＋4 格）；沒有差異就退到選取外框
  const selBox = useMemo<UVBox | null>(() => {
    const b = ed.selBox;
    if (!b) return null;
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    const [ua, va] = axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1];
    return { u0: lo[ua], v0: lo[va], u1: hi[ua], v1: hi[va] };
  }, [ed.selBox, axis]);
  const view = useMemo(
    () =>
      (zoom && (unionUV(lines.map((l) => l.diff.box), 4, W, H) ?? unionUV([selBox], 4, W, H))) || { u0: 0, v0: 0, u1: W - 1, v1: H - 1 },
    [zoom, lines, selBox, W, H],
  );
  const VW = view.u1 - view.u0 + 1;
  const VH = view.v1 - view.v0 + 1;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    ed.materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [ed.materials]);
  useEffect(() => {
    if (canvasRef.current) drawSlice(canvasRef.current, base.vol, axis, 0, rgb, ed.hidden, null, null, null);
  }, [base, axis, rgb, ed.hidden]);
  const fitRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 400, h: 300 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const s = Math.min(e.contentRect.width / VW, e.contentRect.height / VH);
      setSize({ w: Math.floor(VW * s), h: Math.floor(VH * s) });
    });
    ro.observe(fitRef.current!);
    return () => ro.disconnect();
  }, [VW, VH]);
  const many = splits.length > CATEGORY.length;
  // 滑過加粗：直接改 svg 裡那條路徑的 data-hover（樣式在 svg 的 <style>），不經過 React state
  const svgRef = useRef<SVGSVGElement>(null);
  const onHover = useCallback((id: string | null) => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.querySelectorAll('path[data-hover]').forEach((p) => p.removeAttribute('data-hover'));
    if (id !== null) svg.querySelector(`path[data-id="${CSS.escape(id)}"]`)?.setAttribute('data-hover', '1');
  }, []);

  return (
    <div className="overlay-view">
      <div className="overlay-stage" ref={fitRef}>
        <div className="slice-img" style={{ width: size.w, height: size.h, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', width: `${(W / VW) * 100}%`, height: `${(H / VH) * 100}%`, left: `${(-view.u0 / VW) * 100}%`, top: `${(-view.v0 / VH) * 100}%` }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block', opacity: 0.55 }} />
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <style>{'path[data-hover="1"]{stroke-width:3;stroke-opacity:1}'}</style>
              <path d={baseD} fill="none" stroke="#000" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {lines.map(({ s, k, d }) =>
                hidden.has(s.id) ? null : <path key={s.id} data-id={s.id} d={d} fill="none" stroke={CATEGORY[k % CATEGORY.length]} strokeOpacity={many ? 0.5 : 1} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />,
              )}
            </svg>
          </div>
        </div>
      </div>
      <div className="overlay-legend">
        <Flex align="center" gap={8} style={{ marginBottom: 6 }}>
          <Switch size="small" checked={zoom} onChange={setZoom} />
          <Text style={{ fontSize: 12 }}>自動放大到差異</Text>
        </Flex>
        <div className="legend-row">
          <span className="legend-swatch" style={{ background: '#000' }} />
          <b>{baseName}</b>
          <Text type="secondary" style={{ fontSize: 11 }}>
            基準
          </Text>
        </div>
        <Legend lines={lines} many={many} hidden={hidden} activeId={ed.activeId} onToggle={toggleHidden} onOpen={open} onHover={onHover} />
        {many && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            超過 {CATEGORY.length} 個 split 顏色會重複：線變半透明，滑過加粗；建議在矩陣表篩選。
          </Text>
        )}
        <Text type="secondary" style={{ fontSize: 11 }}>
          {axis} = {at} · 描 {lines.length + 1} 條輪廓 {ms.toFixed(0)} ms
        </Text>
      </div>
    </div>
  );
}
