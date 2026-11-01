// 實驗頁設計區第 1 步（plan v12 §5.4）：選結構。目前的選取（和編輯頁同步）；沒有就在這裡選（依材質分組、列名字與大小）。
// 旁邊一張縮圖：和結果卡片同一種切法（垂直於結構最長軸的截面，例如 fin 看 XY 截面），結構用選取藍、其他淡掉；
// 六面小方塊滑過時那條邊亮橘色；下面寫「XY · z=191」。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Select, Typography } from 'antd';
import { type Axis, type Vec3, hexToRgb, unionBBox } from '../../volume/volume';
import type { Editor } from './editor';
import { slabOf } from './slabs';
import { autoAxis, structThumbRGBA, thumbAt, thumbCrop } from './thumbs';

const { Text } = Typography;
const AXN: Record<Axis, string> = { z: 'XY', y: 'XZ', x: 'YZ' };

export function StructThumb({ ed, keys, face, size = 112 }: { ed: Editor; keys: string[]; face?: Vec3 | null; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState('');
  const L = ed.L;
  const box = useMemo(() => unionBBox(L.comps.filter((c) => keys.includes(c.key))), [L, keys]);
  const rgb = useMemo(() => new Map(ed.materials.map((m) => [m.id, hexToRgb(m.color)])), [ed.materials]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !box) return;
    const axis = autoAxis(box) ?? 'z';
    const at = thumbAt(axis, null, box, ed.vol);
    const slab = slabOf(ed.orig, ed.active, axis, at);
    const on = new Set(L.comps.flatMap((c, i) => (keys.includes(c.key) ? [i] : [])));
    const img = structThumbRGBA(slab, thumbCrop(axis, [box], ed.vol, 6), rgb, ed.hidden, on, box, face ?? null, size);
    cv.width = img.W;
    cv.height = img.H;
    cv.getContext('2d')!.putImageData(new ImageData(img.data, img.W, img.H), 0, 0);
    setCaption(`${AXN[axis]} · ${axis}=${at}`);
  }, [box, rgb, ed.hidden, face, ed.orig, ed.active, ed.vol, L, keys, size]);
  return (
    <figure className={'struct-thumb' + (box ? '' : ' empty')} style={{ width: size }}>
      <div className="struct-thumb-img" style={{ height: size }}>
        {box ? <canvas ref={ref} aria-label="結構縮圖" /> : <span>還沒選</span>}
      </div>
      <figcaption>{box ? caption : '截面'}</figcaption>
    </figure>
  );
}

export function StructurePicker({ ed, face }: { ed: Editor; face?: Vec3 | null }) {
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
      <div className="struct-pick-left">
        <Select
          mode="multiple"
          size="small"
          style={{ width: '100%' }}
          placeholder="選一個結構（也可以在編輯頁點）"
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
              : '依材質分組；Shift 可多選，和編輯頁的選取同步'}
        </Text>
      </div>
      <StructThumb ed={ed} keys={keys} face={face} />
    </div>
  );
}
