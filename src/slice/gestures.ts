// 聰明游標（plan v7 §6）：熱區判斷、拖節點／推邊／搬區域的形狀、手勢 → Op。純函式，不碰 DOM。
import type { Axis, Backfill, Vec3 } from '../volume/volume';
import type { Op } from '../volume/ops';
import type { Scope } from '../volume/scope';
import { uvTo3D } from '../volume/scope';
import { encodeRle } from '../volume/rle';
import { recordGesture } from './relative';
import { type Ring, type XY, ringPolygon } from './trace';
import { deltaOf, editRing, rasterize } from './raster';
import { type DragArg, type NodeDrag, dragDisp, edgeAmount, groupNormal, isAxisEdge, isSingle, resolveNodeDrag, smoothEdgeGroup } from './snap';

export { dragDisp, dragDispFloat, dragModeOf, edgeAmount, falloffWeights, groupNormal, isAxisCorner, isAxisEdge, isSingle, resolveNodeDrag, smoothEdgeGroup, snapAmount } from './snap';
export type { DragArg, DragMode, NodeDrag } from './snap';

export type HandleKind = 'node' | 'edge' | 'region';
export interface Handle {
  kind: HandleKind;
  key: string;
  ring: number;
  /** node：pts 的索引；edge：段的索引（pts[i] → pts[i+1]）。 */
  index: number;
}

/** 熱區（螢幕像素，不隨縮放變）。 */
export const NODE_PX = 6;
export const EDGE_PX = 6;

const segDist = (p: XY, a: XY, b: XY) => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

/**
 * 游標在 p（切面座標，格子角＝整數）時抓到什麼：節點和邊都在範圍內時比「距離／各自的半徑」，近的贏（v10：不再節點一律優先，
 * 想推邊不會老是抓到角）；都沒有才是區域。zoom = 每格幾個螢幕像素。
 * inside(key, u, v)：那一格是不是這個結構（區域判斷用）。only：按住 V／E／R 時只看一種。
 */
export function hitTest(
  rings: Map<string, Ring[]>,
  p: XY,
  zoom: number,
  inside: (key: string, u: number, v: number) => boolean,
  only?: HandleKind,
  /** 哪些節點抓得到（plan v11 §4.10：自由形變關閉時只有矩形角）；省略＝全部。 */
  nodeOk?: (r: Ring, i: number) => boolean,
): Handle | null {
  const nodeR = NODE_PX / zoom;
  const edgeR = EDGE_PX / zoom;
  let node: Handle | null = null;
  let nd = Infinity;
  if (!only || only === 'node')
    for (const [key, rs] of rings)
      rs.forEach((r, ri) =>
        r.nodes.forEach((i) => {
          if (nodeOk && !nodeOk(r, i)) return;
          const d = Math.hypot(r.pts[i][0] - p[0], r.pts[i][1] - p[1]);
          if (d <= nodeR && d < nd) {
            nd = d;
            node = { kind: 'node', key, ring: ri, index: i };
          }
        }),
      );
  let edge: Handle | null = null;
  let ed = Infinity;
  if (!only || only === 'edge')
    for (const [key, rs] of rings)
      rs.forEach((r, ri) =>
        r.raw.forEach((seg, i) => {
          for (let k = 0; k + 1 < seg.length; k++) {
            const d = segDist(p, seg[k], seg[k + 1]);
            if (d <= edgeR && d < ed) {
              ed = d;
              edge = { kind: 'edge', key, ring: ri, index: i };
            }
          }
        }),
      );
  // 節點在熱區內就是節點。不能「節點與邊比正規化距離」：相鄰的邊都有一段以節點為端點，
  // 到邊的距離永遠 ≤ 到節點的距離，節點幾乎抓不到（游標落在整數像素、節點在小數位置）。
  // 「想推邊常抓到角」改由縮小節點熱區（8 → 6 px）解決。
  if (node && edge) return node;
  if (node || edge) return node ?? edge;
  if (!only || only === 'region') {
    const u = Math.floor(p[0]);
    const v = Math.floor(p[1]);
    for (const key of rings.keys()) if (inside(key, u, v)) return { kind: 'region', key, ring: -1, index: -1 };
  }
  return null;
}

/** Op 文字裡的節點拖法（falloff 沿用 v9 的「節點」）。 */
const NODE_WORD: Record<NodeDrag, string> = { corner: '角', single: '單點', falloff: '節點' };

