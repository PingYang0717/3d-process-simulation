// 即時預覽：一步操作只會改到選取外框附近，所以把那一小塊裁下來、在主執行緒用同一組純函式算一次，
// 幾十毫秒就能畫出結果；Worker 的正式結果（含 relabel）之後再覆蓋。裁下來的範圍內逐體素和正式結果相同（有測試）。
import { type BBox, type Labeled, type Vec3, type Volume, LINER_MAX, adjacentMasks, growMask, lockTable, newPushTrace, setMaskMaterial, translateMask, unionBBox } from './volume';
import { type AdjPushOp, type AdjTranslateOp, type EditState, type Op, adjacentDir, isAdjacent } from './ops';
import { axisIndex } from './scope';
import { type Report, newReport } from './kernel';

export interface Preview {
  /** 裁切範圍（含端點，整個陣列的座標）。 */
  box: BBox;
  /** 範圍內的結果，shape = 外框大小。 */
  data: Uint8Array;
}

/** 推面／補平沿法線方向多留的格數：|n| 之外再加幾層襯層的厚度（collectLiners 一次最多收幾層薄層）。 */
const LINER_MARGIN = LINER_MAX * 4 + 1;

export const boxVoxels = (b: BBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);

const clampBox = (b: BBox, v: Volume): BBox | null => {
  const out = {
    x0: Math.max(0, b.x0),
    y0: Math.max(0, b.y0),
    z0: Math.max(0, b.z0),
    x1: Math.min(v.X - 1, b.x1),
    y1: Math.min(v.Y - 1, b.y1),
    z1: Math.min(v.Z - 1, b.z1),
  };
  return out.x0 <= out.x1 && out.y0 <= out.y1 && out.z0 <= out.z1 ? out : null;
};

const lo = (b: BBox): Vec3 => [b.x0, b.y0, b.z0];
const hi = (b: BBox): Vec3 => [b.x1, b.y1, b.z1];
const fromLoHi = (l: Vec3, h: Vec3): BBox => ({ x0: l[0], y0: l[1], z0: l[2], x1: h[0], y1: h[1], z1: h[2] });

/** 裁一塊出來（複製）。 */
export function cropVolume(v: Volume, b: BBox): Volume {
  const X = b.x1 - b.x0 + 1;
  const Y = b.y1 - b.y0 + 1;
  const Z = b.z1 - b.z0 + 1;
  const data = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const src = ((z + b.z0) * v.Y + y + b.y0) * v.X + b.x0;
      data.set(v.data.subarray(src, src + X), (z * Y + y) * X);
    }
  return { X, Y, Z, data };
}

/** 選取結構在裁切範圍內的 mask（不必先做整個陣列的 mask）。 */
export function cropMask(L: Labeled, keys: Set<string>, v: Volume, b: BBox): Uint8Array {
  const on = new Uint8Array(L.comps.length);
  L.comps.forEach((c, i) => {
    if (keys.has(c.key)) on[i] = 1;
  });
  const X = b.x1 - b.x0 + 1;
  const Y = b.y1 - b.y0 + 1;
  const Z = b.z1 - b.z0 + 1;
  const out = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const src = ((z + b.z0) * v.Y + y + b.y0) * v.X + b.x0;
      const dst = (z * Y + y) * X;
      for (let x = 0; x < X; x++) {
        const l = L.labels[src + x];
        if (l >= 0 && on[l]) out[dst + x] = 1;
      }
    }
  return out;
}

/**
 * 這一步會動到的範圍：選取外框，推面／補平沿法線兩側多留 |n|＋襯層，筆刷只留筆刷蓋到的列，
 * 平移是外框 ∪ 搬到的地方。超出陣列的部分切掉；選取不存在回傳 null。
 */
export function previewBox(s: EditState, op: Op): BBox | null {
  return previewBoxTrial(s, op).box;
}

/** 決定裁切範圍時順便算出來的結果（跟著移動的推拉；plan v19 §3.1）：裁切範圍內的結果與報告（座標是裁切範圍的）。 */
export interface BoxTrial {
  data: Uint8Array;
  report: Report;
}

/**
 * previewBox，外加試算的結果：跟著移動的推拉要實際算一次才知道旁邊哪些薄層排會跟著動、讀到多遠，
 * 那一次的結果就是這一步的結果，呼叫端（applyOpPrepare、probe）直接拿去用，不必再算第二次。
 */
export function previewBoxTrial(s: EditState, op: Op, budgetMs?: number): { box: BBox | null; trial?: BoxTrial } {
  const keys = new Set(op.keys);
  const b = unionBBox(s.L.comps.filter((c) => keys.has(c.key)));
  if (!b) return { box: null };
  if (isAdjacent(op)) return adjacentBox(s, op, b, budgetMs);
  return { box: plainBox(s, op, b) };
}

