// 一步操作只在外框裡算（plan v7 §8.2）：裁下 previewBox、在裁切範圍裡跑同一組純函式，
// 找出真正改到的外框，貼回陣列；relabel 直接吃這個外框，不必掃整個陣列找哪裡不同。
// plan v9 §4.3：applyOpInPlace 直接改 data／labels（不影印整個陣列）；applyOpLocal 是複製後呼叫它的純函式包裝。
// 結果和 applyOp 逐體素相同（apply.test.ts）。
import { type Comp, type Labeled, type Volume, relabelInPlace } from './volume';
import { type EditState, type LegacyOp, type Op, type OpContext, upgradeOp } from './ops';
import { previewBox, previewOp } from './preview';
import { type Step, cropArr, diffInBox, globalIndex, pasteArr } from './patch';
import { type Report, newReport } from './kernel';
import { axisIndex } from './scope';

export interface Applied {
  state: { vol: Volume; L: Labeled };
  step: Step;
  report: Report;
}

export interface AppliedInPlace {
  /** 新的 comps（沒改到＝原本的）。 */
  comps: Comp[];
  step: Step;
  report: Report;
}

/**
 * 原地套一步：s.vol.data 與 s.L.labels 直接改成結果。順序：先在裁切盒裡算 → 找出 R → 裁「改前」→ 貼 → 原地 relabel。
 * 沒改到任何體素時陣列不動、step 全是 null。
 */
export function applyOpInPlace(s: EditState, input: Op | LegacyOp, ctx: OpContext): AppliedInPlace {
  const op = upgradeOp(input);
  const report = newReport();
  const none: AppliedInPlace = { comps: s.L.comps, step: { data: null, labels: null }, report };
  const box = previewBox(s, op);
  if (!box) return none;
  const p = previewOp(s, ctx.orig, op, Infinity, report)!;
  if (op.kind === 'profile') {
    // scope 裡、選取外框外面的片：這個結構根本不在，算略過
    const a = axisIndex(op.scope.axis);
    const [blo, bhi] = [[box.x0, box.y0, box.z0][a], [box.x1, box.y1, box.z1][a]];
    for (let t = op.scope.lo; t <= op.scope.hi; t++) if (t < blo || t > bhi) report.skipped.push(t);
  }
  // 被擋的格子：裁切範圍的 index → 整個陣列
  report.blockedAt = globalIndex(box, s.vol, report.blockedAt);
  const cropped = cropArr(s.vol.data, s.vol, box);
  const R = diffInBox(cropped, p.data, box);
  if (!R) return none;
  const before = cropArr(s.vol.data, s.vol, R);
  const data = s.vol.data;
  pasteArr(data, s.vol, box, p.data);
  const after = cropArr(data, s.vol, R);
  // 平移時已選結構的體素照位移對應（名稱延續的投票用）；o＝這一格的舊編號
  const { X, Y, Z } = s.vol;
  let moved = (i: number, _o: number) => i;
  if (op.kind === 'translate') {
    const keys = new Set(op.keys);
    const on = new Uint8Array(s.L.comps.length);
    s.L.comps.forEach((c, k) => {
      if (keys.has(c.key)) on[k] = 1;
    });
    const [dx, dy, dz] = op.d;
    moved = (i, l) => {
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
  const labels = s.L.labels;
  const info = relabelInPlace(labels, s.L.comps, before, s.vol, moved, ctx.matName, ctx.newKey, R);
  const step: Step = {
    data: { box: R, before, after },
    labels: {
      box: info.S,
      before: info.before,
      after: cropArr(labels, s.vol, info.S),
      moves: info.moves,
      compsBefore: s.L.comps,
      compsAfter: info.comps,
    },
  };
  return { comps: info.comps, step, report };
}

/** 純函式版本：複製 data／labels 後原地套用，s 不變。 */
export function applyOpLocal(s: EditState, input: Op | LegacyOp, ctx: OpContext): Applied {
  const vol: Volume = { X: s.vol.X, Y: s.vol.Y, Z: s.vol.Z, data: s.vol.data.slice() };
  const labels = s.L.labels.slice();
  const r = applyOpInPlace({ vol, L: { labels, comps: s.L.comps } }, input, ctx);
  if (!r.step.data) return { state: { vol: s.vol, L: s.L }, step: r.step, report: r.report };
  return { state: { vol, L: { labels, comps: r.comps } }, step: r.step, report: r.report };
}
