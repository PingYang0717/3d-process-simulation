// 右欄上半（plan v17 §5.1、§5.3、§5.5）：三個動作、哪一面、兩顆動作鈕、每次 n 格、相鄰材質開關與小圖、試算的三行、材質清單。
import { useEffect, useState } from 'react';
import { Button, InputNumber, Tooltip, Typography } from 'antd';
import { isVoid } from '../../volume/volume';
import type { Block } from '../../volume/kernel';
import { Swatch } from '../../ui/Swatch';
import { type Editor, STEP_MAX, type Tool } from './editor';
import { FACES, type FaceName, blockText, faceOf, fixText, limitText, nmText } from './stepWords';
import { PROBE_DIRS, type Room } from '../../volume/probe';

const { Text } = Typography;

const TOOLS: { k: Tool; label: string }[] = [
  { k: 'push', label: '推拉一面' },
  { k: 'move', label: '整塊平移' },
  { k: 'mat', label: '換材質' },
];
/** 平移的六顆方向鍵的排列（3 × 2）。 */
const DPAD: FaceName[] = ['上', '左', '前', '下', '右', '後'];

function Kbd({ children }: { children: string }) {
  return <kbd className="kcap">{children}</kbd>;
}

/** 相鄰材質的小圖：跟著移動＝薄層整層上移、外面那層變薄；留在原地＝緊貼那層變薄。 */
function NbIcon({ follow }: { follow: boolean }) {
  return (
    <svg width="96" height="40" viewBox="0 0 104 46" aria-hidden>
      {follow ? (
        <>
          <rect x="6" y="2" width="92" height="6" fill="#eef0f3" />
          <rect x="6" y="8" width="92" height="12" fill="#c9b6e8" />
        </>
      ) : (
        <>
          <rect x="6" y="2" width="92" height="14" fill="#eef0f3" />
          <rect x="6" y="16" width="92" height="4" fill="#c9b6e8" />
        </>
      )}
      <rect x="6" y="20" width="92" height="24" fill="#e8604c" />
      <path d="M52 40V26m-5 5 5-6 5 6" stroke="#fff" strokeWidth="2" fill="none" />
    </svg>
  );
}

