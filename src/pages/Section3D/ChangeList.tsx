// 右欄下半「改了哪些」：目前和原始不一樣的結構，一行一種改動（狀態，不是歷程）。點一行＝選那一組結構。
import { Popconfirm, Typography } from 'antd';
import { Swatch } from '../../ui/Swatch';
import type { Editor } from './editor';
import { namesOf } from './stepWords';

export function ChangeList({ ed }: { ed: Editor }) {
  const rows = ed.changes;
  const n = rows.reduce((s, r) => s + r.comps.length, 0);
  return (
    <div className="changes">
      <div className="ch-head">
        <b>改了哪些</b>
        {ed.diffCount > 0 && (
          <small>
            {n} 個結構 · {ed.diffCount.toLocaleString()} 體素
          </small>
        )}
        <span className="grow" />
        {ed.diffCount > 0 && (
          <Popconfirm title="回到原始？" description="這一步也可以復原（Ctrl+Z）" okText="全部還原" cancelText="取消" onConfirm={ed.resetAll}>
            <Typography.Link>全部還原</Typography.Link>
          </Popconfirm>
        )}
      </div>
      <div className="ch-list" data-testid="change-list">
        {rows.length ? (
          rows.map((r) => {
            const keys = r.gone ? [] : r.comps.map((c) => c.key);
            const on = keys.length > 0 && keys.every((k) => ed.sel.has(k));
            return (
              <button
                key={`${r.mat}|${r.text}|${r.comps[0].key}`}
                type="button"
                className={'ch' + (on ? ' on' : '') + (r.gone ? ' gone' : '')}
                disabled={r.gone}
                onClick={() => ed.selectKeys(keys)}
                title={r.comps.map((c) => c.label).join('、') + (r.gone ? '' : '（點一下選取）')}
              >
                <Swatch fill={ed.materials.find((m) => m.id === r.mat)?.color ?? '#ccc'} size={12} />
                <span className="tx">
                  {namesOf(r.comps, ed.matName)}
                  <div className="sub">{r.text}</div>
                </span>
                <small>{r.voxels.toLocaleString()} 體素</small>
              </button>
            );
          })
        ) : (
          <div className="ch-empty">{ed.diffCount ? '只有空氣的範圍變了。' : '和原始相同。改過的結構會列在這裡，復原就會消失。'}</div>
        )}
      </div>
    </div>
  );
}
