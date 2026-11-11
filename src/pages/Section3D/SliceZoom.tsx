// 放大的切面（plan v18 §3.2）：唯讀。滾輪縮放、拖拉平移、右下角縮放列；點一下＝選結構。
// 視圖變換搬自完整版的 SliceEditor；節點、把手、手勢都沒有。畫的東西和小切面（SliceView）相同。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Tooltip } from 'antd';
import { AimOutlined, ExpandOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Material, type Vec3, type Volume, hexToRgb } from '../../volume/volume';
import type { Scope } from '../../volume/scope';
import type { Preview } from '../../volume/preview';
import { drawSlice, sliceSize } from './drawSlice';
import { SlicePreviewLayer } from './SlicePreviewLayer';
import { SliceOverlay } from './SliceOverlay';
import { type SelectMode, selectModeOf } from './editor';
import { type ViewXf, aimXf, boxInPlane, fitXf, uvAtXf, zoomMemory, zoomXf } from './sliceXf';

/** 移動不到這麼多 px 算點一下（選取），超過算拖拉（平移）。 */
const CLICK_PX = 4;

export function SliceZoom({
  vol,
  axis,
  at,
  materials,
  hidden,
  selMask,
  cursor,
  scope,
  preview,
  selBox,
  onPick,
  onStep,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  materials: Material[];
  hidden: Set<number>;
  selMask: Uint8Array | null;
  cursor: Vec3;
  scope: Scope | null;
  preview?: Preview | null;
  /** 選取的外框（「對準選取」用；沒選＝null）。 */
  selBox: BBox | null;
  onPick: (p: Vec3, mode: SelectMode) => void;
  onStep: (delta: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [W, H] = sliceSize(vol, axis);
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);
  const toVoxel = (u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]);

  // 底圖不看預覽：拖箭頭時只重畫預覽層那一塊
  useEffect(() => {
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, null, null);
  }, [vol, axis, at, rgb, hidden, selMask]);

  const [xf, setXf] = useState<ViewXf | null>(null);
  const xfRef = useRef(xf);
  xfRef.current = xf;
  const size = () => {
    const r = hostRef.current?.getBoundingClientRect();
    return { w: r?.width || 1, h: r?.height || 1 };
  };
  const fit = useCallback(() => {
    const { w, h } = size();
    setXf(fitXf(w, h, W, H));
  }, [W, H]);
  const aim = () => {
    if (!selBox) return fit();
    const { w, h } = size();
    setXf(aimXf(w, h, boxInPlane(axis, selBox)));
  };
  /** 縮放到 zoom；沒給位置＝以視窗中心為準。 */
  const zoomAt = (zoom: number, px?: number, py?: number) =>
    setXf((p) => {
      if (!p) return p;
      const { w, h } = size();
      return zoomXf(p, zoom, px ?? w / 2, py ?? h / 2);
    });

  // 第一次：還原這個方向上次的縮放（還看得到圖才用），否則適合視窗
  useLayoutEffect(() => {
    const m = zoomMemory.get(axis);
    const { w, h } = size();
    if (m && m.tx < w && m.ty < h && m.tx + W * m.zoom > 0 && m.ty + H * m.zoom > 0) setXf(m);
    else fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [axis, W, H]);
  useEffect(() => {
    if (xf) zoomMemory.set(axis, xf);
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
  // 空白鍵按住：游標變成手（左鍵拖本來就是平移），也擋掉頁面捲動
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key !== ' ' || (e.target as HTMLElement | null)?.closest?.('input,textarea,select,button,[contenteditable]')) return;
      if (!hostRef.current?.matches(':hover')) return;
      e.preventDefault();
      hostRef.current.style.cursor = 'grab';
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ' && hostRef.current && !press.current) hostRef.current.style.cursor = '';
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  // 視窗、欄寬改變：畫面中心不動
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

  /** 滑鼠所在的體素（圖外＝null）。 */
  const voxelAt = (clientX: number, clientY: number): Vec3 | null => {
    const p = xfRef.current;
    const r = hostRef.current?.getBoundingClientRect();
    if (!p || !r) return null;
    const [u, v] = uvAtXf(p, clientX - r.left, clientY - r.top).map(Math.floor);
    return u >= 0 && v >= 0 && u < W && v < H ? toVoxel(u, v) : null;
  };
  const press = useRef<{ x: number; y: number; tx: number; ty: number; button: number; moved: boolean } | null>(null);

  return (
    <div
      className="sedit"
      ref={hostRef}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        const p = xfRef.current;
        if (!p || e.button > 2) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        press.current = { x: e.clientX, y: e.clientY, tx: p.tx, ty: p.ty, button: e.button, moved: false };
      }}
      onPointerMove={(e) => {
        const pr = press.current;
        if (!pr) return;
        const dx = e.clientX - pr.x;
        const dy = e.clientY - pr.y;
        if (!pr.moved && Math.hypot(dx, dy) < CLICK_PX) return;
        pr.moved = true;
        e.currentTarget.style.cursor = 'grabbing';
        setXf((p) => (p ? { ...p, tx: pr.tx + dx, ty: pr.ty + dy } : p));
      }}
      onPointerUp={(e) => {
        const pr = press.current;
        press.current = null;
        e.currentTarget.style.cursor = '';
        // 左鍵沒拖＝點一下：選結構、十字移過去
        if (!pr || pr.moved || pr.button !== 0) return;
        const p = voxelAt(e.clientX, e.clientY);
        if (p) onPick(p, selectModeOf(e));
      }}
      onPointerCancel={(e) => {
        press.current = null;
        e.currentTarget.style.cursor = '';
      }}
      onDoubleClick={(e) => {
        // 雙擊空白（空氣或圖外）＝適合視窗
        const p = voxelAt(e.clientX, e.clientY);
        if (!p || !vol.data[(p[2] * vol.Y + p[1]) * vol.X + p[0]]) fit();
      }}
    >
      {/* canvas 一直是同一個元素；還沒量好大小前先藏起來 */}
      <div className="sedit-img" style={xf ? { left: xf.tx, top: xf.ty, width: W * xf.zoom, height: H * xf.zoom } : { visibility: 'hidden' }}>
        <canvas ref={canvasRef} />
        <SlicePreviewLayer vol={vol} axis={axis} at={at} W={W} H={H} preview={preview} selMask={selMask} rgb={rgb} hidden={hidden} />
        <SliceOverlay vol={vol} axis={axis} W={W} H={H} cursor={cursor} scope={scope} />
      </div>
      <div className="sedit-zoombar" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <span className="sedit-zoom" aria-label="縮放倍率">
          {xf ? `${xf.zoom >= 10 ? xf.zoom.toFixed(0) : xf.zoom.toFixed(1)}×` : ''}
        </span>
        <Tooltip title="1 體素 = 1 px">
          <Button size="small" type="text" onClick={() => zoomAt(1)}>
            1:1
          </Button>
        </Tooltip>
        <Tooltip title="1 體素 = 8 px">
          <Button size="small" type="text" onClick={() => zoomAt(8)}>
            8×
          </Button>
        </Tooltip>
        <Tooltip title="整張切面放進視窗（雙擊空白也可以）">
          <Button size="small" type="text" icon={<ExpandOutlined />} onClick={fit}>
            適合
          </Button>
        </Tooltip>
        <Tooltip title={selBox ? '放大到選取的結構' : '先選一個結構'}>
          <Button size="small" type="text" icon={<AimOutlined />} disabled={!selBox} onClick={aim}>
            對準選取
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
