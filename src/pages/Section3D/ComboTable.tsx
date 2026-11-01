// 組合表（plan v12 §5.4 第 3 點）：一列一個會產生的 split、一欄一個變數，最後「會改幾格」「被擋」「狀態」；
// 等於標稱的列標「對照組」；無效的列標紅並寫原因；試算範圍太大的列寫清楚「為什麼沒估、產生不受影響」。
// 試算不在主執行緒：送 Worker 的 preview（mesh: false），一次一個、排隊、逐列填，改了變數就取消還沒算的。
import { useEffect, useRef, useState } from 'react';
import { Checkbox, Tooltip, Typography } from 'antd';
import { CheckOutlined, LoadingOutlined } from '@ant-design/icons';
import type { EditState, Op } from '../../volume/ops';
import { type Design, type Factor, levelsSig } from '../../volume/factors';
import { previewIn, sidOf } from '../../volume/client';
import { levelCell } from './matrix';
import { CATEGORY } from './colors';

const { Text } = Typography;

/** 試算上限（格）：動到的範圍超過就不估（在 Worker 跑、一次一個，可以比即時預覽的 300 萬大）。 */
export const TRIAL_CAP = 8_000_000;
const capText = `${(TRIAL_CAP / 1e6).toFixed(0)} 百萬格`;

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
            p = await previewIn(start, { op, cap: TRIAL_CAP, hidden, palette, showDiff: false, seq: ++seq, mesh: false });
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

const BIG_WHY = `這個組合動到的範圍超過 ${capText}，試算先略過（只是估計用的預覽）；按「產生」時照樣會完整算。`;

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
  const nBig = shown.filter((r) => trials.get(r.key) === 'big').length;
  const nBad = shown.filter((r) => r.errors.length && (!manual || r.picked)).length;
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
        <Tooltip title="估計這個 split 會改到幾格（和起點不同的格數）；在背景逐列試算">
          <span className="cc-chg" role="columnheader">
            會改幾格 ≈
          </span>
        </Tooltip>
        <Tooltip title="推的時候碰到別的材質被擋住的格數（有的話橘字）">
          <span className="cc-blk" role="columnheader">
            被擋
          </span>
        </Tooltip>
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
                    {c ? (c.nominal ? <Text type="secondary">現值</Text> : c.main) : '—'}
                  </span>
                );
              })}
              <span className="cc-chg">
                {r.errors.length || r.control ? (
                  ''
                ) : t === 'pending' ? (
                  <LoadingOutlined />
                ) : t === 'big' ? (
                  <Tooltip title={BIG_WHY}>
                    <Text type="secondary">—</Text>
                  </Tooltip>
                ) : t ? (
                  t.changed.toLocaleString()
                ) : (
                  ''
                )}
              </span>
              <span className="cc-blk">{t && t !== 'pending' && t !== 'big' && t.blocked ? <Text type="warning">{t.blocked.toLocaleString()}</Text> : ''}</span>
              <span className="cc-state">
                {r.errors.length ? (
                  <Tooltip title={r.errors.join('；')}>
                    <span className="cc-pill bad">{r.errors[0].replace(/^[^：]+：/, '')}</span>
                  </Tooltip>
                ) : r.control ? (
                  <Tooltip title="每個變數都等於現在的值：不改動，當基準用">
                    <span className="cc-pill ctl">對照組</span>
                  </Tooltip>
                ) : t === 'big' ? (
                  <Tooltip title={BIG_WHY}>
                    <span className="cc-pill big">可產生 · 未試算</span>
                  </Tooltip>
                ) : t === 'pending' ? (
                  <span className="cc-pill wait">試算中</span>
                ) : (
                  <span className="cc-pill ok">
                    <CheckOutlined /> 可產生
                  </span>
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
      {(nBig > 0 || nBad > 0) && (
        <div className="combo-foot">
          {nBad > 0 && <span className="cf-bad">{nBad} 個組合無效：改掉紅色那幾個值才能產生</span>}
          {nBig > 0 && (
            <span>
              {nBig} 個組合沒估「會改幾格」：動到的範圍超過 {capText}，試算略過；產生不受影響
            </span>
          )}
        </div>
      )}
    </div>
  );
}
