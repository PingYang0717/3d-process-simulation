import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { AimOutlined, ExpandOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Material, type Vec3, type Volume, hexToRgb } from '../../volume/volume';
import type { Preview } from '../../volume/preview';
import { type Scope, axisLen } from '../../volume/scope';
import { type SelectMode, selectModeOf } from './editor';
import { drawSlice } from './views';

/** 縮放＝每個 voxel 幾個 CSS px。 */
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 32;
const CLICK_PX = 4;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

interface ViewXf {
  zoom: number;
  tx: number;
  ty: number;
}
/** 每個方向上次的縮放與位置（這個 session 裡記住；回 3D 再進來還原）。 */
const memory = new Map<Axis, ViewXf>();

/** 切面上的 (u, v) 對應哪兩個體素軸：XY 正面 u=x v=y；XZ 上視 u=x v=z；YZ 側面 u=z v=y。 */
export const planeDims = (vol: Volume, axis: Axis): [number, number] => (axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y]);
export const toPlane = (axis: Axis, p: Vec3): [number, number] => (axis === 'z' ? [p[0], p[1]] : axis === 'y' ? [p[0], p[2]] : [p[2], p[1]]);
const boxInPlane = (axis: Axis, b: BBox) => {
  const [u0, v0] = toPlane(axis, [b.x0, b.y0, b.z0]);
  const [u1, v1] = toPlane(axis, [b.x1, b.y1, b.z1]);
  return { u0, v0, u1, v1 };
};

/**
 * 主切面（2D 編輯狀態）：滾輪朝游標縮放、右鍵／中鍵／空白鍵＋左鍵／Alt＋左鍵拖＝平移、雙擊空白＝適合視窗、
 * Ctrl＋滾輪換片。左鍵點一下＝選取（Shift 加選、Ctrl 切換）。底圖和下方小切面同一個 drawSlice。
 */
