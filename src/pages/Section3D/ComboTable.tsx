// 組合表（plan v12 §5.4 第 3 點）：一列一個會產生的 split、一欄一個變數，最後「改動 ≈」「被擋」「狀態」；
// 等於標稱的列標「對照組」；無效的列標紅並寫原因。手動勾選＝這張表的核取方塊。
// 試算不在主執行緒：送 Worker 的 preview（mesh: false），一次一個、排隊、逐列填，改了變數就取消還沒算的。
import { useEffect, useRef, useState } from 'react';
import { Checkbox, Tag, Tooltip, Typography } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';
import type { EditState, Op } from '../../volume/ops';
import { type Design, type Factor, levelsSig } from '../../volume/factors';
import { previewIn, sidOf } from '../../volume/client';
import { levelCell } from './matrix';
import { CATEGORY } from './colors';

const { Text } = Typography;

export interface ComboRow {
  key: string;
  combo: Record<string, number>;
  name: string;
  errors: string[];
  control: boolean;
  /** 手動勾選模式：這一列有沒有勾。 */
  picked?: boolean;
  ops: Op[];
}
type Trial = { changed: number; blocked: number } | 'big' | 'pending';

/** 改動試算：在 Worker 裡逐列跑 preview（不凍主執行緒）。換設計就取消還沒算的。 */
function useTrials(rows: ComboRow[], start: EditState, hidden: Uint8Array, palette: Float32Array, sig: string) {
  const [trials, setTrials] = useState<Map<string, Trial>>(new Map());
  const token = useRef(0);
  useEffect(() => {
    const my = ++token.current;
    const todo = rows.filter((r) => !r.errors.length && !r.control && r.ops.length).slice(0, 200);
    setTrials(new Map(todo.map((r) => [r.key, 'pending' as Trial])));
    let seq = 0;
    const run = async () => {
      // 讓表格先畫出「計算中」再開始
      await new Promise((r) => setTimeout(r, 30));
      for (const r of todo) {
        if (token.current !== my) return;
        let changed = 0;
        let blocked = 0;
        let big = false;
        for (const op of r.ops) {
          let p;
          try {
            p = await previewIn(start, { op, cap: 3_000_000, hidden, palette, showDiff: false, seq: ++seq, mesh: false });
          } catch {
            return; // 狀態過期（換了 split）：等下一次
          }
          if (token.current !== my) return;
          if ('none' in p) {
            big = true;
            break;
          }
          const { box, data } = p;
          const { X, Y } = start.vol;
          const W = box.x1 - box.x0 + 1;
          const H = box.y1 - box.y0 + 1;
          const d = start.vol.data;
          for (let z = box.z0, k = 0; z <= box.z1; z++)
            for (let y = box.y0; y < box.y0 + H; y++) {
              const row = (z * Y + y) * X + box.x0;
              for (let x = 0; x < W; x++, k++) if (data[k] !== d[row + x]) changed++;
            }
          blocked += p.blockedAt.length;
        }
        const t: Trial = big ? 'big' : { changed, blocked };
        setTrials((m) => new Map(m).set(r.key, t));
      }
    };
    void run();
    return () => {
      token.current++;
    };
    // sig＝設計＋起點版本；rows 跟著 sig 變
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, sidOf(start)]);
  return trials;
}

export function ComboTable({
  rows,
  factors,
  design,
  start,
  nm,
  manual,
  onPick,
  hidden,
  palette,
}: {
  rows: ComboRow[];
  factors: Factor[];
  design: Design;
  start: EditState;
  nm: number;
  manual: boolean;
  onPick: (key: string, on: boolean) => void;
  hidden: Uint8Array;
  palette: Float32Array;
}) {
  const sig = `${levelsSig(design)}|${rows.map((r) => r.key + (r.picked ? '+' : '')).join(';')}`;
  const trials = useTrials(rows, start, hidden, palette, sig);
  const shown = rows.slice(0, 200);
  return (
    <div className="combo-table" role="table" aria-label="組合表">
      <div className="combo-row head" role="row">
        {manual && <span className="cc-pick" />}
        <span className="cc-n">#</span>
        {factors.map((f, k) => (
          <span key={f.id} className="cc-f" role="columnheader">
            <span className="factor-dot" style={{ background: CATEGORY[k % CATEGORY.length] }} />
            {f.name || f.id}
          </span>
        ))}
        <span className="cc-chg" role="columnheader">
          改動 ≈
        </span>
        <span className="cc-blk" role="columnheader">
          被擋
        </span>
        <span className="cc-state" role="columnheader">
          狀態
        </span>
      </div>
      <div className="combo-body">
        {shown.map((r, i) => {
          const t = trials.get(r.key);
          const off = manual && !r.picked;
          return (
            <div key={r.key} className={'combo-row' + (r.errors.length ? ' bad' : r.control ? ' control' : '') + (off ? ' off' : '')} role="row" title={r.name}>
              {manual && (
                <span className="cc-pick">
                  <Checkbox checked={!!r.picked} onChange={(e) => onPick(r.key, e.target.checked)} aria-label={`勾選 ${r.name}`} />
                </span>
              )}
              <span className="cc-n">{i + 1}</span>
              {factors.map((f) => {
                const c = levelCell(f, r.combo[f.id], nm);
                return (
                  <span key={f.id} className="cc-f">
                    {c ? (c.nominal ? <Text type="secondary">標稱</Text> : c.main) : '—'}
                  </span>
                );
              })}
              <span className="cc-chg">
                {r.errors.length || r.control ? '' : t === 'pending' ? <LoadingOutlined /> : t === 'big' ? <Text type="secondary">範圍太大</Text> : t ? t.changed.toLocaleString() : ''}
              </span>
              <span className="cc-blk">{t && t !== 'pending' && t !== 'big' && t.blocked ? <Text type="warning">{t.blocked.toLocaleString()}</Text> : ''}</span>
              <span className="cc-state">
                {r.errors.length ? (
                  <Tooltip title={r.errors.join('；')}>
                    <Text type="danger" ellipsis style={{ fontSize: 12 }}>
                      {r.errors[0]}
                    </Text>
                  </Tooltip>
                ) : r.control ? (
                  <Tag bordered={false} style={{ fontSize: 11, marginInlineEnd: 0 }}>
                    對照組（不改動）
                  </Tag>
                ) : (
                  ''
                )}
              </span>
            </div>
          );
        })}
        {rows.length > 200 && (
          <Text type="secondary" style={{ fontSize: 12, padding: 6 }}>
            …還有 {rows.length - 200} 列（上限 200）
          </Text>
        )}
      </div>
    </div>
  );
}
