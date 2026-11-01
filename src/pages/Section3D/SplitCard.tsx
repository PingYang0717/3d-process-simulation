// 結果區的一張卡（plan v12 §5.4）：縮圖、名字、水平 chips（同設計的變數同色點）、Δ 改動、被擋、tags、live／parked、核取方塊。
// 點卡片＝高亮（純 UI：不 restore、不切 3D、不送 Worker）；Shift／Ctrl＋點＝勾選；雙擊／Enter／「在 3D 看」＝設為目前並切到編輯頁。
// React.memo：props 只有 split（物件身分只在它自己改了才換）、旗標、縮圖軸與畫法簽名；在實驗頁移動滑鼠不會重畫卡片。
import { memo, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { type Axis, type BBox, type Comp, type Material, type Vec3, unionBBox } from '../../volume/volume';
import type { EditState } from '../../volume/ops';
import type { Factor } from '../../volume/factors';
import { busiestSlice, patchSliceCounts, sliceCounts } from '../../splits/lifecycle';
import { type Split, statsOf } from './editor';
import { levelCell } from './matrix';
import { CATEGORY } from './colors';
import { StateDot } from './SplitPicker';
import { contourCache, contourOf, overlayKey } from './overlay';
import { slabOf, versionOf } from './slabs';
import { thumbAt, thumbCached, thumbCrop, thumbRGBA, thumbStore, unionBoxes } from './thumbs';
import { sidOf } from '../../volume/client';

const { Text } = Typography;
const AXN: Record<Axis, string> = { z: 'XY', y: 'XZ', x: 'YZ' };
const loopsCache = contourCache(600);

/** 這個 split 改到的結構（ops 的 keys）。 */
export const keysOfSplit = (s: Split) => [...new Set(s.ops.flatMap((o) => o.keys))];
/** 改到的結構的外框（原始與現在的聯集）。 */
export function structBoxOf(orig: EditState, s: Split, extraKeys: string[] = []): BBox | null {
  const keys = new Set([...keysOfSplit(s), ...extraKeys]);
  const pick = (cs: Comp[]) => unionBBox(cs.filter((c) => keys.has(c.key)));
  return unionBoxes([pick(orig.L.comps), pick(s.cur.L.comps)]);
}

/** 縮圖的片：改最多的那一片（parked 掃補丁、live 掃 diff；只在 diff 外框裡）；沒改就結構中點。 */
export function thumbSliceOf(orig: EditState, s: Split, axis: Axis, structBox: BBox | null): number {
  const dims = orig.vol;
  const st = statsOf(s, null);
  let at: number | null = null;
  if (st.diffBox) {
    if (s.state === 'parked' && s.patch) at = busiestSlice(patchSliceCounts(dims, s.patch, orig.vol.data, axis));
    else if (s.buf) {
      const d = s.buf.diff;
      at = busiestSlice(sliceCounts(dims, st.diffBox, axis, (i) => d[i] === 1));
    }
  }
  return at ?? thumbAt(axis, st.diffBox, structBox, dims);
}

/** 縮圖排隊：一次畫一張、每張之間讓出主執行緒（捲動不掉幀）。 */
const queue: (() => void)[] = [];
let pumping = false;
const pump = () => {
  const job = queue.shift();
  if (!job) {
    pumping = false;
    return;
  }
  job();
  setTimeout(pump, 0);
};
const enqueue = (job: () => void) => {
  queue.push(job);
  if (!pumping) {
    pumping = true;
    setTimeout(pump, 0);
  }
};

/** 一張縮圖（進視窗才畫；畫好的 ImageBitmap 以 (版本, 軸, 畫法) 快取）。 */
function Thumb({ orig, split, axis, rgb, hidden, look, keys }: { orig: EditState; split: Split; axis: Axis; rgb: Map<number, Vec3>; hidden: Set<number>; look: string; keys: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [label, setLabel] = useState('');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const key = `${versionOf(orig, split)}|${sidOf(orig)}|${axis}|${look}`;
    const draw = (b: ImageBitmap | HTMLCanvasElement, text: string) => {
      const cv = ref.current;
      if (!cv) return;
      cv.width = b.width;
      cv.height = b.height;
      cv.getContext('2d')!.drawImage(b, 0, 0);
      setLabel(text);
    };
    const hit = thumbCached(key) as (ImageBitmap & { label?: string }) | undefined;
    if (hit) return draw(hit, hit.label ?? '');
    let dead = false;
    enqueue(() => {
      if (dead) return;
      const sb = structBoxOf(orig, split, keys);
      const at = thumbSliceOf(orig, split, axis, sb);
      const slab = slabOf(orig, split, axis, at);
      const o = slabOf(orig, null, axis, at);
      const ks = keysOfSplit(split).length ? keysOfSplit(split) : keys;
      const loops = loopsCache.get(overlayKey(sidOf(orig), axis, at, ks), () => contourOf(o.L, o.vol, ks, axis, 0));
      const st = statsOf(split, null);
      const img = thumbRGBA(slab, thumbCrop(axis, [st.diffBox, sb], orig.vol), rgb, hidden, loops);
      const text = `${AXN[axis]} · ${axis}=${at}`;
      const c = document.createElement('canvas');
      c.width = img.W;
      c.height = img.H;
      c.getContext('2d')!.putImageData(new ImageData(img.data, img.W, img.H), 0, 0);
      (c as HTMLCanvasElement & { label?: string }).label = text;
      thumbStore(key, c);
      if (!dead) draw(c, text);
    });
    return () => {
      dead = true;
    };
  }, [visible, orig, split, axis, rgb, hidden, look, keys]);
  return (
    <div className="sc-thumb">
      <canvas ref={ref} aria-label={`${split.name} 縮圖`} />
      {label && <span className="sc-axis">{label}</span>}
    </div>
  );
}

