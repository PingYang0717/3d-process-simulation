// 實驗頁設計區第 1 步（plan v12 §5.4）：選結構。目前的選取（和編輯頁同步）；沒有就在這裡選（依材質分組、列名字與大小）。
// 旁邊一張 120 px 的縮圖：結構最長軸的切面、結構用選取藍、其他淡掉；六面小方塊滑過時那條邊亮橘色。
import { useEffect, useMemo, useRef } from 'react';
import { Select, Typography } from 'antd';
import { type Vec3, hexToRgb, unionBBox } from '../../volume/volume';
import type { Editor } from './editor';
import { slabOf } from './slabs';
import { longestAxisOf, structThumbRGBA, thumbAt, thumbCrop } from './thumbs';

const { Text } = Typography;

export function StructThumb({ ed, keys, face, size = 120 }: { ed: Editor; keys: string[]; face?: Vec3 | null; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const L = ed.L;
  const box = useMemo(() => unionBBox(L.comps.filter((c) => keys.includes(c.key))), [L, keys]);
  const rgb = useMemo(() => new Map(ed.materials.map((m) => [m.id, hexToRgb(m.color)])), [ed.materials]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !box) return;
    const axis = longestAxisOf(box);
    const at = thumbAt(axis, null, box, ed.vol);
    const slab = slabOf(ed.orig, ed.active, axis, at);
    const on = new Set(L.comps.flatMap((c, i) => (keys.includes(c.key) ? [i] : [])));
    const img = structThumbRGBA(slab, thumbCrop(axis, [box], ed.vol, 6), rgb, ed.hidden, on, box, face ?? null, size);
    cv.width = img.W;
    cv.height = img.H;
    cv.getContext('2d')!.putImageData(new ImageData(img.data, img.W, img.H), 0, 0);
  }, [box, rgb, ed.hidden, face, ed.orig, ed.active, ed.vol, L, keys, size]);
  if (!box) return <div className="struct-thumb empty" style={{ width: size, height: size * 0.75 }} />;
  return <canvas ref={ref} className="struct-thumb" style={{ maxWidth: size, maxHeight: size, imageRendering: 'pixelated' }} aria-label="結構縮圖" />;
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
        <Text type="secondary" style={{ fontSize: 12 }}>
          {keys.length ? '和編輯頁的選取同步；Shift 多選的結構會一起改' : '依材質分組；選了會和編輯頁的選取同步'}
        </Text>
      </div>
      <StructThumb ed={ed} keys={keys} face={face} />
    </div>
  );
}
