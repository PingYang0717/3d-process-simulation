import { useState } from 'react';
import { Alert, Segmented, Select, Switch, Tag, Typography } from 'antd';
import { type Axis, bboxDims, sliceHasAny } from '../../volume/volume';
import { signed } from '../../ui/format';
import { BASE_ID, type Editor, useSplitDiffs } from './editor';
import { SliceView } from './views.lazy';
import { OverlayView } from './OverlayView';
import { diffPair, sliceDiff, sliceGeom, unionUV } from './overlay';
import { factorsOf, levelCell } from './matrix';
import { sidOf } from '../../volume/client';

const { Text } = Typography;

export const AXIS_NAME: Record<Axis, string> = { z: 'XY 正面', y: 'XZ 上視', x: 'YZ 側面' };

/** 並排看各 split：每個 split 一張同位置切面，深藍框＝和原始不同。 */
export function CompareView({ ed, axis, setAxis }: { ed: Editor; axis: Axis; setAxis: (a: Axis) => void }) {
  const at = (a: Axis) => (a === 'x' ? ed.cursor[0] : a === 'y' ? ed.cursor[1] : ed.cursor[2]);
  const cards = [
    { id: BASE_ID, name: '原始', vol: ed.orig.vol, L: ed.orig.L, ops: [] as typeof ed.splits[number]['ops'] },
    ...ed.splits.map((s) => ({ id: s.id, name: s.name, vol: s.cur.vol, L: s.cur.L, ops: s.ops, levels: s.levels, version: sidOf(s.cur) })),
  ] as { id: string; name: string; vol: typeof ed.vol; L: typeof ed.L; ops: typeof ed.splits[number]['ops']; levels?: Record<string, number>; version?: number }[];
  const origDiffs = useSplitDiffs(ed);
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [zoom, setZoom] = useState(true);
  // A vs B（plan v11 §4.4、§9 D6）：基準只影響並排與疊圖；基準是原始時沿用帳簿的 diff
  const baseSplit = ed.compareBase === BASE_ID ? null : ed.splits.find((s) => s.id === ed.compareBase) ?? null;
  const baseId = baseSplit ? baseSplit.id : BASE_ID;
  const baseVol = baseSplit ? baseSplit.cur.vol : ed.orig.vol;
  const diffOf = (card: (typeof cards)[number]) => {
    if (card.id === baseId) return null;
    if (!baseSplit) return card.id === BASE_ID ? null : (origDiffs.get(card.id) ?? null);
    return diffPair(card.version ?? sidOf(ed.orig), card.vol.data, sidOf(baseSplit.cur), baseVol.data);
  };
  const factors = factorsOf(ed.designs);
  // 卡片自動放大：所有卡片在這一片對基準的差異聯集外框（＋4 格），大家同一個框才好比
  const { W: SW, H: SH } = sliceGeom(ed.vol, axis);
  const zoomBox = zoom ? unionUV(cards.filter((c) => c.id !== baseId).map((c) => sliceDiff(c.vol.data, baseVol.data, ed.vol, axis, at(axis)).box), 4, SW, SH) : null;
  const focus = ed.selComps[0];
  const nm = ed.nmPerVoxel;

  return (
    <div className="compare">
      <div className="pane-head" style={{ background: '#fff', borderRadius: 8, marginBottom: 12, boxShadow: '0 1px 2px rgba(0,0,0,.06)' }}>
        <Segmented
          size="small"
          value={mode}
          onChange={(v) => setMode(v as 'side' | 'overlay')}
          options={[
            { label: '並排', value: 'side' },
            { label: '疊圖', value: 'overlay' },
          ]}
        />
        <Text style={{ fontSize: 12 }}>基準</Text>
        <Select
          size="small"
          style={{ minWidth: 120 }}
          value={baseId}
          onChange={ed.setCompareBase}
          options={[{ value: BASE_ID, label: '原始' }, ...ed.splits.map((s) => ({ value: s.id, label: s.name }))]}
          aria-label="基準"
        />
        <Segmented
          size="small"
          value={axis}
          onChange={(v) => setAxis(v as Axis)}
          options={(['z', 'y', 'x'] as Axis[]).map((a) => ({ label: AXIS_NAME[a], value: a }))}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {axis} = {at(axis)}；切面上滾輪可以換片，紅框＝和{baseSplit ? baseSplit.name : '原始'}不同
          {focus ? `；數字是 ${focus.label} 的尺寸` : '；選一個結構會顯示它在每個 split 的尺寸'}
        </Text>
        <span className="grow" />
        {mode === 'side' && (
          <>
            <Switch size="small" checked={zoom} onChange={setZoom} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              自動放大到差異
            </Text>
          </>
        )}
      </div>
      {mode === 'overlay' ? (
        <OverlayView ed={ed} axis={axis} at={at(axis)} />
      ) : (
      <div className="compare-grid">
        {cards.map((card) => {
          const diff = diffOf(card);
          const comp = focus ? card.L.comps.find((c) => c.key === focus.key) : undefined;
          const was = focus ? ed.origByKey.get(focus.key) : undefined;
          const now = comp ? bboxDims(comp.bbox) : null;
          const base = was ? bboxDims(was.bbox) : null;
          const stat = (label: string, v: number, b?: number) => {
            const changed = b !== undefined && v !== b;
            return (
              <div className={'cmp-stat' + (changed ? ' changed' : '')}>
                <span>{label}</span>
                <b>{v}</b>
                {changed && (
                  <small>
                    {signed(v - b)}（{signed((v - b) * nm, 1)} nm）
                  </small>
                )}
              </div>
            );
          };
          const hidesDiff = diff && diff.count > 0 && !sliceHasAny(diff.mask, card.vol, axis, at(axis));
          const better = hidesDiff
            ? (['z', 'y', 'x'] as Axis[]).find((a) => a !== axis && sliceHasAny(diff.mask, card.vol, a, at(a)))
            : undefined;
          return (
            <div key={card.id} className={'pane cmp-card' + (card.id === ed.activeId ? ' on' : '')}>
              <div
                className="pane-head"
                role="button"
                tabIndex={0}
                aria-label={`切到 ${card.name}`}
                onClick={() => ed.setActiveId(card.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), ed.setActiveId(card.id))}
                style={{ cursor: 'pointer' }}
              >
                <Text strong style={{ fontSize: 13 }}>
                  {card.name}
                </Text>
                {card.id === ed.activeId && (
                  <Tag color="blue" bordered={false} className="mini-tag">
                    目前
                  </Tag>
                )}
                <span className="grow" />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {card.id === baseId ? '基準' : diff ? `${diff.count.toLocaleString()} voxels 不同` : card.id === BASE_ID ? '原始' : '比對中…'}
                </Text>
              </div>
              <div className="slice-body">
                <SliceView
                  vol={card.vol}
                  axis={axis}
                  at={at(axis)}
                  materials={ed.materials}
                  hidden={ed.hidden}
                  selMask={null}
                  cursor={ed.cursor}
                  scope={null}
                  diff={diff ? diff.mask : null}
                  box={zoomBox}
                  onPick={(p) => ed.setCursor(p)}
                  onStep={(d) => ed.stepCursor(axis, d)}
                />
              </div>
              <div className="cmp-foot">
                {now ? (
                  <>
                    {stat('高 H', now.h, base?.h)}
                    {stat('寬 W', now.w, base?.w)}
                    {stat('深 D', now.d, base?.d)}
                    {base && now.h === base.h && now.y !== base.y ? stat('頂 Y', now.y, base.y) : null}
                  </>
                ) : focus ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {focus.label} 在這個 split 不存在
                  </Text>
                ) : null}
                {hidesDiff && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ flexBasis: '100%', padding: '4px 10px' }}
                    message={
                      <span style={{ fontSize: 12 }}>
                        這個切面剛好看不到差異
                        {better ? (
                          <>
                            ，切到 <Typography.Link onClick={() => setAxis(better)}>{AXIS_NAME[better]}</Typography.Link> 就看得到
                          </>
                        ) : (
                          '，試著滾輪換一片'
                        )}
                      </span>
                    }
                  />
                )}
                {card.levels && factors.some((f) => card.levels![f.id] !== undefined) ? (
                  <div className="cmp-ops">
                    {factors
                      .filter((f) => card.levels![f.id] !== undefined)
                      .map((f) => {
                        const c = levelCell(f, card.levels![f.id], nm)!;
                        return (
                          <div key={f.id}>
                            {f.name || f.id} = {c.main}
                            {c.nominal ? '（標稱）' : `（${c.sub}）`}
                          </div>
                        );
                      })}
                  </div>
                ) : card.ops.length > 0 && (
                  <div className="cmp-ops">
                    {card.ops.map((op, i) => (
                      <div key={i}>
                        {i + 1}. {ed.opText(op, ed.orig.L)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