export function SliceEditor({
  vol,
  axis,
  at,
  materials,
  hidden,
  selMask,
  cursor,
  scope,
  diff,
  preview,
  selBox,
  focusKey,
  autoZoom,
  onPick,
  onStep,
  onHover,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  materials: Material[];
  hidden: Set<number>;
  /** 選取 ∩ 範圍（混藍）。 */
  selMask: Uint8Array | null;
  cursor: Vec3;
  scope: Scope | null;
  diff: Uint8Array | null;
  preview?: Preview | null;
  /** 選取外框（對準選取、自動放大用）。 */
  selBox: BBox | null;
  /** 選取改變時換值（自動放大的觸發）。 */
  focusKey: string;
  autoZoom: boolean;
  onPick: (p: Vec3, mode: SelectMode) => void;
  onStep: (delta: number) => void;
  onHover?: (p: Vec3 | null) => void;
}) {
  const [W, H] = planeDims(vol, axis);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [xf, setXf] = useState<ViewXf | null>(null);
  const xfRef = useRef(xf);
  xfRef.current = xf;
  const [hoverUV, setHoverUV] = useState<[number, number] | null>(null);
  const space = useRef(false);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);
  const toVoxel = useCallback((u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]), [axis, at]);

  useEffect(() => {
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff, preview);
  }, [vol, axis, at, rgb, hidden, selMask, diff, preview]);

  const size = () => {
    const r = hostRef.current?.getBoundingClientRect();
    return { w: r?.width ?? 1, h: r?.height ?? 1 };
  };
  const fit = useCallback(() => {
    const { w, h } = size();
    const zoom = clampZoom(Math.min(w / W, h / H) * 0.94);
    setXf({ zoom, tx: (w - W * zoom) / 2, ty: (h - H * zoom) / 2 });
  }, [W, H]);
  const aim = useCallback(() => {
    if (!selBox) return fit();
    const { u0, v0, u1, v1 } = boxInPlane(axis, selBox);
    const { w, h } = size();
    const bw = u1 - u0 + 1;
    const bh = v1 - v0 + 1;
    // 四周留 30%，看得到旁邊的結構
    const zoom = clampZoom(Math.min(w / (bw * 1.6 + 4), h / (bh * 1.6 + 4)));
    const cu = (u0 + u1 + 1) / 2;
    const cv = (v0 + v1 + 1) / 2;
    setXf({ zoom, tx: w / 2 - cu * zoom, ty: h / 2 - cv * zoom });
  }, [selBox, axis, fit]);
  const zoomAt = (zoom: number, px?: number, py?: number) =>
    setXf((p) => {
      if (!p) return p;
      const { w, h } = size();
      const cx = px ?? w / 2;
      const cy = py ?? h / 2;
      const z = clampZoom(zoom);
      return { zoom: z, tx: cx - ((cx - p.tx) * z) / p.zoom, ty: cy - ((cy - p.ty) * z) / p.zoom };
    });

  // 第一次：自動放大到選取，否則還原這個方向上次的縮放，再不然適合視窗
  useLayoutEffect(() => {
    const m = memory.get(axis);
    if (autoZoom && selBox) aim();
    else if (m) setXf(m);
    else fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis]);
  // 換選取：自動放大
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    if (autoZoom && selBox) aim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  useEffect(() => {
    if (xf) memory.set(axis, xf);
  }, [xf, axis]);

  // 滾輪＝縮放；Ctrl＋滾輪＝換片（要非 passive 才能擋掉頁面捲動與瀏覽器縮放）
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useEffect(() => {
    const el = hostRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        stepRef.current(e.deltaY > 0 ? 1 : -1);
        return;
      }
      const p = xfRef.current;
      if (!p) return;
      const r = el.getBoundingClientRect();
      zoomAt(p.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // 空白鍵按住＋左鍵拖＝平移
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || (e.target as HTMLElement | null)?.closest?.('input,textarea,select,button,[contenteditable]')) return;
      if (!hostRef.current?.matches(':hover')) return;
      e.preventDefault();
      space.current = true;
      hostRef.current.style.cursor = 'grab';
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== ' ') return;
      space.current = false;
      if (hostRef.current) hostRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  // 視窗大小改變：保持中心
  useEffect(() => {
    let last = size();
    const ro = new ResizeObserver(() => {
      const now = size();
      setXf((p) => (p ? { ...p, tx: p.tx + (now.w - last.w) / 2, ty: p.ty + (now.h - last.h) / 2 } : p));
      last = now;
    });
    ro.observe(hostRef.current!);
    return () => ro.disconnect();
  }, []);

  const uvAt = (clientX: number, clientY: number): [number, number] | null => {
    const p = xfRef.current;
    const r = hostRef.current?.getBoundingClientRect();
    if (!p || !r) return null;
    const u = Math.floor((clientX - r.left - p.tx) / p.zoom);
    const v = Math.floor((clientY - r.top - p.ty) / p.zoom);
    return u >= 0 && v >= 0 && u < W && v < H ? [u, v] : null;
  };
  const press = useRef<{ x: number; y: number; pan: boolean; tx: number; ty: number; id: number } | null>(null);

  const [cu, cv] = toPlane(axis, cursor);
  const partial = !!scope && scope.axis !== axis && (scope.lo > 0 || scope.hi < axisLen(vol, scope.axis) - 1);
  const vertical = !!scope && (axis === 'y' ? scope.axis === 'z' : scope.axis === 'y');
  const frame = { fill: 'var(--c-primary)', fillOpacity: 0.06, stroke: 'var(--c-primary)', strokeWidth: 1, strokeDasharray: '4 3', vectorEffect: 'non-scaling-stroke' } as const;
  const sb = selBox ? boxInPlane(axis, selBox) : null;

  return (
    <div
      className="sedit"
      ref={hostRef}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const p = xfRef.current;
        if (!p) return;
        const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (space.current || e.altKey));
        if (e.button !== 0 && !pan) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { x: e.clientX, y: e.clientY, pan, tx: p.tx, ty: p.ty, id: e.pointerId };
        if (pan) e.currentTarget.style.cursor = 'grabbing';
      }}
      onPointerMove={(e) => {
        const pr = press.current;
        if (pr?.pan) {
          setXf((p) => (p ? { ...p, tx: pr.tx + e.clientX - pr.x, ty: pr.ty + e.clientY - pr.y } : p));
          return;
        }
        const uv = uvAt(e.clientX, e.clientY);
        setHoverUV(uv);
        onHover?.(uv ? toVoxel(uv[0], uv[1]) : null);
      }}
      onPointerUp={(e) => {
        const pr = press.current;
        press.current = null;
        e.currentTarget.style.cursor = space.current ? 'grab' : '';
        if (!pr || pr.pan) return;
        if (Math.hypot(e.clientX - pr.x, e.clientY - pr.y) >= CLICK_PX) return;
        const uv = uvAt(e.clientX, e.clientY);
        if (uv) onPick(toVoxel(uv[0], uv[1]), selectModeOf(e));
      }}
      onPointerLeave={() => {
        setHoverUV(null);
        onHover?.(null);
      }}
      onDoubleClick={(e) => {
        // 雙擊空白（空氣或圖外）＝適合視窗
        const uv = uvAt(e.clientX, e.clientY);
        if (!uv) return fit();
        const [x, y, z] = toVoxel(uv[0], uv[1]);
        if (!vol.data[(z * vol.Y + y) * vol.X + x]) fit();
      }}
    >
      {/* canvas 一直是同一個元素（畫圖的 effect 只跑在它上面），還沒量好大小前先藏起來 */}
      <div className="sedit-img" style={xf ? { left: xf.tx, top: xf.ty, width: W * xf.zoom, height: H * xf.zoom } : { visibility: 'hidden' }}>
          <canvas ref={canvasRef} />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {partial &&
              (vertical ? (
                <rect x={0} y={scope!.lo} width={W} height={scope!.hi - scope!.lo + 1} {...frame} />
              ) : (
                <rect x={scope!.lo} y={0} width={scope!.hi - scope!.lo + 1} height={H} {...frame} />
              ))}
            {sb && (
              <rect
                x={sb.u0}
                y={sb.v0}
                width={sb.u1 - sb.u0 + 1}
                height={sb.v1 - sb.v0 + 1}
                fill="none"
                stroke="var(--c-primary)"
                strokeOpacity={0.6}
                strokeWidth={1}
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            )}
            <line x1={cu + 0.5} y1={0} x2={cu + 0.5} y2={H} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <line x1={0} y1={cv + 0.5} x2={W} y2={cv + 0.5} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            {hoverUV && xf && xf.zoom >= 4 && (
              <rect x={hoverUV[0]} y={hoverUV[1]} width={1} height={1} fill="none" stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
          </svg>
      </div>
      <div className="sedit-zoombar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span className="sedit-zoom">{xf ? `${xf.zoom >= 10 ? xf.zoom.toFixed(0) : xf.zoom.toFixed(1)}×` : ''}</span>
        <Tooltip title="1 voxel = 1 px">
          <Button size="small" type="text" onClick={() => zoomAt(1)}>
            1:1
          </Button>
        </Tooltip>
        <Tooltip title="1 voxel = 8 px">
          <Button size="small" type="text" onClick={() => zoomAt(8)}>
            8×
          </Button>
        </Tooltip>
        <Tooltip title="整張切面放進視窗（雙擊空白也可以）">
          <Button size="small" type="text" icon={<ExpandOutlined />} onClick={fit}>
            適合
          </Button>
        </Tooltip>
        <Tooltip title="放大到選取的結構">
          <Button size="small" type="text" icon={<AimOutlined />} disabled={!selBox} onClick={aim}>
            對準選取
          </Button>
        </Tooltip>
      </div>
      <div className="sedit-hint">滾輪縮放 · 右鍵拖或空白鍵＋拖平移 · Ctrl＋滾輪、<kbd>,</kbd> <kbd>.</kbd> 換片 · 雙擊空白＝適合視窗</div>
    </div>
  );
}
