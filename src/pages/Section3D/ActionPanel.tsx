// 右欄上半（plan v17 §5.1、§5.3、§5.5；v21）：三個動作、哪一面、兩顆動作鈕、每次 n 格、這一步會帶動誰（可以直接固定）、試算的說明、材質清單。
import { useEffect, useState } from 'react';
import { Button, InputNumber, Tooltip, Typography } from 'antd';
import { type Comp, LOCK_FULL, isVoid } from '../../volume/volume';
import type { Block } from '../../volume/kernel';
import { Swatch } from '../../ui/Swatch';
import { type Editor, STEP_MAX, type Tool } from './editor';
import { FACES, type FaceName, blockText, faceOf, limitText, namesOf, nmText } from './stepWords';
import { LockIcon, type OpenCtx } from './LockUi';
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

export function ActionPanel({ ed, peek, onCtx }: { ed: Editor; peek: boolean; onCtx: OpenCtx }) {
  const sel = ed.selComps.length > 0;
  const off = !sel || peek;
  /** 選到的裡面已固定的；全部都固定＝不能編輯。 */
  const lockedSel = ed.selComps.filter((c) => ed.lockMap.has(c.key));
  const allLocked = sel && lockedSel.length === ed.selComps.length;
  const same = ed.selMat === null ? 0 : ed.comps.filter((c) => c.mat === ed.selMat).length;
  const n = ed.stepN;
  const p = ed.probe;
  const who = (b: Block | null | undefined) => (b?.at !== undefined && ed.L.labels[b.at] >= 0 ? ed.L.comps[ed.L.labels[b.at]]?.label : undefined);
  const why = (b: Block | null | undefined) => blockText(b ?? null, ed.matName, who(b));
  const room = (r: Room | undefined) => (r ? r.n : Infinity);
  const outN = room(p?.out);
  const inN = room(p?.in);
  const working = !!ed.busy;
  // 試算超過 300 ms 還沒回來：寫「計算中…」（plan v17 §9；結果回來之前按鈕照常可按，真正套用時 Worker 仍會擋）
  const waiting = sel && !allLocked && !peek && ed.tool !== 'mat' && !p;
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const t = setTimeout(() => setSlow(true), 300);
    return () => clearTimeout(t);
  }, [waiting, ed.version, ed.face, ed.tool]);

  // 這一步會帶動誰：同材質的合成一行（「TiN ×9」），寫出它會怎樣，旁邊可以直接固定／解除（右鍵也可以）
  const rows: { comps: Comp[]; hit: boolean; keep?: number }[] = [];
  if (p && sel && ed.tool === 'push')
    for (const [keys, hit] of [[p.follow, false], [p.hit, true]] as [string[], boolean][])
      for (const k of keys) {
        const c = ed.compByKey.get(k);
        if (!c) continue;
        const keep = ed.lockMap.get(k);
        const row = rows.find((r) => r.hit === hit && r.comps[0].mat === c.mat && r.keep === keep);
        if (row) row.comps.push(c);
        else rows.push({ comps: [c], hit, keep });
      }
  const followKeys = rows.filter((r) => !r.hit).flatMap((r) => r.comps.map((c) => c.key));
  const lines: { text: string; warn?: boolean; unlock?: string }[] = [];
  if (p && sel && ed.tool === 'push' && p.out) {
    const o = p.out;
    const blocker = o.stop?.why === 'lock' && o.stop.at !== undefined && ed.L.labels[o.stop.at] >= 0 ? ed.L.comps[ed.L.labels[o.stop.at]]?.key : undefined;
    lines.push(o.n ? { text: `最多可外推 ${o.n}${o.more ? '＋' : ''} 格${o.stop ? `（${limitText(o.stop, ed.matName, who(o.stop))}）` : ''}`, unlock: blocker } : { text: `不能外推：${why(o.stop)}`, warn: true, unlock: blocker });
    if (p.vanishAt) lines.push({ text: p.in?.n ? `最多可內縮 ${p.in.n} 格（再多 ${ed.selName} 就會整個消失，會先問你）` : `再內縮 ${ed.selName} 就會整個消失（會先問你）`, warn: true });
  }
  return (
    <div className={'panel' + (off ? ' off' : '') + (allLocked && !peek ? ' locked' : '')} data-testid="action-panel">
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
      {sel && !peek && lockedSel.length > 0 && (
        <div className={'lockbar' + (allLocked ? '' : ' mini')} data-testid="lockbar">
          {allLocked && (
            <div className="ttl">
              <LockIcon on size={15} /> {ed.selName} 已固定
            </div>
          )}
          <p>{allLocked ? '固定的結構不能編輯。要改它請先解除固定；固定方式可以在下面「固定的結構」調整。' : `選到的裡面有 ${lockedSel.length} 個已固定，這一步不會動它們。`}</p>
          <Button size="small" onClick={() => ed.setLock(lockedSel.map((c) => c.key), null)} data-testid="unlock-sel">
            解除固定
          </Button>
        </div>
      )}
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
              <Button block disabled={off || working || (inN === 0 && !p?.vanishAt)} onClick={() => ed.push(ed.face, -n)} data-testid="shrink">
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
          {ed.tool === 'push' && (
            <div className="row">
              <div className="lbl">這一步會帶動誰（沒固定的全部跟著移動；不想動的按右鍵固定）</div>
              <div className="who" aria-live="polite" data-testid="who">
                {waiting && slow ? (
                  <div>計算中…</div>
                ) : (
                  <>
                    {followKeys.length > 1 && (
                      <div className="ln">
                        <a onClick={() => ed.setLock(followKeys, ed.lastKeep)} data-testid="lock-all-follow">
                          把會跟著動的 {followKeys.length} 個結構全部固定
                        </a>
                        （再解開想帶動的）
                      </div>
                    )}
                    {p && !rows.length && <div className="ln">這個方向沒有其他結構會被帶動。</div>}
                    {rows.map(({ comps, hit, keep }) => {
                      const keys = comps.map((c) => c.key);
                      const name = namesOf(comps, ed.matName);
                      return (
                        <div key={keys.join()} className="aff" title={comps.map((c) => c.label).join('、')} onContextMenu={(e) => (e.preventDefault(), onCtx(keys, e.clientX, e.clientY))}>
                          <Swatch fill={ed.materials.find((m) => m.id === comps[0].mat)?.color ?? '#ccc'} size={12} />
                          <span className="nm">{name}</span>
                          <span className={'chip ' + (hit ? 'lock' : 'follow')}>{!hit ? '跟著移動' : keep !== undefined && keep >= LOCK_FULL ? '完全鎖定' : `固定·最少留 ${nmText(keep ?? 1, ed.nmPerVoxel)}`}</span>
                          <button type="button" className={'lk' + (hit ? ' on' : '')} title={hit ? `解除固定 ${name}` : `固定 ${name}`} onClick={() => ed.setLock(keys, hit ? null : ed.lastKeep)}>
                            <LockIcon on={hit} />
                          </button>
                        </div>
                      );
                    })}
                    {lines.map((l) => (
                      <div key={l.text} className={'ln' + (l.warn ? ' warn' : '')}>
                        {l.text}
                        {l.unlock && (
                          <>
                            {' '}
                            <a onClick={() => ed.setLock([l.unlock!], null)}>解除固定</a>
                          </>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          )}
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
