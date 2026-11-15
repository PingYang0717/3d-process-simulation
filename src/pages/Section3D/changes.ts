// 「改了哪些」：目前和原始比，哪些結構不一樣、差在哪裡（狀態，不是一步一步的歷程；復原之後自然就少一行）。
import type { BBox, Comp } from '../../volume/volume';
import type { EditState } from '../../volume/ops';
import { type FaceName, nmText } from './stepWords';

export interface ChangeRow {
  mat: number;
  /** 這一行的結構（同材質、同一種改動的合成一行）；已消失的是原始的結構。 */
  comps: Comp[];
  /** 怎麼不一樣（「上面外推 2 格（1.0 nm）」「往右移 3 格」「由 SiN 換成 SiGe」…）。 */
  text: string;
  /** 和原始不同的體素數（現在屬於它的＋原本屬於它的）。 */
  voxels: number;
  gone: boolean;
}

/** 每一面往外多了幾格（負＝內縮）；上＝y 變小、前＝z 變大（和 stepWords 的 FACES 一致）。 */
const faceDeltas = (o: BBox, c: BBox): [FaceName, number][] => [
  ['上', o.y0 - c.y0],
  ['下', c.y1 - o.y1],
  ['左', o.x0 - c.x0],
  ['右', c.x1 - o.x1],
  ['前', c.z1 - o.z1],
  ['後', o.z0 - c.z0],
];

function describe(o: Comp | undefined, c: Comp, matName: (id: number) => string, nm: number): string {
  if (!o) return '新出現的結構';
  const parts: string[] = [];
  if (o.mat !== c.mat) parts.push(`由 ${matName(o.mat)} 換成 ${matName(c.mat)}`);
  const d = faceDeltas(o.bbox, c.bbox);
  const moved = o.count === c.count && d[0][1] === -d[1][1] && d[2][1] === -d[3][1] && d[4][1] === -d[5][1];
  for (const [f, n] of d) {
    if (!n) continue;
    if (moved) {
      if (n > 0) parts.push(`往${f}移 ${n} 格（${nmText(n, nm)}）`);
    } else parts.push(`${f}面${n > 0 ? '外推' : '內縮'} ${Math.abs(n)} 格（${nmText(n, nm)}）`);
  }
  if (!parts.length) {
    const dv = c.count - o.count;
    parts.push(dv ? `體積${dv > 0 ? '多' : '少'}了 ${Math.abs(dv).toLocaleString()} 體素` : '形狀有改動');
  }
  return parts.join('、');
}

export function changesOf(
  orig: EditState,
  cur: EditState,
  diff: Uint8Array | null,
  touch: BBox | null,
  matName: (id: number) => string,
  nmPerVoxel: number,
): ChangeRow[] {
  if (!diff || !touch || cur === orig) return [];
  const { X, Y } = cur.vol;
  const cl = cur.L.labels;
  const ol = orig.L.labels;
  const cc = cur.L.comps;
  const oc = orig.L.comps;
  const nCur = new Int32Array(cc.length);
  const nOrig = new Int32Array(oc.length);
  for (let z = touch.z0; z <= touch.z1; z++)
    for (let y = touch.y0; y <= touch.y1; y++)
      for (let i = (z * Y + y) * X + touch.x0, e = i + touch.x1 - touch.x0; i <= e; i++) {
        if (!diff[i]) continue;
        const a = cl[i];
        const b = ol[i];
        if (a >= 0) nCur[a]++;
        if (b >= 0 && (a < 0 || cc[a].key !== oc[b].key)) nOrig[b]++;
      }
  const origIdx = new Map(oc.map((c, i) => [c.key, i]));
  const rows = new Map<string, ChangeRow>();
  const add = (c: Comp, text: string, voxels: number, gone: boolean) => {
    const k = `${c.mat}|${gone ? 1 : 0}|${text}`;
    const r = rows.get(k);
    if (r) {
      r.comps.push(c);
      r.voxels += voxels;
    } else rows.set(k, { mat: c.mat, comps: [c], text, voxels, gone });
  };
  // 整個搬走的結構和原來的位置不重疊，key 會換新的：把「不見的」和「新出現的」配回同一個（同材質、同體素數、同外框大小；
  // 配不到而那個材質剛好各只有一個，也算同一個）
  const alive = new Set(cc.map((c) => c.key));
  const gone = oc.flatMap((o, i) => (o.mat !== 0 && !alive.has(o.key) ? [i] : []));
  const fresh = cc.flatMap((c, i) => (c.mat !== 0 && !origIdx.has(c.key) ? [i] : []));
  const dims = (b: BBox) => `${b.x1 - b.x0},${b.y1 - b.y0},${b.z1 - b.z0}`;
  const pair = new Map<number, number>();
  const used = new Set<number>();
  for (const ci of fresh) {
    const c = cc[ci];
    const oi = gone.find((g) => !used.has(g) && oc[g].mat === c.mat && oc[g].count === c.count && dims(oc[g].bbox) === dims(c.bbox));
    if (oi !== undefined) (pair.set(ci, oi), used.add(oi));
  }
  for (const ci of fresh) {
    if (pair.has(ci)) continue;
    const same = (m: number) => fresh.filter((f) => !pair.has(f) && cc[f].mat === m).length === 1;
    const cand = gone.filter((g) => !used.has(g) && oc[g].mat === cc[ci].mat);
    if (cand.length === 1 && same(cc[ci].mat)) (pair.set(ci, cand[0]), used.add(cand[0]));
  }
  cc.forEach((c, i) => {
    if (c.mat === 0) return;
    const oi = origIdx.get(c.key) ?? pair.get(i);
    const o = oi === undefined ? undefined : oc[oi];
    const voxels = nCur[i] + (oi === undefined ? 0 : nOrig[oi]);
    if (!voxels && o && o.mat === c.mat) return;
    add(c, describe(o, c, matName, nmPerVoxel), voxels, false);
  });
  for (const i of gone) if (!used.has(i)) add(oc[i], '已經消失', nOrig[i], true);
  return [...rows.values()].sort((p, q) => p.mat - q.mat || Number(p.gone) - Number(q.gone));
}