function plainBox(s: EditState, op: Exclude<Op, AdjPushOp | AdjTranslateOp>, b: BBox): BBox | null {
  const l = lo(b);
  const h = hi(b);
  // scope 比結構短：沿 scope 的軸只算 scope 那一段（推面的方向和 scope 同軸時不行：最外側的面要看整根）
  const sa = axisIndex(op.scope.axis);
  const along = op.kind === 'push' && (op.dir[0] ? 0 : op.dir[1] ? 1 : 2) === sa;
  if (op.kind !== 'translate' && !along) {
    l[sa] = Math.max(l[sa], op.scope.lo);
    h[sa] = Math.min(h[sa], op.scope.hi);
    if (l[sa] > h[sa]) return null;
  }
  if (op.kind === 'push') {
    const a = op.dir[0] ? 0 : op.dir[1] ? 1 : 2;
    const reach = Math.abs(op.n) + LINER_MARGIN;
    l[a] -= reach;
    h[a] += reach;
    return clampBox(fromLoHi(l, h), s.vol);
  }
  if (op.kind === 'translate') {
    // 帶殼：殼最多在結構外 LINER_MARGIN 格
    if (op.follow)
      for (let k = 0; k < 3; k++) {
        l[k] -= LINER_MARGIN;
        h[k] += LINER_MARGIN;
      }
    for (let k = 0; k < 3; k++) {
      l[k] = Math.min(l[k], l[k] + op.d[k]);
      h[k] = Math.max(h[k], h[k] + op.d[k]);
    }
    return clampBox(fromLoHi(l, h), s.vol);
  }
  return clampBox(b, s.vol);
}

/**
 * 'adjacent'（plan v21 §3）的裁切範圍：裁切邊界不能被誤當成模型邊界，所以讀到哪裡都要包進來。
 * 跟著動的那一串一路到模型邊界或固定的結構為止，所以沿推的方向直接開到模型邊界（平移兩頭都開）；
 * 旁邊哪些排會一起動要實際算過才知道（每推一格都可能多收幾排）——在範圍裡實際算一次（adjTrial），
 * 動到的排碰到範圍的側邊（那一邊不是模型邊界）就把側邊加倍重算。那一次的結果就是這一步的結果。
 */
function adjacentBox(s: EditState, op: AdjPushOp | AdjTranslateOp, b: BBox, budgetMs?: number): { box: BBox | null; trial?: BoxTrial } {
  const { dir, n } = adjacentDir(op);
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const sg = dir[a] > 0 ? 1 : -1;
  const l = lo(b);
  const h = hi(b);
  const dims = [s.vol.X, s.vol.Y, s.vol.Z];
  const u = a === 0 ? 1 : 0;
  const w = a === 2 ? 1 : 2;
  const keys = [...new Set(op.keys)];
  const table = lockTable(s.L, op.locks);
  // 沿軸：先多留 |n|＋ADJ_REACH 格（外圍都固定時，跟著動的那一串很快就碰到固定的結構）；
  // 有一排一路讀到裁切範圍的盡頭（那一頭不是模型邊界）就把那一頭放大重算。平移兩頭都會讀，推拉只有推的那一頭。
  const reach = Math.abs(n) + ADJ_REACH;
  let extP = op.kind === 'translate' || sg > 0 ? reach : 0;
  let extN = op.kind === 'translate' || sg < 0 ? reach : 0;
  // 側邊先多留 4 格；碰到就 32 格；再碰到就整個平面（沒固定的材質一路連出去時本來就會到那裡，不必一次一次加倍重算）
  let side = 4;
  for (;;) {
    const bl = l.slice() as Vec3;
    const bh = h.slice() as Vec3;
    if (side === Infinity) {
      bl[u] = 0;
      bh[u] = dims[u] - 1;
      bl[w] = 0;
      bh[w] = dims[w] - 1;
    } else {
      bl[u] -= side;
      bh[u] += side;
      bl[w] -= side;
      bh[w] += side;
    }
    bh[a] = extP === Infinity ? dims[a] - 1 : bh[a] + extP;
    bl[a] = extN === Infinity ? 0 : bl[a] - extN;
    const box = clampBox(fromLoHi(bl, bh), s.vol);
    if (!box) return { box: null };
    const vol = cropVolume(s.vol, box);
    const masks = keys.map((k) => cropMask(s.L, new Set([k]), s.vol, box));
    const report = newReport();
    const trace = newPushTrace();
    const data = adjacentMasks(vol, masks, op.kind, dir, n, cropLock(s.L, table, s.vol, box), report, trace, budgetMs === undefined ? undefined : performance.now() + budgetMs).data;
    const cl = lo(box);
    const ch = hi(box);
    const cd = [vol.X, vol.Y, vol.Z];
    const sideHit =
      (trace.ulo === 0 && cl[u] > 0) || (trace.uhi === cd[u] - 1 && ch[u] < dims[u] - 1) || (trace.wlo === 0 && cl[w] > 0) || (trace.whi === cd[w] - 1 && ch[w] < dims[w] - 1);
    const farP = trace.offP && ch[a] < dims[a] - 1;
    const farN = trace.offN && cl[a] > 0;
    if (!sideHit && !farP && !farN) return { box, trial: { data, report } };
    if (sideHit) side = side < 32 ? 32 : Infinity;
    // 沿軸：先放大 4 倍、再不夠才開到模型邊界（隔著一段空氣才碰到固定的結構時，不必整條都算）
    if (farP) extP = extP < reach * 4 ? reach * 4 : Infinity;
    if (farN) extN = extN < reach * 4 ? reach * 4 : Infinity;
  }
}