export interface CardApi {
  highlight: (id: string) => void;
  toggle: (id: string, on?: boolean) => void;
  open3D: (id: string) => void;
  rename: (id: string) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
}

export const SplitCard = memo(function SplitCard({
  split,
  orig,
  axis,
  factors,
  fIndex,
  rgb,
  hidden,
  look,
  keys,
  materials: _m,
  nm,
  hi,
  checked,
  current,
  api,
}: {
  split: Split;
  orig: EditState;
  axis: Axis;
  factors: Factor[];
  fIndex: Map<string, number>;
  rgb: Map<number, Vec3>;
  hidden: Set<number>;
  look: string;
  keys: string[];
  materials: Material[];
  nm: number;
  hi: boolean;
  checked: boolean;
  current: boolean;
  api: CardApi;
}) {
  if (import.meta.env.DEV) (window as unknown as { __cardRenders?: number }).__cardRenders = ((window as unknown as { __cardRenders?: number }).__cardRenders ?? 0) + 1;
  const st = statsOf(split, null);
  const control = !st.changed;
  return (
    <div
      className={'split-card' + (hi ? ' hi' : '') + (checked ? ' checked' : '') + (current ? ' current' : '')}
      tabIndex={0}
      role="gridcell"
      aria-selected={checked}
      data-id={split.id}
      onClick={(e) => (e.shiftKey || e.ctrlKey || e.metaKey ? api.toggle(split.id) : api.highlight(split.id))}
      onDoubleClick={() => api.open3D(split.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') api.open3D(split.id);
        else if (e.key === ' ') {
          e.preventDefault();
          api.toggle(split.id);
        }
      }}
    >
      <Thumb orig={orig} split={split} axis={axis} rgb={rgb} hidden={hidden} look={look} keys={keys} />
      <div className="sc-body">
        <div className="sc-title">
          <Checkbox checked={checked} onClick={(e) => e.stopPropagation()} onChange={(e) => api.toggle(split.id, e.target.checked)} aria-label={`勾選 ${split.name}`} />
          <StateDot s={split} />
          <Tooltip title={split.name}>
            <span className="sc-name">{split.name}</span>
          </Tooltip>
          {current && (
            <Tag color="blue" bordered={false} className="mini-tag">
              目前
            </Tag>
          )}
        </div>
        <div className="sc-chips">
          {factors
            .filter((f) => split.levels?.[f.id] !== undefined)
            .map((f) => {
              const c = levelCell(f, split.levels![f.id], nm)!;
              return (
                <span key={f.id} className="lv-chip" title={`${f.name || f.id} = ${c.main}（${c.sub}）`}>
                  <span className="factor-dot" style={{ background: CATEGORY[(fIndex.get(f.id) ?? 0) % CATEGORY.length] }} />
                  {c.nominal ? '標稱' : c.main}
                </span>
              );
            })}
        </div>
        <div className="sc-stats">
          {control ? <Text type="secondary">對照組（不改動）</Text> : <span>Δ {st.changed.toLocaleString()} vx</span>}
          {!!split.blocked && <Text type="warning">被擋 {split.blocked.toLocaleString()}</Text>}
          {(split.tags ?? []).map((t) => (
            <Tag key={t} bordered={false} className="mini-tag">
              {t}
            </Tag>
          ))}
        </div>
        <div className="sc-acts">
          <Button size="small" type="link" icon={<EyeOutlined />} onClick={(e) => (e.stopPropagation(), api.open3D(split.id))}>
            在 3D 看
          </Button>
          <span className="grow" />
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'edit', icon: <EyeOutlined />, label: '接著改（在 3D 看）', onClick: ({ domEvent }) => (domEvent.stopPropagation(), api.open3D(split.id)) },
                { key: 'rename', icon: <EditOutlined />, label: '重新命名', onClick: ({ domEvent }) => (domEvent.stopPropagation(), api.rename(split.id)) },
                { key: 'dup', icon: <CopyOutlined />, label: '複製', onClick: ({ domEvent }) => (domEvent.stopPropagation(), api.duplicate(split.id)) },
                { key: 'del', icon: <DeleteOutlined />, danger: true, label: '刪除', onClick: ({ domEvent }) => (domEvent.stopPropagation(), api.remove(split.id)) },
              ],
            }}
          >
            <Button size="small" type="text" onClick={(e) => e.stopPropagation()} aria-label={`${split.name} 更多操作`}>
              ⋯
            </Button>
          </Dropdown>
        </div>
      </div>
    </div>
  );
});
