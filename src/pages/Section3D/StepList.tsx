// 右欄下半「改了哪些」（plan v17 §5.5 R9）：一步一筆——編號、第一句、每種鄰居各一行、這一步改了幾個體素。
// 標題列「3 步 · 和原始差 5,456 體素」與「全部還原」；新的一步自動捲到看得到；點某一筆＝選回那一組結構。
import { useEffect, useRef } from 'react';
import { Popconfirm, Typography } from 'antd';
import type { Editor } from './editor';

export function StepList({ ed }: { ed: Editor }) {
  const list = useRef<HTMLDivElement>(null);
  const n = ed.hist.length;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [n]);
  return (
    <div className="changes">
      <div className="ch-head">
        <b>改了哪些</b>
        {n > 0 && (
          <small>
            {n} 步 · 和原始差 {ed.diffCount.toLocaleString()} 體素
          </small>
        )}
        <span className="grow" />
        {ed.diffCount > 0 && (
          <Popconfirm title="回到原始？" description="這一步也可以復原（Ctrl+Z）" okText="全部還原" cancelText="取消" onConfirm={ed.resetAll}>
            <Typography.Link>全部還原</Typography.Link>
          </Popconfirm>
        )}
      </div>
      <div className="ch-list" ref={list} data-testid="step-list">
        {n ? (
          ed.hist.map((h, k) => (
            <button key={k} type="button" className="ch" onClick={() => h.note.keys.length && ed.selectKeys(h.note.keys.filter((x) => ed.compByKey.has(x)))} title={h.note.keys.length ? '點一下選回這一組結構' : ''}>
              <span className="no">{k + 1}</span>
              <span className="tx">
                {h.note.parts[0]}
                {h.note.parts.slice(1).map((t) => (
                  <div className="sub" key={t}>
                    {t}
                  </div>
                ))}
              </span>
              <small>{h.note.changed.toLocaleString()} 體素</small>
            </button>
          ))
        ) : (
          <div className="ch-empty">還沒有改動。每做一步，這裡會多一行。</div>
        )}
      </div>
    </div>
  );
}
