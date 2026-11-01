// 實驗頁設計區第 1 步：選結構＋結構預覽。
// 預覽可以換視角（自動／XY／XZ／YZ）、沿法線拖切片，上面用每個變數的顏色標出它會動到的地方
// （CD＝雙箭頭、長／縮＝那一面＋箭頭、圓頭＝兩個角、保形＝外圈虛線、缺陷＝那一塊…），
// 所以看得出來「這個變數到底改哪裡」；「在 3D 看」切到編輯頁並對準這個結構。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Segmented, Select, Slider, Tooltip, Typography } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Vec3, hexToRgb, unionBBox } from '../../volume/volume';
import type { Factor } from '../../volume/factors';
import type { Editor, Split } from './editor';
import { slabOf } from './slabs';
import { autoAxis, structThumbRGBA, thumbCrop, thumbScale } from './thumbs';
import { usePersisted } from '../../ui/persist';
import { Resizer } from '../../ui/Resizer';

const { Text } = Typography;
const AXN: Record<Axis, string> = { z: 'XY', y: 'XZ', x: 'YZ' };
const AXI: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const AXL = ['x', 'y', 'z'] as const;
const uvAxes = (axis: Axis): [0 | 1 | 2, 0 | 1 | 2] => (axis === 'z' ? [0, 1] : axis === 'y' ? [0, 2] : [2, 1]);
const lo = (b: BBox) => [b.x0, b.y0, b.z0];
const hi = (b: BBox) => [b.x1, b.y1, b.z1];

/** 預覽上要標的變數（顏色＝變數卡的色帶）。 */
export interface Mark {
  f: Factor;
  color: string;
  /** 滑過卡片＝這個標記加粗。 */
  hot?: boolean;
}