export function ActionPanel({ ed, peek }: { ed: Editor; peek: boolean }) {
  const sel = ed.selComps.length > 0;
  const off = !sel || peek;
  const same = ed.selMat === null ? 0 : ed.comps.filter((c) => c.mat === ed.selMat).length;
  const n = ed.stepN;
  const p = ed.probe;
  const who = (b: Block | null | undefined) => (b?.at !== undefined && ed.L.labels[b.at] >= 0 ? ed.L.comps[ed.L.labels[b.at]]?.label : undefined);
  const why = (b: Block | null | undefined) => blockText(b ?? null, ed.matName, who(b));
  const room = (r: Room | undefined) => (r ? r.n : Infinity);
  const outN = room(p?.out);
  const inN = room(p?.in);
  const working = !!ed.busy;
  const canFollow = p ? p.canFollow : true;
  const names = (ms: number[]) => ms.map(ed.matName).join('、');
  // 試算超過 300 ms 還沒回來：寫「計算中…」（plan v17 §9；結果回來之前按鈕照常可按，真正套用時 Worker 仍會擋）
  const waiting = sel && !peek && ed.tool !== 'mat' && !p;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, [waiting, ed.version, ed.face, ed.follow, ed.tool]);

  const lines: string[] = [];
  if (p && sel && ed.tool !== 'mat') {
    if (ed.follow && p.follow.length) lines.push(`跟著移動：${names(p.follow)}`);
    if (p.thin.length) lines.push(`厚度會變：${names(p.thin)}`);
    if (ed.tool === 'push' && p.out) {
      const o = p.out;
      lines.push(o.n ? `最多可外推 ${o.n}${o.more ? '＋' : ''} 格${o.stop ? `（${limitText(o.stop, ed.matName, who(o.stop))}）` : ''}` : `不能外推：${why(o.stop)}${fixText(o.stop, ed.matName, who(o.stop), ed.follow) ? `（${fixText(o.stop, ed.matName, who(o.stop), ed.follow)}）` : ''}`);
    }
  }

  return (
    <div className={'panel' + (off ? ' off' : '')} data-testid="action-panel">
      <div className="sec-title">
        要做什麼{sel && <small>：{ed.selName}</small>}
        {sel && ed.selComps.length < same && (
          <Typography.Link className="all-same" onClick={ed.selectSame}>
            選全部 {ed.matName(ed.selMat!)}（{same}）
          </Typography.Link>
        )}
      </div>
      {!sel && <div className="empty">先在 3D、切面或左邊的清單點一個結構</div>}
      {peek && sel && <div className="empty">正在看「改前」：切回「改後」才能改</div>}
      <div className="tools" role="radiogroup" aria-label="要做什麼">
        {TOOLS.map((t) => (
          <button key={t.k} type="button" role="radio" aria-checked={ed.tool === t.k} className={ed.tool === t.k ? 'on' : ''} onClick={() => ed.setTool(t.k)} disabled={off}>
            {t.label}
          </button>
        ))}
      </div>

      {ed.tool === 'push' && (
        <>
          <div className="row">
            <div className="lbl">哪一面（或直接點 3D 上的箭頭）</div>
            <div className="faces">
              {FACES.map((f) => (
                <button key={f.name} type="button" className={f.name === ed.face ? 'on' : ''} onClick={() => ed.setFace(f.name)} disabled={off} aria-pressed={f.name === ed.face}>
                  {f.name}
                  <Kbd>{f.cap}</Kbd>
                </button>
              ))}
            </div>
          </div>
          <div className="row two">
            <Tooltip title={!off && inN === 0 ? why(p?.in?.stop) : ''}>
              <Button block disabled={off || working || inN === 0} onClick={() => ed.push(ed.face, -n)} data-testid="shrink">
                {ed.face}面內縮 {n} 格<Kbd>－</Kbd>
              </Button>
            </Tooltip>
            <Tooltip title={!off && outN === 0 ? why(p?.out?.stop) : ''}>
              <Button type="primary" block disabled={off || working || outN === 0} onClick={() => ed.push(ed.face, n)} data-testid="grow">
                {ed.face}面外推 {n} 格<Kbd>＋</Kbd>
              </Button>
            </Tooltip>
          </div>
        </>
      )}

      {ed.tool === 'move' && (
        <div className="row">
          <div className="lbl">往哪邊搬（按一下搬一次，或在 3D 上拖箭頭）</div>
          <div className="dpad">
            {DPAD.map((f) => {
              const r = p?.dirs?.[PROBE_DIRS.findIndex((d) => d.join() === faceOf(f).d.join())];
              const blocked = !!r && r.n === 0;
              return (
                <Tooltip key={f} title={off ? '' : blocked ? why(r!.stop) : r ? `最多 ${r.n}${r.more ? '＋' : ''} 格` : ''}>
                  <button type="button" disabled={off || working || blocked} onClick={() => ed.move(f, n)}>
                    {f}
                    <Kbd>{faceOf(f).cap}</Kbd>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      )}

      {ed.tool !== 'mat' && (
        <>
          <div className="row step">
            每次
            <InputNumber size="small" min={1} max={STEP_MAX} value={n} precision={0} onChange={(v) => v !== null && ed.setStepN(v)} disabled={off} style={{ width: 64 }} aria-label="每次幾格" />
            格 ＝ {nmText(n, ed.nmPerVoxel)}
          </div>
          <div className="row">
            <div className="lbl">相鄰材質</div>
            <div className="nb" role="radiogroup" aria-label="相鄰材質">
              {[true, false].map((f) => (
                <button key={String(f)} type="button" role="radio" aria-checked={ed.follow === f} className={ed.follow === f && (canFollow || !f) ? 'on' : ''} disabled={off || (f && !canFollow)} onClick={() => ed.setFollow(f)}>
                  {f ? '跟著移動' : '留在原地'}
                  <NbIcon follow={f} />
                </button>
              ))}
            </div>
            <div className="who" aria-live="polite">
              {waiting && slow ? <div>計算中…</div> : lines.map((l) => <div key={l}>{l}</div>)}
            </div>
          </div>
        </>
      )}

      {ed.tool === 'mat' && (
        <div className="row">
          <div className="lbl">換成哪一種（點一下就換）</div>
          <div className="mats">
            {ed.materials
              .filter((m) => m.id !== 0)
              .map((m) => (
                <button key={m.id} type="button" className={m.id === ed.selMat ? 'on' : ''} disabled={off || working} onClick={() => ed.setMaterial(m.id)}>
                  <Swatch fill={m.color} isVoid={isVoid(m.id)} size={12} />
                  <span>{m.name}</span>
                </button>
              ))}
          </div>
        </div>
      )}
      {!off && working && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          計算中…
        </Text>
      )}
    </div>
  );
}
