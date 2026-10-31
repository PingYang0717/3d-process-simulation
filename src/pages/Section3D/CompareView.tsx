import { Alert, Segmented, Tag, Typography } from 'antd';
import { type Axis, bboxDims, sliceHasAny } from '../../volume/volume';
import { signed } from '../../ui/format';
import { BASE_ID, type Editor, useSplitDiffs } from './editor';
import { SliceView } from './views.lazy';

const { Text } = Typography;

export const AXIS_NAME: Record<Axis, string> = { z: 'XY 正面', y: 'XZ 上視', x: 'YZ 側面' };

/** 並排看各 split：每個 split 一張同位置切面，深藍框＝和原始不同。 */
export function CompareView({ ed, axis, setAxis }: { ed: Editor; axis: Axis; setAxis: (a: Axis) => void }) {
  const at = (a: Axis) => (a === 'x' ? ed.cursor[0] : a === 'y' ? ed.cursor[1] : ed.cursor[2]);
  const cards = [
    { id: BASE_ID, name: '原始', vol: ed.orig.vol, L: ed.orig.L, ops: [] as typeof ed.splits[number]['ops'] },
    ...ed.splits.map((s) => ({ id: s.id, name: s.name, vol: s.cur.vol, L: s.cur.L, ops: s.ops })),
  ];
  const diffs = useSplitDiffs(ed);
  const focus = ed.selComps[0];
  const nm = ed.nmPerVoxel;

  return (
    <div className="compare">
      <div className="pane-head" style={{ background: '#fff', borderRadius: 8, marginBottom: 12, boxShadow: '0 1px 2px rgba(0,0,0,.06)' }}>
        <Text strong style={{ fontSize: 12 }}>
          並排看各 split
        </Text>
        <Segmented
          size="small"
          value={axis}
          onChange={(v) => setAxis(v as Axis)}
          options={(['z', 'y', 'x'] as Axis[]).map((a) => ({ label: AXIS_NAME[a], value: a }))}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {axis} = {at(axis)}；切面上滾輪可以換片，紅框＝和原始不同
          {focus ? `；數字是 ${focus.label} 的尺寸` : '；選一個結構會顯示它在每個 split 的尺寸'}
        </Text>
        <span className="grow" />
        <Text type="secondary" style={{ fontSize: 12 }}>
          點卡片標題切到那個 split
        </Text>
      </div>
      <div className="compare-grid">
        {cards.map((card) => {
          const diff = card.id === BASE_ID ? null : (diffs.get(card.id) ?? null);
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
                  {card.id === BASE_ID ? '基準' : diff ? `${diff.count.toLocaleString()} voxels 不同` : '比對中…'}
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
                {card.ops.length > 0 && (
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
    </div>
  );
}
