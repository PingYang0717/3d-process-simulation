// 主切面的預覽層（plan v8 §8.2）：和底圖同尺寸的另一張 canvas，只重畫預覽外框那一塊（putImageData 局部）。
// 底圖（drawSlice）只在 vol／片／顏色／隱藏改變時重畫，拖拉中不動。
// 拖拉中：改到的格子畫成結果的材質色，再疊淡綠（會加）、淡紅（會拿）；放開後等 Worker 時只畫結果的材質色。
import { useEffect, useRef } from 'react';
import type { Axis, Vec3, Volume } from '../../volume/volume';
import type { Preview } from '../../volume/preview';
import { axisIndex, planeAxes } from '../../volume/scope';

export type SlicePreview = Preview & { committed?: boolean; blocked?: number[] };

const ADD: Vec3 = [82, 196, 26];
const REMOVE: Vec3 = [255, 77, 79];
const TINT = 0.5;

export function SlicePreviewLayer({
  vol,
  axis,
  at,
  W,
  H,
  preview,
  selMask,
  rgb,
  hidden,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  W: number;
  H: number;
  preview: SlicePreview | null | undefined;
  /** 選取 ∩ 範圍：改到的格子原本是選取的＝拿，否則＝加。 */
  selMask: Uint8Array | null;
  rgb: Map<number, Vec3>;
  hidden: Set<number>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
      last.current = null;
    }
    const g = c.getContext('2d')!;
    // 只清上一次畫過的那一塊
    if (last.current) g.clearRect(last.current.x, last.current.y, last.current.w, last.current.h);
    last.current = null;
    const p = preview;
    if (!p) return;
    const a = axisIndex(axis);
    const [ua, va] = planeAxes(axis);
    const lo = [p.box.x0, p.box.y0, p.box.z0];
    const hi = [p.box.x1, p.box.y1, p.box.z1];
    if (at < lo[a] || at > hi[a]) return;
    const bx = p.box.x1 - p.box.x0 + 1;
    const by = p.box.y1 - p.box.y0 + 1;
    const w = hi[ua] - lo[ua] + 1;
    const h = hi[va] - lo[va] + 1;
    const img = g.createImageData(w, h);
    const q = [0, 0, 0];
    q[a] = at;
    let any = false;
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++) {
        q[ua] = u + lo[ua];
        q[va] = v + lo[va];
        const gi = (q[2] * vol.Y + q[1]) * vol.X + q[0];
        const li = ((q[2] - p.box.z0) * by + (q[1] - p.box.y0)) * bx + (q[0] - p.box.x0);
        const m = p.data[li];
        if (m === vol.data[gi]) continue;
        any = true;
        const base = hidden.has(m) ? ([245, 245, 245] as Vec3) : (rgb.get(m) ?? ([255, 0, 255] as Vec3));
        const tint = p.committed ? null : selMask?.[gi] ? REMOVE : ADD;
        const o = (v * w + u) * 4;
        for (let k = 0; k < 3; k++) img.data[o + k] = tint ? Math.round(base[k] * (1 - TINT) + tint[k] * TINT) : base[k];
        img.data[o + 3] = 255;
      }
    if (!any) return;
    g.putImageData(img, lo[ua], lo[va]);
    last.current = { x: lo[ua], y: lo[va], w, h };
  }, [vol, axis, at, W, H, preview, selMask, rgb, hidden]);
  return <canvas ref={ref} className="sedit-pv" />;
}
