// 固定（plan v21 §2、v22）：右鍵選單、右欄「固定的結構」、鎖的圖示。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LOCK_FULL, type Comp } from '../../volume/volume';
import { Swatch } from '../../ui/Swatch';
import type { Editor } from './editor';
import { namesOf, nmText } from './stepWords';

export function LockIcon({ on, size = 14 }: { on: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2.2 : 2} strokeLinecap="round" aria-hidden>
      <rect x="5" y="11" width="14" height="9" rx="2" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.25 : 0} />
      <path d={on ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.5-1.9'} />
    </svg>
  );
}

export interface CtxTarget {
  x: number;
  y: number;
  keys: string[];
}
/** 在結構上按右鍵：多選時在其中一個上按＝整批一起。 */
export type OpenCtx = (keys: string[], x: number, y: number) => void;

/** 右鍵選單：固定位置（可被壓薄）／完全鎖定／解除固定。不改變目前的選取。 */
export function LockMenu({ ed, target, onClose }: { ed: Editor; target: CtxTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setPos({ left: Math.max(8, Math.min(target.x, innerWidth - el.offsetWidth - 8)), top: Math.max(8, Math.min(target.y, innerHeight - el.offsetHeight - 8)) });
  }, [target]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', onClose, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', onClose, true);
    };
  }, [onClose]);
  const comps = target.keys.map((k) => ed.compByKey.get(k)).filter((c): c is Comp => !!c);
  if (!comps.length) return null;
  const keeps = comps.map((c) => ed.lockMap.get(c.key));
  const all = keeps.every((k) => k !== undefined);
  const any = keeps.some((k) => k !== undefined);
  const cur = all && keeps.every((k) => k === keeps[0]) ? keeps[0] : undefined;
  const flex = cur !== undefined && cur < LOCK_FULL ? cur : ed.lastKeep >= LOCK_FULL ? 2 : ed.lastKeep;
  const keys = comps.map((c) => c.key);
  const pick = (keep: number | null) => {
    ed.setLock(keys, keep);
    onClose();
  };
  const mat = ed.materials.find((m) => m.id === comps[0].mat);
  return (
    <div className="ctx" ref={ref} style={pos} role="menu" data-testid="lock-menu" onContextMenu={(e) => e.preventDefault()}>
      <div className="hd">
        <Swatch fill={mat?.color ?? '#ccc'} size={12} />
        {namesOf(comps, ed.matName)}
        <small>{all ? '已固定' : any ? '部分已固定' : '未固定'}</small>
      </div>
      <button type="button" role="menuitem" className={cur !== undefined && cur < LOCK_FULL ? 'cur' : ''} onClick={() => pick(flex)} data-testid="lock-flex">
        <span className="ic">{cur !== undefined && cur < LOCK_FULL ? '✓' : <LockIcon on={false} />}</span>
        <span>
          <span className="t">固定位置（可被壓薄）</span>
          <span className="d">不會被帶著走；被推到時變薄，最少留 {nmText(flex, ed.nmPerVoxel)}</span>
        </span>
      </button>
      <button type="button" role="menuitem" className={cur === LOCK_FULL ? 'cur' : ''} onClick={() => pick(LOCK_FULL)} data-testid="lock-full">
        <span className="ic">{cur === LOCK_FULL ? '✓' : <LockIcon on={false} />}</span>
        <span>
          <span className="t">完全鎖定</span>
          <span className="d">形狀和位置都不變；別的結構推到它就停</span>
        </span>
      </button>
      {any && (
        <>
          <hr />
          <button type="button" role="menuitem" className="off" onClick={() => pick(null)} data-testid="lock-off">
            <span className="ic" />
            <span>
              <span className="t">解除固定</span>
            </span>
          </button>
        </>
      )}
    </div>
  );
}

/** 右欄「固定的結構」：目前鎖了誰、怎麼鎖，直接在這裡改。同材質、同一種固定方式的合成一張卡片。 */
export function LockPanel({ ed, onCtx }: { ed: Editor; onCtx: OpenCtx }) {
  const groups = new Map<string, { keep: number; comps: Comp[] }>();
  for (const [key, keep] of ed.locks) {
    const c = ed.compByKey.get(key);
    if (!c) continue;
    const g = `${c.mat}|${keep}`;
    (groups.get(g) ?? groups.set(g, { keep, comps: [] }).get(g)!).comps.push(c);
  }
  const list = [...groups.values()].sort((p, q) => p.comps[0].mat - q.comps[0].mat || p.keep - q.keep);
  const n = ed.locks.length;
  return (
    <div className="locks" data-testid="lock-panel">
      <div className="ch-head">
        <b>固定的結構</b>
        {n > 0 && <small>{n} 個</small>}
        <span className="grow" />
        {n > 0 && (
          <a onClick={() => ed.setLock(ed.locks.map(([k]) => k), null)} data-testid="unlock-all">
            全部解除
          </a>
        )}
      </div>
      <div className="lk-list">
        {!n && (
          <div className="lk-empty">
            還沒有固定的結構。
            <br />
            在結構上按<b>右鍵</b>就能固定（多選時整批一起），固定後不會被別的結構帶著走。
          </div>
        )}
        {list.map(({ keep, comps }) => {
          const keys = comps.map((c) => c.key);
          const full = keep >= LOCK_FULL;
          const on = keys.every((k) => ed.sel.has(k));
          const mat = ed.materials.find((m) => m.id === comps[0].mat);
          return (
            <div key={keys.join()} className={'lkrow' + (on ? ' on' : '')} onContextMenu={(e) => (e.preventDefault(), onCtx(keys, e.clientX, e.clientY))}>
              <div className="r1">
                <Swatch fill={mat?.color ?? '#ccc'} size={12} />
                <span className="nm" title={comps.map((c) => c.label).join('、') + '（點一下選取）'} onClick={() => ed.selectKeys(keys)}>
                  {namesOf(comps, ed.matName)}
                </span>
                <button type="button" className="x" onClick={() => ed.setLock(keys, null)}>
                  解除
                </button>
              </div>
              <div className="r2">
                <span className="seg">
                  <button type="button" className={full ? '' : 'on'} title="位置不動；別的結構推過來時它會變薄，薄到最少保留的厚度就停" onClick={() => full && ed.setLock(keys, 2)}>
                    可被壓薄
                  </button>
                  <button type="button" className={full ? 'on' : ''} title="形狀和位置都不變；別的結構推到它就停" onClick={() => !full && ed.setLock(keys, LOCK_FULL)}>
                    完全鎖定
                  </button>
                </span>
                {!full && (
                  <span className="keep">
                    最少留
                    <button type="button" disabled={keep <= 1} onClick={() => ed.setLock(keys, keep - 1)} aria-label="少一格">
                      −
                    </button>
                    <b>{nmText(keep, ed.nmPerVoxel)}</b>
                    <button type="button" disabled={keep >= LOCK_FULL - 1} onClick={() => ed.setLock(keys, keep + 1)} aria-label="多一格">
                      ＋
                    </button>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