/** 在預覽上畫變數的標記：回傳畫不出來（垂直於切面）的那些的說明。 */
function drawMarks(g: CanvasRenderingContext2D, W: number, H: number, axis: Axis, crop: { u0: number; v0: number }, s: number, box: BBox, marks: Mark[]) {
  const [ua, va] = uvAxes(axis);
  const l = lo(box);
  const h = hi(box);
  const X = (u: number) => (u - crop.u0) * s;
  const Y = (v: number) => (v - crop.v0) * s;
  const x0 = X(l[ua]);
  const x1 = X(h[ua] + 1);
  const y0 = Y(l[va]);
  const y1 = Y(h[va] + 1);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  g.clearRect(0, 0, W, H);
  g.font = '600 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, "PingFang TC", "Noto Sans TC", sans-serif';
  g.textBaseline = 'middle';
  const used: { x: number; y: number; w: number }[] = [];
  const label = (text: string, x: number, y: number, color: string, align: CanvasTextAlign = 'left') => {
    const w = g.measureText(text).width + 10;
    let yy = y;
    // 標籤撞到就往下挪
    for (let i = 0; i < 6; i++) if (used.some((u) => Math.abs(u.y - yy) < 16 && x < u.x + u.w && x + w > u.x)) yy += 16;
    const xx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    const px = Math.min(Math.max(2, xx), W - w - 2);
    const py = Math.min(Math.max(9, yy), H - 9);
    g.fillStyle = 'rgba(255,255,255,.92)';
    g.beginPath();
    g.roundRect(px, py - 8, w, 16, 4);
    g.fill();
    g.fillStyle = color;
    g.textAlign = 'left';
    g.fillText(text, px + 5, py + 0.5);
    used.push({ x: px, y: py, w });
  };
  const arrow = (x: number, y: number, dx: number, dy: number, color: string, len = 14) => {
    const nx = dx / Math.hypot(dx, dy);
    const ny = dy / Math.hypot(dx, dy);
    const ex = x + nx * len;
    const ey = y + ny * len;
    g.strokeStyle = color;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(ex, ey);
    g.moveTo(ex, ey);
    g.lineTo(ex - nx * 5 - ny * 4, ey - ny * 5 + nx * 4);
    g.moveTo(ex, ey);
    g.lineTo(ex - nx * 5 + ny * 4, ey - ny * 5 - nx * 4);
    g.stroke();
  };
  const dashed = (color: string, pad = 0) => {
    g.save();
    g.setLineDash([4, 3]);
    g.strokeStyle = color;
    g.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
    g.restore();
  };
  const out: string[] = [];
  for (const m of marks) {
    const { f, color } = m;
    const t = f.template;
    const name = f.name || f.id;
    g.lineWidth = m.hot ? 3 : 2;
    g.strokeStyle = color;
    g.fillStyle = color;
    const perp = (a: number) => a !== ua && a !== va;
    switch (f.op) {
      case 'cd': {
        const a = (t.axis as number) ?? 0;
        if (perp(a)) {
          dashed(color);
          out.push(`${name}：沿 ${AXL[a]}，垂直於這個切面（換 ${a === 0 ? 'XY 或 XZ' : a === 1 ? 'XY 或 YZ' : 'XZ 或 YZ'} 看）`);
          break;
        }
        if (a === ua) {
          g.beginPath();
          g.moveTo(x0, cy);
          g.lineTo(x1, cy);
          g.stroke();
          arrow(x0 + 8, cy, -1, 0, color, 8);
          arrow(x1 - 8, cy, 1, 0, color, 8);
          label(`${name} 寬度 ↔`, cx, cy - 14, color, 'center');
        } else {
          g.beginPath();
          g.moveTo(cx, y0);
          g.lineTo(cx, y1);
          g.stroke();
          arrow(cx, y0 + 8, 0, -1, color, 8);
          arrow(cx, y1 - 8, 0, 1, color, 8);
          label(`${name} 寬度 ↕`, cx + 8, cy, color);
        }
        break;
      }
      case 'push':
      case 'level':
      case 'taper': {
        const d = ((f.op === 'taper' ? t.face : t.dir) as Vec3) ?? [0, -1, 0];
        const a = d[0] ? 0 : d[1] ? 1 : 2;
        if (perp(a)) {
          dashed(color);
          out.push(`${name}：那一面垂直於這個切面（換個視角看）`);
          break;
        }
        const pos = d[a] > 0;
        g.lineWidth = m.hot ? 4 : 3;
        g.beginPath();
        if (a === ua) {
          const x = pos ? x1 : x0;
          g.moveTo(x, y0);
          g.lineTo(x, y1);
          g.stroke();
          if (f.op !== 'taper') arrow(x, cy, pos ? 1 : -1, 0, color);
          label(`${name} ${f.op === 'push' ? '長／縮' : f.op === 'level' ? '方頭' : '側壁斜度'}`, pos ? x + 18 : x - 18, cy, color, pos ? 'left' : 'right');
        } else {
          const y = pos ? y1 : y0;
          g.moveTo(x0, y);
          g.lineTo(x1, y);
          g.stroke();
          if (f.op !== 'taper') arrow(cx, y, 0, pos ? 1 : -1, color);
          label(`${name} ${f.op === 'push' ? '長／縮' : f.op === 'level' ? '方頭到' : '側壁斜度'}`, cx, pos ? y + 22 : y - 22, color, 'center');
        }
        break;
      }
      case 'round': {
        // 頂端兩角（體素 y 小的那一側）
        if (va !== 1) {
          dashed(color);
          out.push(`${name}：圓角在頂端，換 XY 或 YZ 看`);
          break;
        }
        const r = Math.min(14, (x1 - x0) / 3, (y1 - y0) / 3);
        g.beginPath();
        g.moveTo(x0, y0 + r);
        g.arcTo(x0, y0, x0 + r, y0, r);
        g.moveTo(x1 - r, y0);
        g.arcTo(x1, y0, x1, y0 + r, r);
        g.stroke();
        label(`${name} 圓角 r`, cx, y0 - 12, color, 'center');
        break;
      }
      case 'dilate':
        dashed(color, 5);
        label(`${name} 整層厚度`, x1 + 8, y0 + 8, color);
        break;
      case 'translate': {
        const a = (t.axis as number) ?? 0;
        if (perp(a)) {
          dashed(color);
          out.push(`${name}：沿 ${AXL[a]} 移動，垂直於這個切面`);
          break;
        }
        if (a === ua) {
          arrow(cx - 10, cy, 1, 0, color, 20);
          arrow(cx + 10, cy, -1, 0, color, 20);
          label(`${name} 移動 ↔`, cx, cy + 16, color, 'center');
        } else {
          arrow(cx, cy - 10, 0, 1, color, 20);
          arrow(cx, cy + 10, 0, -1, color, 20);
          label(`${name} 移動 ↕`, cx + 8, cy, color);
        }
        break;
      }
      case 'defect': {
        const c = (t.center as Vec3) ?? [0.5, 0.5, 0.5];
        const sz = (t.size as Vec3) ?? [1, 1, 1];
        const dim = [h[0] - l[0] + 1, h[1] - l[1] + 1, h[2] - l[2] + 1];
        const px = X(l[ua] + c[ua] * dim[ua]);
        const py = Y(l[va] + c[va] * dim[va]);
        const pw = Math.max(3, sz[ua] * s);
        const ph = Math.max(3, sz[va] * s);
        g.save();
        g.globalAlpha = 0.35;
        g.fillRect(px - pw / 2, py - ph / 2, pw, ph);
        g.restore();
        g.strokeRect(px - pw / 2, py - ph / 2, pw, ph);
        label(`${name} 缺陷`, px + pw / 2 + 6, py, color);
        break;
      }
    }
  }
  return out;
}

