import { useState } from 'react';
import { Alert, Segmented, Select, Switch, Tag, Typography } from 'antd';
import { type Axis, type Vec3, bboxDims } from '../../volume/volume';
import { signed } from '../../ui/format';
import { BASE_ID, type Editor, type Split } from './editor';
import { SliceView } from './views.lazy';
import { OverlayView } from './OverlayView';
import { sliceDiff, unionUV } from './overlay';
import { factorsOf, levelCell } from './matrix';
import { pairMask, slabOf } from './slabs';

const { Text } = Typography;

export const AXIS_NAME: Record<Axis, string> = { z: 'XY 正面', y: 'XZ 上視', x: 'YZ 側面' };
const AX = { x: 0, y: 1, z: 2 } as const;

/**
 * 並排看各 split（plan v12 §5.4 搬進實驗頁）：每個 split 一張同位置切面，深藍框＝和基準不同。
 * 切面來源是 slabOf（parked 不還原，§5.3）；ids＝要比的 split（省略＝全部）。點卡片標題＝onOpen（實驗頁：在 3D 看）。
 */
export function CompareView({ ed, axis, setAxis, ids, onOpen }: { ed: Editor; axis: Axis; setAxis: (a: Axis) => void; ids?: string[]; onOpen?: (id: string) => void }) {
  const at = (a: Axis) => ed.cursor[AX[a]];
  const chosen = ids ? ed.splits.filter((s) => ids.includes(s.id)) : ed.splits;
  const cards: { id: string; name: string; split: Split | null }[] = [{ id: BASE_ID, name: '原始', split: null }, ...chosen.map((s) => ({ id: s.id, name: s.name, split: s }))];
  const [mode, setMode] = useState<'side' | 'overlay'>('side');
  const [zoom, setZoom] = useState(true);
  const open = onOpen ?? ((id: string) => void ed.setActiveId(id));
  // A vs B（plan v11 §4.4、§9 D6）：基準只影響並排與疊圖
  const baseSplit = ed.compareBase === BASE_ID ? null : (ed.splits.find((s) => s.id === ed.compareBase) ?? null);
  const baseId = baseSplit ? baseSplit.id : BASE_ID;
  const t = at(axis);
  const baseSlab = slabOf(ed.orig, baseSplit, axis, t);
  const slabs = new Map(cards.map((c) => [c.id, slabOf(ed.orig, c.split, axis, t)]));
  const diffOf = (id: string) => {
    if (id === baseId) return null;
    const sl = slabs.get(id)!;
    if (!baseSplit) return id === BASE_ID ? null : { mask: sl.diff, count: sl.diffCount };
    return pairMask(sl.vol.data, baseSlab.vol.data);
  };
  const factors = factorsOf(ed.designs);
  // 卡片自動放大：所有卡片在這一片對基準的差異聯集外框（＋4 格），大家同一個框才好比
  const sv = baseSlab.vol;
  const [SW, SH] = axis === 'z' ? [sv.X, sv.Y] : axis === 'y' ? [sv.X, sv.Z] : [sv.Z, sv.Y];
  const zoomBox = zoom ? unionUV(cards.filter((c) => c.id !== baseId).map((c) => sliceDiff(slabs.get(c.id)!.vol.data, baseSlab.vol.data, sv, axis, 0).box), 4, SW, SH) : null;
  const focus = ed.selComps[0];
  const nm = ed.nmPerVoxel;
  // 切面座標：法線軸換成 0（假 Volume）；點下去換回真正的片
  const slabCursor: Vec3 = [...ed.cursor];
  slabCursor[AX[axis]] = 0;
  const pick = (p: Vec3) => {
    const q: Vec3 = [...p];
    q[AX[axis]] = t;
    ed.setCursor(q);
  };

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
          options={[{ value: BASE_ID, label: '原始' }, ...chosen.map((s) => ({ value: s.id, label: s.name }))]}
          aria-label="基準"
        />
        <Segmented size="small" value={axis} onChange={(v) => setAxis(v as Axis)} options={(['z', 'y', 'x'] as Axis[]).map((a) => ({ label: AXIS_NAME[a], value: a }))} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {axis} = {t}；切面上滾輪可以換片，深藍框＝和{baseSplit ? baseSplit.name : '原始'}不同
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
        <OverlayView ed={ed} axis={axis} at={t} ids={chosen.map((s) => s.id)} onOpen={open} />
      ) : (
        <div className="compare-grid">
          {cards.map((card) => {
            const diff = diffOf(card.id);
            const slab = slabs.get(card.id)!;
            const comp = focus ? slab.L.comps.find((c) => c.key === focus.key) : undefined;
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
            const total = card.split ? ed.stats(card.split).changed : 0;
            // 這一片看不到差異、但整個 split 有改：建議換一個看得到的軸（只看和原始的差）
            const hidesDiff = !baseSplit && total > 0 && slab.diffCount === 0;
            const better = hidesDiff ? (['z', 'y', 'x'] as Axis[]).find((a) => a !== axis && slabOf(ed.orig, card.split, a, at(a)).diffCount > 0) : undefined;
            return (
              <div key={card.id} className={'pane cmp-card' + (card.id === ed.activeId ? ' on' : '')}>
                <div
                  className="pane-head"
                  role="button"
                  tabIndex={0}
                  aria-label={`在 3D 看 ${card.name}`}
                  onClick={() => open(card.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open(card.id))}
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
                    {card.id === baseId ? '基準' : diff ? `這片 ${diff.count.toLocaleString()} 格不同` : '原始'}
                  </Text>
                </div>
                <div className="slice-body">
                  <SliceView
                    vol={slab.vol}
                    axis={axis}
                    at={0}
                    materials={ed.materials}
                    hidden={ed.hidden}
                    selMask={null}
                    cursor={slabCursor}
                    scope={null}
                    diff={diff ? diff.mask : null}
                    box={zoomBox}
                    onPick={pick}
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
                  {card.split?.levels && factors.some((f) => card.split!.levels![f.id] !== undefined) ? (
                    <div className="cmp-ops">
                      {factors
                        .filter((f) => card.split!.levels![f.id] !== undefined)
                        .map((f) => {
                          const c = levelCell(f, card.split!.levels![f.id], nm)!;
                          return (
                            <div key={f.id}>
                              {f.name || f.id} = {c.main}
                              {c.nominal ? '（標稱）' : `（${c.sub}）`}
                            </div>
                          );
                        })}
                    </div>
                  ) : (
                    !!card.split?.ops.length && (
                      <div className="cmp-ops">
                        {card.split.ops.map((op, i) => (
                          <div key={i}>
                            {i + 1}. {ed.opText(op, ed.orig.L)}
                          </div>
                        ))}
                      </div>
                    )
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
