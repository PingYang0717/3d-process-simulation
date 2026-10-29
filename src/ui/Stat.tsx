import { Flex } from 'antd';
import type { ReactNode } from 'react';
import { signed } from './format';

/** 尺寸小卡：數值 vx、nm，和原始不同時標橘。 */
export function StatTile({ label, now, before, nm }: { label: string; now: number; before?: number; nm: number }) {
  const delta = before === undefined ? 0 : now - before;
  return (
    <div className={'stat' + (delta ? ' changed' : '')}>
      <div className="stat-label">
        {label}
        {delta !== 0 && <span className="stat-delta">{signed(delta)}</span>}
      </div>
      <div className="stat-value">
        {now}
        <span>vx</span>
      </div>
      <div className="stat-sub">{(now * nm).toFixed(1)} nm</div>
    </div>
  );
}

export function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="insp-sec">
      <Flex justify="space-between" align="center" className="insp-sec-head">
        <h3>{title}</h3>
        {extra}
      </Flex>
      {children}
    </section>
  );
}