const DIR_WORD: Record<string, string> = { '0,-1': '往上', '0,1': '往下', '-1,0': '往左', '1,0': '往右' };
/** 切面上的方向 → 字（主要那一軸）。 */
export function uvWord(du: number, dv: number) {
  if (Math.abs(du) >= Math.abs(dv)) return du > 0 ? '往右' : '往左';
  return dv > 0 ? '往下' : '往上';
}

export interface GestureCtx {
  axis: Axis;
  /** 手勢做在哪一片。 */
  at: number;
  scope: Scope;
  follow: boolean;
  backfill: Backfill;
  /** 所有已選結構（區域拖動時一起搬）。 */
  selKeys: string[];
  /** 這個結構在這一片的格子（切面座標）。 */
  inside: (key: string, u: number, v: number) => boolean;
  /** 這個結構在這一片的外框（切面座標，含端點）。 */
  sliceBox: (key: string) => { u0: number; v0: number; u1: number; v1: number } | null;
  nm: number;
}

/**
 * 手勢 → Op（plan v7 §6.3）：
 * - 推了一條和軸平行、而且就是結構在那一側最外面、橫跨整個結構的直邊 → push
 * - 搬了整個剖面 → translate（多選時每個結構各自搬）
 * - 其他（節點、斜邊、圓弧、部分邊、Shift 單段）→ profile
 * shift：拖法（DragArg；true ≡ single、false ≡ 依形狀自動選，節點見 resolveNodeDrag；邊只看是不是 single）。
 * 沒有任何改動回傳 null。
 */
export function gestureToOp(rings: Map<string, Ring[]>, h: Handle, delta: XY, shift: DragArg, g: GestureCtx): Op | null {
  const keys = h.kind === 'region' ? g.selKeys : [h.key];
  if (h.kind === 'region') {
    const du = Math.round(delta[0]);
    const dv = Math.round(delta[1]);
    if (!du && !dv) return null;
    return { kind: 'translate', keys, scope: g.scope, d: uvTo3D(g.axis, du, dv), backfill: g.backfill, follow: g.follow };
  }
  const r = rings.get(h.key)![h.ring];
  // 邊：法線方向的格數只算一次（push 的 n、文字、相對式記錄都用同一個；plan v15 B3）
  const amt = h.kind === 'edge' ? edgeAmount(r, h, delta, shift) : 0;
  if (h.kind === 'edge') {
    const group = smoothEdgeGroup(r, h.index, shift);
    const nrm = groupNormal(r, group);
    if (!amt) return null;
    const box = g.sliceBox(h.key);
    const axisN = Math.abs(nrm[0]) > 0.999 || Math.abs(nrm[1]) > 0.999;
    if (axisN && !isSingle(shift) && isAxisEdge(r, group) && box && !r.hole) {
      const du = Math.round(nrm[0]);
      const dv = Math.round(nrm[1]);
      const us = group.map((i) => r.pts[i][0]);
      const vs = group.map((i) => r.pts[i][1]);
      // 最外側：上邊 v = v0、下邊 v = v1+1、左邊 u = u0、右邊 u = u1+1；而且橫跨整個結構
      const outer = dv < 0 ? vs[0] === box.v0 : dv > 0 ? vs[0] === box.v1 + 1 : du < 0 ? us[0] === box.u0 : us[0] === box.u1 + 1;
      const span = dv ? Math.min(...us) === box.u0 && Math.max(...us) === box.u1 + 1 : Math.min(...vs) === box.v0 && Math.max(...vs) === box.v1 + 1;
      if (outer && span) {
        const dir: Vec3 = uvTo3D(g.axis, du, dv);
        return { kind: 'push', keys, scope: g.scope, dir, n: amt, follow: g.follow, backfill: g.backfill };
      }
    }
  }
  // 節點：先決定拖法（auto → corner／single），Op 與相對式記錄用同一個
  const mode = h.kind === 'node' ? resolveNodeDrag(r, h.index, shift) : shift;
  const disp = dragDisp(r, h, delta, mode);
  if (disp.every((d) => !d[0] && !d[1])) return null;
  const perKey = profileDelta(rings.get(h.key)!, h.ring, disp, (u, v) => g.inside(h.key, u, v));
  if (!perKey) return null;
  const text =
    h.kind === 'node'
      ? `${NODE_WORD[mode as NodeDrag]}${uvWord(Math.round(delta[0]), Math.round(delta[1]))}移 (${Math.round(delta[0])}, ${Math.round(delta[1])})`
      : `${isSingle(shift) ? '單段' : '邊'}往${amt > 0 ? '外' : '內'} ${Math.abs(amt)} vx（${(Math.abs(amt) * g.nm).toFixed(1)} nm）`;
  // 相對式（§7.8）：記下手勢本身，每一片找同一個把手重做
  const rel = recordGesture(rings.get(h.key)!, h, delta, amt, mode);
  return { kind: 'profile', keys, scope: g.scope, at: g.at, perKey: { [h.key]: perKey }, follow: g.follow, backfill: g.backfill, text, ...(rel ? { gestures: { [h.key]: rel } } : {}) };
}

