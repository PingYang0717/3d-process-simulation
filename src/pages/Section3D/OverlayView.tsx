// 疊圖（plan v11 §4.4）：一張大切面，底圖是基準那一片；每個 split 一條輪廓（不同色 1.5 px，基準黑色 2 px），
// 自動放大到所有 split 在這一片的差異聯集外框（＋4 格），圖例可切 split、暫時隱藏一條、滑過加粗。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Flex, Switch, Typography } from 'antd';
import { type Axis, type Vec3, hexToRgb } from '../../volume/volume';
import { sidOf } from '../../volume/client';
import { BASE_ID, type Editor } from './editor';
import { drawSlice } from './drawSlice';
import { CATEGORY } from './ExperimentTab';
import { type UVBox, contourCache, contourOf, loopsPath, overlayKey, sliceDiff, sliceGeom, unionUV } from './overlay';

const { Text } = Typography;
const cache = contourCache();

export function OverlayView({ ed, axis, at }: { ed: Editor; axis: Axis; at: number }) {
  const baseSplit = ed.compareBase === BASE_ID ? null : ed.splits.find((s) => s.id === ed.compareBase) ?? null;
  const base = baseSplit ? baseSplit.cur : ed.orig;
  const baseName = baseSplit ? baseSplit.name : '原始';
  const splits = ed.splits.filter((s) => s.id !== baseSplit?.id);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [zoom, setZoom] = useState(true);
  const { W, H } = sliceGeom(ed.vol, axis);
  // 輪廓的結構：選到的；沒選就用每個 split 改到的結構（ops 的 keys）聯集
  const keysOf = (ops: { keys: string[] }[]) => (ed.sel.size ? [...ed.sel] : [...new Set(ops.flatMap((o) => o.keys))]);
  const allKeys = useMemo(() => keysOf(ed.splits.flatMap((s) => s.ops)), [ed.splits, ed.sel]); // eslint-disable-line react-hooks/exhaustive-deps
  const t0 = performance.now();
  const lines = splits.map((s, k) => {
    const keys = keysOf(s.ops).length ? keysOf(s.ops) : allKeys;
    const v = sidOf(s.cur);
    const loops = cache.get(overlayKey(v, axis, at, keys), () => contourOf(s.cur.L, s.cur.vol, keys, axis, at));
    const d = sliceDiff(s.cur.vol.data, base.vol.data, ed.vol, axis, at);
    return { s, k, loops, diff: d };
  });
  const baseLoops = cache.get(overlayKey(sidOf(base), axis, at, allKeys), () => contourOf(base.L, base.vol, allKeys, axis, at));
  const ms = performance.now() - t0;
  if (import.meta.env.DEV) (window as unknown as { __overlayMs?: number }).__overlayMs = ms;
  // 自動放大：差異聯集外框（＋4 格）；沒有差異就退到選取外框
  const selBox = useMemo<UVBox | null>(() => {
    const b = ed.selBox;
    if (!b) return null;
    const lo = [b.x0, b.y0, b.z0];
    const hi = [b.x1, b.y1, b.z1];
    const [ua, va] = axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1];
    return { u0: lo[ua], v0: lo[va], u1: hi[ua], v1: hi[va] };
  }, [ed.selBox, axis]);
  const view = (zoom && (unionUV(lines.map((l) => l.diff.box), 4, W, H) ?? unionUV([selBox], 4, W, H))) || { u0: 0, v0: 0, u1: W - 1, v1: H - 1 };
  const VW = view.u1 - view.u0 + 1;
  const VH = view.v1 - view.v0 + 1;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    ed.materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [ed.materials]);
  useEffect(() => {
    if (canvasRef.current) drawSlice(canvasRef.current, base.vol, axis, at, rgb, ed.hidden, null, null, null);
  }, [base, axis, at, rgb, ed.hidden]);
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

  return (
    <div className="overlay-view">
      <div className="overlay-stage" ref={fitRef}>
        <div className="slice-img" style={{ width: size.w, height: size.h, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', width: `${(W / VW) * 100}%`, height: `${(H / VH) * 100}%`, left: `${(-view.u0 / VW) * 100}%`, top: `${(-view.v0 / VH) * 100}%` }}>
            <canvas ref={canvasRef} style={{ width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block', opacity: 0.55 }} />
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <path d={loopsPath(baseLoops)} fill="none" stroke="#000" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {lines.map(({ s, k, loops }) =>
                hidden.has(s.id) ? null : (
                  <path
                    key={s.id}
                    d={loopsPath(loops)}
                    fill="none"
                    stroke={CATEGORY[k % CATEGORY.length]}
                    strokeOpacity={many && hover !== s.id ? 0.5 : 1}
                    strokeWidth={hover === s.id ? 3 : 1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                ),
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
        {lines.map(({ s, k, diff }) => (
          <div key={s.id} className={'legend-row' + (hidden.has(s.id) ? ' off' : '') + (s.id === ed.activeId ? ' on' : '')} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}>
            <button
              className="legend-swatch"
              style={{ background: CATEGORY[k % CATEGORY.length], opacity: many ? 0.6 : 1 }}
              aria-label={`${hidden.has(s.id) ? '顯示' : '隱藏'} ${s.name}`}
              onClick={() => {
                const next = new Set(hidden);
                if (next.has(s.id)) next.delete(s.id);
                else next.add(s.id);
                setHidden(next);
              }}
            />
            <Typography.Link onClick={() => ed.setActiveId(s.id)} style={{ fontSize: 12 }}>
              {s.name}
            </Typography.Link>
            <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
              {diff.count.toLocaleString()} 格
            </Text>
          </div>
        ))}
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
