// 一步操作只在外框裡算（plan v7 §8.2）：裁下 previewBox、在裁切範圍裡跑同一組純函式，
// 找出真正改到的外框，貼回陣列；relabel 直接吃這個外框，不必掃整個陣列找哪裡不同。
// 結果和 applyOp 逐體素相同（apply.test.ts）。
import { type Labeled, type Volume, relabelFast } from './volume';
import { type EditState, type LegacyOp, type Op, type OpContext, upgradeOp } from './ops';
import { previewBox, previewOp } from './preview';
import { type Step, cropArr, diffInBox, pasteArr } from './patch';
import { type Report, newReport } from './kernel';

export interface Applied {
  state: { vol: Volume; L: Labeled };
  step: Step;
  report: Report;
}

export function applyOpLocal(s: EditState, input: Op | LegacyOp, ctx: OpContext): Applied {
  const op = upgradeOp(input);
  const report = newReport();
  const none: Applied = { state: { vol: s.vol, L: s.L }, step: { data: null, labels: null }, report };
  const box = previewBox(s, op);
  if (!box) return none;
  const p = previewOp(s, ctx.orig, op, Infinity, report)!;
  // 被擋的格子：裁切範圍的 index → 整個陣列
  {
    const W = box.x1 - box.x0 + 1;
    const H = box.y1 - box.y0 + 1;
    report.blockedAt = report.blockedAt.map((i) => {
      const x = i % W;
      const y = ((i - x) / W) % H;
      const z = (i - x - y * W) / (W * H);
      return ((z + box.z0) * s.vol.Y + y + box.y0) * s.vol.X + x + box.x0;
    });
  }
  const before = cropArr(s.vol.data, s.vol, box);
  const R = diffInBox(before, p.data, box);
  if (!R) return none;
  const data = s.vol.data.slice();
  pasteArr(data, s.vol, box, p.data);
  const next: Volume = { X: s.vol.X, Y: s.vol.Y, Z: s.vol.Z, data };
  // 平移時已選結構的體素照位移對應（名稱延續的投票用）
  const { X, Y, Z } = s.vol;
  let moved = (i: number) => i;
  if (op.kind === 'translate') {
    const keys = new Set(op.keys);
    const on = new Uint8Array(s.L.comps.length);
    s.L.comps.forEach((c, k) => {
      if (keys.has(c.key)) on[k] = 1;
    });
    const [dx, dy, dz] = op.d;
    moved = (i) => {
      const l = s.L.labels[i];
      if (l < 0 || !on[l]) return i;
      const x = i % X;
      const y = ((i - x) / X) % Y;
      const z = (i - x - y * X) / (X * Y);
      const tx = x + dx;
      const ty = y + dy;
      const tz = z + dz;
      return tx < 0 || ty < 0 || tz < 0 || tx >= X || ty >= Y || tz >= Z ? -1 : (tz * Y + ty) * X + tx;
    };
  }
  const info = relabelFast(s.vol, s.L, moved, next, ctx.matName, ctx.newKey, R);
  const step: Step = {
    data: { box: R, before: cropArr(s.vol.data, s.vol, R), after: cropArr(data, s.vol, R) },
    labels: info.S
      ? {
          box: info.S,
          before: cropArr(s.L.labels, s.vol, info.S),
          after: cropArr(info.L.labels, s.vol, info.S),
          moves: info.moves,
          compsBefore: s.L.comps,
          compsAfter: info.L.comps,
        }
      : null,
  };
  return { state: { vol: next, L: info.L }, step, report };
}