/**
 * 這個手勢取整之後的身分（plan v15 B3）：同一個 key ⇒ gestureToOp 的 Op 逐欄相同（JSON 相同），
 * 所以拖拉中每個 rAF 先算 key，和上一幀相同就沿用上一幀的 Op，不重跑光柵化／BFS／RLE，也不再送預覽。
 * - region：取整的位移 (du, dv)
 * - edge：法線方向的格數（push 的 n／profile 的位移）＋取整的位移（RelGesture.delta 記的是它）
 * - node：dragDisp 的整數位移串（含拖法）＋取整的位移（文字與 RelGesture.delta）
 * 回傳字串只拿來比較，不要解析。rings 裡沒有這個把手回傳 ''。
 */
export function gestureKey(rings: Map<string, Ring[]>, h: Handle, delta: XY, shift: DragArg): string {
  const du = Math.round(delta[0]);
  const dv = Math.round(delta[1]);
  if (h.kind === 'region') return `r:${du},${dv}`;
  const r = rings.get(h.key)?.[h.ring];
  if (!r) return '';
  if (h.kind === 'edge') return `e:${h.key}/${h.ring}/${h.index}:${edgeAmount(r, h, delta, shift)}|${du},${dv}|${isSingle(shift) ? 1 : 0}`;
  const mode = resolveNodeDrag(r, h.index, shift);
  const disp = dragDisp(r, h, delta, mode);
  let out = `n:${h.key}/${h.ring}/${h.index}:${mode}|${du},${dv}|`;
  // 只記有動的頂點（多數是 0）
  for (let i = 0; i < disp.length; i++) if (disp[i][0] || disp[i][1]) out += `${i}=${disp[i][0]},${disp[i][1]};`;
  return out;
}

/**
 * 一個結構的環（第 ring 個改了 disp）→ 這一片要加、要拿的格子（RLE）。沒有改到回傳 null。
 * plan v15 B3：掃描範圍只取「第 ring 環改前 ∪ 改後」的外框（其他環改前 === 改後，偶奇規則下它們在這個外框外面
 * 的貢獻前後相同、差為 0）；rasterize 仍傳全部多邊形（洞的奇偶規則要對），只在這個外框裡光柵化，
 * before 的 inside() 也只掃這個外框。差的格子離外框邊至少 1 格，所以 BFS 的發現順序和整個聯集外框時相同。
 */
export function profileDelta(rs: Ring[], ring: number, disp: XY[], inside: (u: number, v: number) => boolean) {
  const after = rs.map((r, i) => (i === ring ? editRing(r, disp) : ringPolygon(r)));
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of [after[ring], ringPolygon(rs[ring])])
    for (const [u, v] of p) {
      u0 = Math.min(u0, Math.floor(u) - 1);
      v0 = Math.min(v0, Math.floor(v) - 1);
      u1 = Math.max(u1, Math.ceil(u) + 1);
      v1 = Math.max(v1, Math.ceil(v) + 1);
    }
  if (u0 > u1) return null;
  const W = u1 - u0 + 1;
  const H = v1 - v0 + 1;
  const before = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u + u0, v + v0)) before[v * W + u] = 1;
  const aft = rasterize(after, u0, v0, W, H);
  const { add, remove } = deltaOf(before, aft, u0, v0, W, H);
  if (!add.length && !remove.length) return null;
  return { add: encodeRle(add), remove: encodeRle(remove) };
}

export { DIR_WORD };