/** 'adjacent'：沿推的方向先多留這麼多格（|n| 之外）。 */
export const ADJ_REACH = 24;

/** 固定的格子在裁切範圍內的 lock（table＝lockTable 的結果；沒有固定的結構回傳 null）。 */
export function cropLock(L: Labeled, table: Uint8Array, v: Volume, b: BBox): Uint8Array | null {
  if (!table.some((x) => x)) return null;
  const X = b.x1 - b.x0 + 1;
  const Y = b.y1 - b.y0 + 1;
  const Z = b.z1 - b.z0 + 1;
  const out = new Uint8Array(X * Y * Z);
  for (let z = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) {
      const src = ((z + b.z0) * v.Y + y + b.y0) * v.X + b.x0;
      const dst = (z * Y + y) * X;
      for (let x = 0; x < X; x++) {
        const l = L.labels[src + x];
        if (l >= 0) out[dst + x] = table[l];
      }
    }
  return out;
}

/** 把試算的報告併進呼叫端的報告（和 adjacentMasks 直接寫進去的結果相同）。 */
export function mergeReport(to: Report, from: Report) {
  to.filled += from.filled;
  to.pushed += from.pushed;
  to.removed += from.removed;
  to.blocked += from.blocked;
  for (const [k, v] of Object.entries(from.blockedBy)) to.blockedBy[+k] = (to.blockedBy[+k] ?? 0) + v;
  to.blockedAt.push(...from.blockedAt);
  to.done = (to.done ?? 0) + (from.done ?? 0);
  to.stop = from.stop;
  if (from.more) to.more = true;
  if (from.gaps) to.gaps = [...new Set([...(to.gaps ?? []), ...from.gaps])];
}

/**
 * 在裁切範圍內算這一步的結果；範圍超過 cap 個體素就回傳 null（留給 Worker）。
 * 範圍內逐體素和 applyOp 的結果相同；範圍外這一步本來就不會改到。
 * box：呼叫端已經算好的 previewBox（applyOpInPlace 傳進來，同一個 Op 不算第二次；plan v15 §5.1）。
 */
export function previewOp(s: EditState, orig: Volume, op: Op, cap = Infinity, report?: Report, box0?: BBox | null): Preview | null {
  let box = box0;
  if (box === undefined) {
    const t = previewBoxTrial(s, op);
    box = t.box;
    // 決定範圍時已經算好了（跟著移動的推拉）：直接用
    if (box && t.trial && boxVoxels(box) <= cap) {
      if (report) mergeReport(report, t.trial.report);
      return { box, data: t.trial.data };
    }
  }
  if (!box || boxVoxels(box) > cap) return null;
  const vol = cropVolume(s.vol, box);
  const o = cropVolume(orig, box);
  if (isAdjacent(op)) {
    const { dir, n } = adjacentDir(op);
    const masks = [...new Set(op.keys)].map((k) => cropMask(s.L, new Set([k]), s.vol, box));
    return { box, data: adjacentMasks(vol, masks, op.kind, dir, n, cropLock(s.L, lockTable(s.L, op.locks), s.vol, box), report).data };
  }
  const mask = cropMask(s.L, new Set(op.keys), s.vol, box);
  // scope 換成裁切範圍裡的座標（超出的部分本來就不會被改）
  const off = [box.x0, box.y0, box.z0][axisIndex(op.scope.axis)];
  const zr = { axis: op.scope.axis, lo: op.scope.lo - off, hi: op.scope.hi - off };
  let out: Volume;
  if (op.kind === 'push') out = growMask(vol, o, mask, zr, op.dir, op.n, op.backfill, op.follow, report, op.policy ?? 'overwrite');
  else if (op.kind === 'translate') out = translateMask(vol, o, mask, zr, op.d, op.backfill, !!op.follow);
  else out = setMaskMaterial(vol, mask, zr, op.m);
  return { box, data: out.data };
}