/** 預覽舞台高度的範圍（px）；拖底下那條線改，記在 localStorage。 */
const STAGE_MIN = 140;
const STAGE_MAX = 560;

/**
 * start（plan v14 §5.5）：「從哪裡開始」選的那個 split（null＝原始）——縮圖畫的是產生時真正要算的那個底；沒給＝目前的 split。
 */
export function StructPreview({ ed, keys, face, marks: allMarks, onOpen3D, start }: { ed: Editor; keys: string[]; face?: Vec3 | null; marks: Mark[]; onOpen3D?: () => void; start?: Split | null }) {
  const img = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = usePersisted('labPreviewH', 220, (v): v is number => typeof v === 'number' && v >= STAGE_MIN && v <= STAGE_MAX);
  // 舞台的內寬：欄寬拖了就跟著變（ResizeObserver）
  const [stageW, setStageW] = useState(372);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setStageW(Math.max(80, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [keys.length > 0]);
  const maxW = stageW;
  const maxH = stageH - 16;
  const [axisMode, setAxisMode] = useState<'auto' | Axis>('auto');
  const [atBy, setAtBy] = useState<Partial<Record<Axis, number>>>({});
  const [notes, setNotes] = useState<string[]>([]);
  // 舞台在畫面上才畫（plan v14 P7）：捲出去、被收起時不重畫
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = stage.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [keys.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = start === undefined ? ed.active : start;
  const L = ed.L;
  // 外框用數字當 key：每一步編輯 L 都換，外框沒變就不必重畫
  const box0 = unionBBox(L.comps.filter((c) => keys.includes(c.key)));
  const boxSig = box0 ? `${box0.x0},${box0.y0},${box0.z0},${box0.x1},${box0.y1},${box0.z1}` : '';
  const box = useMemo(() => box0, [boxSig]); // eslint-disable-line react-hooks/exhaustive-deps
  // 只標和目前選取有關的變數（plan v14 §5.5）
  const marks = useMemo(() => allMarks.filter((m) => m.f.keys.some((k) => keys.includes(k))), [allMarks, keys]);
  const rgb = useMemo(() => new Map(ed.materials.map((m) => [m.id, hexToRgb(m.color)])), [ed.materials]);
  const axis: Axis = axisMode === 'auto' ? (autoAxis(box) ?? 'z') : axisMode;
  const a = AXI[axis];
  const range: [number, number] = box ? [lo(box)[a], hi(box)[a]] : [0, 0];
  // 切片：使用者自己拖過就照拖的，否則跟著十字（plan v14 §5.5）
  const at = Math.min(range[1], Math.max(range[0], atBy[axis] ?? ed.cursor[a]));
  const marksSig = marks.map((m) => `${m.f.id}|${m.f.op}|${JSON.stringify(m.f.template)}|${m.color}|${m.hot ? 1 : 0}`).join(';');

  useEffect(() => {
    const cv = img.current;
    const ov = over.current;
    if (!cv || !ov || !box || !visible) return;
    const slab = slabOf(ed.orig, base, axis, at);
    // slab 的編號是那個狀態自己的（原始和目前的 split 不同）：用 key 對
    const on = new Set(slab.L.comps.flatMap((c, i) => (keys.includes(c.key) ? [i] : [])));
    const crop = thumbCrop(axis, [box], ed.vol, 10);
    // 倍率：塞進舞台（寬、高都不超過），且最多 8 倍；structThumbRGBA 只吃「長邊上限」，換算回去
    const CW = crop.u1 - crop.u0 + 1;
    const CH = crop.v1 - crop.v0 + 1;
    const s = Math.min(8, maxW / CW, maxH / CH);
    const max = s * Math.max(CW, CH);
    const pic = structThumbRGBA(slab, crop, rgb, ed.hidden, on, box, face ?? null, max);
    cv.width = pic.W;
    cv.height = pic.H;
    cv.getContext('2d')!.putImageData(new ImageData(pic.data, pic.W, pic.H), 0, 0);
    ov.width = pic.W;
    ov.height = pic.H;
    setNotes(drawMarks(ov.getContext('2d')!, pic.W, pic.H, axis, crop, thumbScale(crop, max), box, marks));
    // marks 的內容走 marksSig
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box, rgb, ed.hidden, face, ed.orig, base, ed.vol, keys, maxW, maxH, axis, at, marksSig, visible]);

  if (!box)
    return (
      <div className="sp-empty">
        <span>選了結構，這裡會顯示它的截面，並標出每個變數會改的地方</span>
      </div>
    );
  return (
    <div className="struct-preview">
      <div className="sp-bar">
        <span className="sp-bar-label">視角</span>
        <Segmented
          size="small"
          value={axisMode}
          onChange={(v) => setAxisMode(v as 'auto' | Axis)}
          options={[
            { value: 'auto', label: '自動' },
            { value: 'z', label: 'XY' },
            { value: 'y', label: 'XZ' },
            { value: 'x', label: 'YZ' },
          ]}
          aria-label="預覽視角"
        />
        <span className="grow" />
        {onOpen3D && (
          <Tooltip title="切到編輯頁，3D 對準這個結構（Ctrl+1 回來）">
            <Button size="small" type="text" icon={<EyeOutlined />} onClick={onOpen3D} className="sp-3d">
              在 3D 看
            </Button>
          </Tooltip>
        )}
      </div>
      <div className="sp-stage" ref={stage} style={{ height: stageH }}>
        <div className="sp-canvas">
          <canvas ref={img} aria-label="結構截面" />
          <canvas ref={over} className="sp-over" aria-hidden />
        </div>
      </div>
      <Resizer horizontal label="預覽高度" value={stageH} min={STAGE_MIN} max={STAGE_MAX} onDrag={(dy) => setStageH((h) => Math.max(STAGE_MIN, Math.min(STAGE_MAX, h + dy)))} />
      <div className="sp-slice">
        <span className="sp-slice-label">
          切片 {axis} = <b>{at}</b>
        </span>
        <Slider
          min={range[0]}
          max={range[1]}
          value={at}
          onChange={(v) => setAtBy((p) => ({ ...p, [axis]: v }))}
          tooltip={{ formatter: (v) => `${axis} = ${v}` }}
          disabled={range[0] === range[1]}
          aria-label={`切片位置（${axis}）`}
          style={{ flex: 1, margin: '0 6px' }}
        />
        <span className="sp-slice-range">
          {range[0]}～{range[1]}
        </span>
      </div>
      <div className="sp-cap">
        <span className="sp-sw sel" />
        選到的結構 <span className="sp-sw other" />其他材質（淡化）· {AXN[axis]} 截面
        {marks.length > 0 && (
          <>
            {' '}
            · 彩色＝各變數會改的地方
          </>
        )}
      </div>
      {notes.length > 0 && (
        <ul className="sp-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StructurePicker({ ed, face, marks, onOpen3D, start }: { ed: Editor; face?: Vec3 | null; marks: Mark[]; onOpen3D?: () => void; start?: Split | null }) {
  const keys = useMemo(() => [...ed.sel], [ed.sel]);
  const options = useMemo(() => {
    const byMat = new Map<number, typeof ed.comps>();
    for (const c of ed.comps) {
      if (ed.hidden.has(c.mat)) continue;
      byMat.set(c.mat, [...(byMat.get(c.mat) ?? []), c]);
    }
    return [...byMat.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([mat, cs]) => ({
        label: ed.matName(mat),
        title: ed.matName(mat),
        options: cs.map((c) => {
          const b = c.bbox;
          return { value: c.key, label: c.label, desc: `${b.x1 - b.x0 + 1}×${b.y1 - b.y0 + 1}×${b.z1 - b.z0 + 1} · ${c.count.toLocaleString()} 格` };
        }),
      }));
  }, [ed.comps, ed.hidden, ed.matName]);
  const picked = keys.map((k) => ed.comps.find((c) => c.key === k)).filter((c) => !!c);
  const dims = picked.length === 1 ? picked[0].bbox : null;
  return (
    <div className="struct-pick">
      <Select
        mode="multiple"
        size="middle"
        style={{ width: '100%' }}
        placeholder="選一個結構（依材質分組；也可以在編輯頁點）"
        value={keys}
        onChange={(v) => ed.selectKeys(v as string[])}
        options={options}
        optionRender={(o) => (
          <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>{o.label}</span>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {(o.data as { desc?: string }).desc}
            </Text>
          </span>
        )}
        maxTagCount={3}
        showSearch
        optionFilterProp="label"
        aria-label="結構"
      />
      <Text type="secondary" className="dp-hint">
        {dims
          ? `${dims.x1 - dims.x0 + 1} × ${dims.y1 - dims.y0 + 1} × ${dims.z1 - dims.z0 + 1} 格 · ${picked[0].count.toLocaleString()} 格 · 和編輯頁的選取同步`
          : keys.length
            ? `${keys.length} 個結構會一起改 · 和編輯頁的選取同步`
            : '可以多選；和編輯頁的選取同步'}
      </Text>
      <StructPreview ed={ed} keys={keys} face={face} marks={marks} onOpen3D={keys.length ? onOpen3D : undefined} start={start} />
    </div>
  );
}
