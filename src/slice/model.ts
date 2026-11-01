// 切面幾何層（plan v8 §6、§7）：進入 2D 編輯時把已選結構的剖面描一次成有頂點 id 的幾何，
// 之後拖節點、推邊、搬區域都改這份幾何（放開立刻更新，不等 Worker），寫回 voxel 後不重描，只驗證
// 「幾何光柵化 === voxel」。所以節點不會跑、鋸齒不會每一步重新量化。
// 幾何不是模型：voxel 永遠是真相。驗證失敗一律以 voxel 為準（重描，舊節點用最近角對應、id 沿用）。
// 給手勢用的是 ringsOf(model)：和 v7 traceRings 同樣形狀的 Ring（pts／raw／nodes／hole），
// 所以 gestures／relative／mirror 的規則與 Op 都不變（剛建立時 ringsOf ≡ traceRings，黃金測試）。
import type { Axis, Labeled, Volume } from '../volume/volume';
import { axisIndex, planeAxes, to3D } from '../volume/scope';
import { type Ring, type XY, traceRings } from './trace';
import { rasterize } from './raster';

export type VId = string;
export interface SVertex {
  id: VId;
  u: number;
  v: number;
}
/** 一個環：key＝結構，loop＝頂點 id 序列（封閉、不重複第一點）。內環（洞）是另一個 hole 的環，順序同 traceRings。 */
export interface SRing {
  key: string;
  loop: VId[];
  hole: boolean;
}
export interface SliceModel {
  axis: Axis;
  at: number;
  /** 幾何和哪一個版本（EditState.version）的 voxel 對得上；驗證、失效判斷用。 */
  baseVersion: number;
  /** 放開後已經更新、還在等 Worker 的結果（這段時間不驗證）；pendingFrom＝當時的版本。 */
  pending: boolean;
  pendingFrom: number;
  /** 放開時 editor 的步數（stepSeq）；之後步數變大＝那一步算完了。 */
  pendingSeq: number;
  vertices: Record<VId, SVertex>;
  rings: SRing[];
  /** 簡化段 a|b → 原始像素折線（含兩端），a 端在前。沒動的段＝原始階梯，動過的是被內插的折線。 */
  exact: Map<string, XY[]>;
  /** 可拖的節點。 */
  handles: Set<VId>;
  /** 使用者刪掉的節點（重描時對到它的角不再變回節點）。 */
  removed: Set<VId>;
  /** 使用者雙擊加的節點（重描對不到就消失，訊息提示）。 */
  custom: Set<VId>;
  /** 幾何被拖過（和重新描的不一樣了）的結構：它們的 profile Op 參考片用絕對格子（refExact）。 */
  edited: Set<string>;
  /** 每個頂點這一段手勢開始時的座標（commit 後更新成新基準）。 */
  origin: Record<VId, XY>;
  seq: number;
  /** 每改一次加一（ringsOf 的快取 key）。 */
  rev: number;
}

export const segKey = (a: VId, b: VId) => `${a}|${b}`;
/** 重描時舊節點對應到新頂點的距離上限（格）。 */
export const MATCH_TOL = 1.5;

/** 一片上某結構的 inside 與描輪廓的範圍（結構外框投影到切面）。 */
export function sliceOfKey(L: Labeled, vol: Volume, axis: Axis, at: number, key: string) {
  const k = L.comps.findIndex((c) => c.key === key);
  if (k < 0) return null;
  const a = axisIndex(axis);
  const [ua, va] = planeAxes(axis);
  const dims = [vol.X, vol.Y, vol.Z];
  const b = L.comps[k].bbox;
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  if (at < lo[a] || at > hi[a]) return null;
  const inside = (u: number, v: number) => {
    if (u < 0 || v < 0 || u >= dims[ua] || v >= dims[va]) return false;
    const p = to3D(axis, u, v, at);
    return L.labels[(p[2] * vol.Y + p[1]) * vol.X + p[0]] === k;
  };
  return { inside, u0: lo[ua], v0: lo[va], u1: hi[ua], v1: hi[va] };
}

const newId = (m: SliceModel) => `v${m.seq++}`;

/** 把 traceRings 的結果放進模型（給新 id），回傳每個環在 m.rings 的位置。 */
function addRings(m: SliceModel, key: string, rs: Ring[]) {
  for (const r of rs) {
    const ids = r.pts.map(() => newId(m));
    r.pts.forEach((p, i) => {
      m.vertices[ids[i]] = { id: ids[i], u: p[0], v: p[1] };
      m.origin[ids[i]] = [p[0], p[1]];
      if (r.nodes.has(i)) m.handles.add(ids[i]);
    });
    r.raw.forEach((seg, i) => m.exact.set(segKey(ids[i], ids[(i + 1) % ids.length]), seg.map((q) => [q[0], q[1]] as XY)));
    m.rings.push({ key, loop: ids, hole: r.hole });
  }
}

/** 測試／bench 用：描了幾次輪廓、驗證了幾個結構（plan v15 A4：沒碰到的片這兩個都不該動）。 */
export const modelStats = { traced: 0, verified: 0 };

/** 一個結構這一片的輪廓（v7 的 traceRings）。 */
function traceKey(L: Labeled, vol: Volume, axis: Axis, at: number, key: string): Ring[] {
  modelStats.traced++;
  const s = sliceOfKey(L, vol, axis, at, key);
  return s ? traceRings(s.inside, s.u0, s.v0, s.u1, s.v1) : [];
}

/** 建立（§7.1）：每個已選 key 描一次。 */
export function buildSliceModel(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[], version: number): SliceModel {
  const m: SliceModel = {
    axis,
    at,
    baseVersion: version,
    pending: false,
    pendingFrom: version,
    pendingSeq: 0,
    vertices: {},
    rings: [],
    exact: new Map(),
    handles: new Set(),
    removed: new Set(),
    custom: new Set(),
    edited: new Set(),
    origin: {},
    seq: 1,
    rev: 1,
  };
  for (const key of keys) addRings(m, key, traceKey(L, vol, axis, at, key));
  return m;
}

/** 模型裡有哪些結構（含這一片沒有的：空的也記，不必每次重描）。 */
const builtKeys = new WeakMap<SliceModel, Set<string>>();
/** 補上還沒描過的 key（換了選取）。 */
export function ensureKeys(m: SliceModel, L: Labeled, vol: Volume, keys: string[]) {
  let done = builtKeys.get(m);
  if (!done) {
    done = new Set(m.rings.map((r) => r.key));
    builtKeys.set(m, done);
  }
  let changed = false;
  for (const key of keys) {
    if (done.has(key)) continue;
    done.add(key);
    addRings(m, key, traceKey(L, vol, m.axis, m.at, key));
    changed = true;
  }
  if (changed) m.rev++;
}

const ringCache = new WeakMap<SliceModel, { rev: number; tag: string; out: Map<string, Ring[]>; ids: Map<string, VId[][]> }>();
/**
 * 給手勢的環（形狀同 traceRings）：pts＝頂點座標、raw＝exact seg、nodes＝handles 的索引。
 * 同一個 rev 回傳同一份（不要改它）。
 */
export function ringsOf(m: SliceModel, keys: string[]): Map<string, Ring[]> {
  return ringView(m, keys).out;
}
function ringView(m: SliceModel, keys: string[]) {
  const tag = keys.join(',');
  const c = ringCache.get(m);
  if (c && c.rev === m.rev && c.tag === tag) return c;
  const out = new Map<string, Ring[]>();
  const ids = new Map<string, VId[][]>();
  const want = new Set(keys);
  for (const sr of m.rings) {
    if (!want.has(sr.key)) continue;
    const n = sr.loop.length;
    const r: Ring = {
      pts: sr.loop.map((id) => [m.vertices[id].u, m.vertices[id].v] as XY),
      raw: sr.loop.map((id, i) => m.exact.get(segKey(id, sr.loop[(i + 1) % n]))!),
      nodes: new Set(sr.loop.flatMap((id, i) => (m.handles.has(id) ? [i] : []))),
      hole: sr.hole,
    };
    if (!out.has(sr.key)) {
      out.set(sr.key, []);
      ids.set(sr.key, []);
    }
    out.get(sr.key)!.push(r);
    ids.get(sr.key)!.push(sr.loop);
  }
  // 照 keys 的順序（和 v7 sliceRings 一樣）
  const sorted = new Map(keys.filter((k) => out.has(k)).map((k) => [k, out.get(k)!] as const));
  const v = { rev: m.rev, tag, out: sorted, ids };
  ringCache.set(m, v);
  return v;
}

/** 手勢的把手 → 頂點 id（節點＝那個頂點；邊＝段的起點）。 */
export function vidOf(m: SliceModel, key: string, ring: number, index: number): VId | null {
  const rs = m.rings.filter((r) => r.key === key);
  return rs[ring]?.loop[index] ?? null;
}
/** 頂點 id → 它在 ringsOf 裡的位置。 */
export function locate(m: SliceModel, id: VId): { key: string; ring: number; index: number } | null {
  const per = new Map<string, number>();
  for (const r of m.rings) {
    const ri = per.get(r.key) ?? 0;
    per.set(r.key, ri + 1);
    const i = r.loop.indexOf(id);
    if (i >= 0) return { key: r.key, ring: ri, index: i };
  }
  return null;
}
const ringsOfKey = (m: SliceModel, key: string) => m.rings.filter((r) => r.key === key);

/** 一段折線兩端位移 d0、d1，沿長度內插（同 editRing）；回傳新折線（含兩端）。 */
export function segmentPts(seg: XY[], d0: XY, d1: XY): XY[] {
  const len: number[] = [0];
  for (let k = 1; k < seg.length; k++) len.push(len[k - 1] + Math.hypot(seg[k][0] - seg[k - 1][0], seg[k][1] - seg[k - 1][1]));
  const total = len[len.length - 1] || 1;
  return seg.map((p, k) => {
    const t = len[k] / total;
    return [p[0] + d0[0] + (d1[0] - d0[0]) * t, p[1] + d0[1] + (d1[1] - d0[1]) * t] as XY;
  });
}

/** 放開（§7.3）：第 ring 個環（ringsOf 的順序）每個頂點加上整數位移；exact seg 套同一個內插、存回，下一次從新形狀出發。 */
export function applyDisp(m: SliceModel, key: string, ring: number, disp: XY[]) {
  const sr = ringsOfKey(m, key)[ring];
  if (!sr) return;
  const n = sr.loop.length;
  sr.loop.forEach((a, i) => {
    const b = sr.loop[(i + 1) % n];
    const k = segKey(a, b);
    m.exact.set(k, segmentPts(m.exact.get(k)!, disp[i], disp[(i + 1) % n]));
  });
  sr.loop.forEach((id, i) => {
    const p = m.vertices[id];
    p.u += disp[i][0];
    p.v += disp[i][1];
    m.origin[id] = [p.u, p.v];
  });
  if (disp.some((d) => d[0] || d[1])) m.edited.add(key);
  m.rev++;
}

/** 整塊搬：這些結構的所有環一起平移。 */
export function translateKeys(m: SliceModel, keys: string[], d: XY) {
  const ks = new Set(keys);
  for (const sr of m.rings) {
    if (!ks.has(sr.key)) continue;
    applyDisp(m, sr.key, ringsOfKey(m, sr.key).indexOf(sr), sr.loop.map(() => d));
  }
}

/** 雙擊邊加節點：落在 exact seg 的第 j 個點上（形狀不變）。回傳新頂點 id。 */
export function insertNode(m: SliceModel, key: string, ring: number, seg: number, j: number): VId | null {
  const sr = ringsOfKey(m, key)[ring];
  if (!sr) return null;
  const n = sr.loop.length;
  const a = sr.loop[seg];
  const b = sr.loop[(seg + 1) % n];
  const pts = m.exact.get(segKey(a, b));
  if (!pts || j <= 0 || j >= pts.length - 1) return null;
  const id = newId(m);
  const p = pts[j];
  m.vertices[id] = { id, u: p[0], v: p[1] };
  m.origin[id] = [p[0], p[1]];
  m.exact.delete(segKey(a, b));
  m.exact.set(segKey(a, id), pts.slice(0, j + 1));
  m.exact.set(segKey(id, b), pts.slice(j));
  sr.loop.splice(seg + 1, 0, id);
  m.handles.add(id);
  m.custom.add(id);
  m.rev++;
  return id;
}

/** Delete：這個頂點不再是節點（形狀不變）。 */
export function removeHandle(m: SliceModel, id: VId) {
  if (!m.handles.delete(id)) return;
  m.removed.add(id);
  m.rev++;
}

/** 一個結構的所有環的完整折線（exact seg 接起來）。 */
export function keyPolygons(m: SliceModel, key: string): XY[][] {
  return ringsOfKey(m, key).map((sr) => sr.loop.flatMap((a, i) => m.exact.get(segKey(a, sr.loop[(i + 1) % sr.loop.length]))!.slice(0, -1)));
}

/** 幾何 → 格子（偶奇、格子中心），範圍 [u0..u0+W)×[v0..v0+H)。 */
export function rasterizeModel(m: SliceModel, key: string, u0: number, v0: number, W: number, H: number) {
  return rasterize(keyPolygons(m, key), u0, v0, W, H);
}

/**
 * 驗證（§7.4）：一個結構的幾何光柵化和這一片的 voxel 逐格比對；回傳不同的格子（切面座標）。
 */
export function verifyKey(m: SliceModel, L: Labeled, vol: Volume, key: string): XY[] {
  modelStats.verified++;
  const s = sliceOfKey(L, vol, m.axis, m.at, key);
  const polys = keyPolygons(m, key);
  let u0 = s ? s.u0 : Infinity;
  let v0 = s ? s.v0 : Infinity;
  let u1 = s ? s.u1 : -Infinity;
  let v1 = s ? s.v1 : -Infinity;
  for (const p of polys)
    for (const [u, v] of p) {
      u0 = Math.min(u0, Math.floor(u) - 1);
      v0 = Math.min(v0, Math.floor(v) - 1);
      u1 = Math.max(u1, Math.ceil(u) + 1);
      v1 = Math.max(v1, Math.ceil(v) + 1);
    }
  if (u0 > u1) return [];
  const W = u1 - u0 + 1;
  const H = v1 - v0 + 1;
  const want = rasterize(polys, u0, v0, W, H);
  const out: XY[] = [];
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const has = !!s && s.inside(u + u0, v + v0);
      if (has !== !!want[v * W + u]) out.push([u + u0, v + v0]);
    }
  return out;
}

export interface VerifyResult {
  /** 全部對得上。 */
  ok: boolean;
  /** 對不上而重描的結構與差異格。 */
  fixed: { key: string; diff: XY[]; lostCustom: number; kept: number; lost: number }[];
}

/**
 * 驗證每個結構；對不上的那個結構重描並保留節點 id（§7.5、§7.6）。
 * 「被擋住」（差異都在這一步的範圍裡）和「別的路徑改了 voxel」都走同一條：以 voxel 為準重描，
 * 舊節點找新幾何裡 ≤ 1.5 格的最近頂點（優先角）沿用 id。
 */
export function verifyAndFix(m: SliceModel, L: Labeled, vol: Volume, keys: string[], version: number): VerifyResult {
  const fixed: VerifyResult['fixed'] = [];
  for (const key of new Set(m.rings.map((r) => r.key).concat(keys))) {
    if (!keys.includes(key) && !m.rings.some((r) => r.key === key)) continue;
    const diff = verifyKey(m, L, vol, key);
    if (!diff.length) continue;
    const r = retraceKeepingHandles(m, L, vol, key);
    fixed.push({ key, diff, ...r });
  }
  m.baseVersion = version;
  m.pending = false;
  return { ok: !fixed.length, fixed };
}

/**
 * 重描一個結構（§7.6）：丟掉它的環、從 voxel 重新 traceRings，舊頂點 id 沿用到 ≤ 1.5 格的最近新頂點
 * （舊節點先挑，優先新的角）。被刪掉的節點對到的角不再是節點；自訂節點對不到就消失。
 */
export function retraceKeepingHandles(m: SliceModel, L: Labeled, vol: Volume, key: string) {
  const old = ringsOfKey(m, key).flatMap((sr) => sr.loop);
  const oldPos = old.map((id) => ({ id, u: m.vertices[id].u, v: m.vertices[id].v, handle: m.handles.has(id) }));
  // 拿掉舊的
  for (const sr of ringsOfKey(m, key)) {
    const n = sr.loop.length;
    sr.loop.forEach((a, i) => m.exact.delete(segKey(a, sr.loop[(i + 1) % n])));
  }
  for (const id of old) {
    delete m.vertices[id];
    delete m.origin[id];
    m.handles.delete(id);
  }
  m.rings = m.rings.filter((r) => r.key !== key);
  m.edited.delete(key);
  const rs = traceKey(L, vol, m.axis, m.at, key);
  // 新頂點：位置、是不是角
  const fresh: { ring: number; i: number; u: number; v: number; corner: boolean; id?: VId }[] = [];
  rs.forEach((r, ri) => r.pts.forEach((p, i) => fresh.push({ ring: ri, i, u: p[0], v: p[1], corner: r.nodes.has(i) })));
  const nearest = (o: { u: number; v: number }, pred: (f: (typeof fresh)[number]) => boolean) => {
    let best: (typeof fresh)[number] | null = null;
    let bd = MATCH_TOL + 1e-9;
    for (const f of fresh) {
      if (f.id || !pred(f)) continue;
      const d = Math.hypot(f.u - o.u, f.v - o.v);
      if (d <= bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  };
  let kept = 0;
  let lost = 0;
  let lostCustom = 0;
  const order = [...oldPos.filter((o) => o.handle), ...oldPos.filter((o) => !o.handle)];
  for (const o of order) {
    const f = (o.handle ? nearest(o, (x) => x.corner) : null) ?? nearest(o, () => true);
    if (f) {
      f.id = o.id;
      if (o.handle) kept++;
    } else if (o.handle) {
      lost++;
      if (m.custom.has(o.id)) lostCustom++;
    }
  }
  for (const id of old) if (!fresh.some((f) => f.id === id)) m.custom.delete(id);
  // 放回模型
  rs.forEach((r, ri) => {
    const mine = fresh.filter((f) => f.ring === ri);
    const ids = r.pts.map((_, i) => {
      const f = mine[i];
      return f.id ?? (f.id = newId(m));
    });
    r.pts.forEach((p, i) => {
      const id = ids[i];
      const wasHandle = oldPos.find((o) => o.id === id)?.handle;
      m.vertices[id] = { id, u: p[0], v: p[1] };
      m.origin[id] = [p[0], p[1]];
      if (wasHandle || (r.nodes.has(i) && !m.removed.has(id))) m.handles.add(id);
    });
    r.raw.forEach((seg, i) => m.exact.set(segKey(ids[i], ids[(i + 1) % ids.length]), seg.map((q) => [q[0], q[1]] as XY)));
    m.rings.push({ key, loop: ids, hole: r.hole });
  });
  // 同一個結構的環要排在一起、順序同 traceRings（ringsOf 依 m.rings 的順序）
  const others = m.rings.filter((r) => r.key !== key);
  const mine = m.rings.filter((r) => r.key === key);
  m.rings = [...others, ...mine];
  m.rev++;
  return { kept, lost, lostCustom };
}

/** 幾何改過的結構：profile Op 的參考片用絕對格子（看到的＝commit 的）。剛描好的幾何不加（Op 和 v7 逐欄相同）。 */
export function exactOp<T extends { kind: string; keys: string[] }>(m: SliceModel | null | undefined, op: T): T {
  if (!m || op.kind !== 'profile' || !op.keys.some((k) => m.edited.has(k))) return op;
  return { ...op, refExact: true };
}

/** 快照（復原用）：結構小，幾 KB。 */
export function snapshot(m: SliceModel): SliceModel {
  return {
    ...m,
    vertices: Object.fromEntries(Object.entries(m.vertices).map(([k, p]) => [k, { ...p }])),
    rings: m.rings.map((r) => ({ ...r, loop: [...r.loop] })),
    exact: new Map([...m.exact].map(([k, v]) => [k, v.map((p) => [p[0], p[1]] as XY)])),
    handles: new Set(m.handles),
    removed: new Set(m.removed),
    custom: new Set(m.custom),
    edited: new Set(m.edited),
    origin: Object.fromEntries(Object.entries(m.origin).map(([k, p]) => [k, [p[0], p[1]] as XY])),
  };
}
export const restore = (s: SliceModel): SliceModel => ({ ...snapshot(s), rev: s.rev + 1 });

/** 快照的位元組估算（plan v15 D2）：exact 每個點 16、每個頂點 24、環的每個 id 8。 */
export function bytesOf(m: SliceModel): number {
  let n = 0;
  for (const seg of m.exact.values()) n += seg.length * 16;
  n += Object.keys(m.vertices).length * 24;
  for (const r of m.rings) n += r.loop.length * 8;
  return n;
}

/** 一次取用的結果：模型＋這次驗證時重描了哪些結構（訊息用）。 */
export interface Got {
  model: SliceModel;
  fixed: VerifyResult['fixed'];
}

/** snaps 的值：實體快照，或指向另一個版本實體快照的指標（永遠指向實體，不鏈）。 */
type Snap = SliceModel | { sameAs: string };
const isAlias = (s: Snap): s is { sameAs: string } => 'sameAs' in s;
const versionOf = (k: string) => Number(k.slice(k.lastIndexOf('@') + 1));

/**
 * 幾何層的倉庫（§6）：每個 (axis, at) 一份，最多留 8 片（LRU）。
 * 每個版本的幾何另外留快照：復原／重做回到某個版本時直接還原那時的幾何（節點回到原位）；
 * 沒有快照（換 split、3D 筆刷改了這片）就驗證，對不上的結構重描並保留節點 id。
 *
 * plan v15 D2／A4：
 * - 快照的值是 SliceModel 或 { sameAs }：keep() 時模型的 rev 和上一次存快照時相同（這個版本沒改幾何）就只存指標，
 *   指標永遠指向實體快照（扁平不鏈）；restore 時解參考。
 * - 實體快照總位元組 > SNAP_BYTES（或筆數 > SNAP_LIMIT）時從最舊的逐出；被指標參考的實體不逐。
 * - prune(live)：版本已經回不去的快照刪掉。bytes()：給 bench 與 DEV。
 * - get(..., touched = false)：這一步沒碰到這一片 → 不驗證，只把版本號接上（快照存指標）。
 */
export class ModelStore {
  static LIMIT = 8;
  static SNAP_LIMIT = 400;
  static SNAP_BYTES = 64 * 1024 * 1024;
  private cur = new Map<string, SliceModel>();
  private snaps = new Map<string, Snap>();
  /** 實體快照的位元組。 */
  private sizes = new Map<string, number>();
  /** 實體 key → 指向它的 alias key。 */
  private refs = new Map<string, Set<string>>();
  private total = 0;
  /** 這個模型物件上一次存實體快照（或由實體快照還原）時的 key 與 rev：rev 沒變就存指標。 */
  private keptAt = new WeakMap<SliceModel, { key: string; rev: number }>();

  private remember(id: string, m: SliceModel) {
    this.cur.delete(id);
    this.cur.set(id, m);
    while (this.cur.size > ModelStore.LIMIT) this.cur.delete(this.cur.keys().next().value!);
  }
  /** 解參考：這個 key 的實體快照（沒有回 undefined）。 */
  private entity(k: string): { key: string; m: SliceModel } | undefined {
    const s = this.snaps.get(k);
    if (!s) return undefined;
    if (!isAlias(s)) return { key: k, m: s };
    const t = this.snaps.get(s.sameAs);
    return t && !isAlias(t) ? { key: s.sameAs, m: t } : undefined;
  }
  /** 拿掉一筆（實體或指標）；實體被拿掉時指向它的指標也一起拿掉（已經沒有資料）。 */
  private drop(k: string) {
    const s = this.snaps.get(k);
    if (!s) return;
    this.snaps.delete(k);
    if (isAlias(s)) {
      this.refs.get(s.sameAs)?.delete(k);
      return;
    }
    this.total -= this.sizes.get(k) ?? 0;
    this.sizes.delete(k);
    for (const a of this.refs.get(k) ?? []) this.snaps.delete(a);
    this.refs.delete(k);
  }
  /**
   * 超過上限就從最舊的逐出：指標直接逐、實體只在沒有指標參考時逐；每逐一筆從頭再找（逐掉指標之後它指的實體
   * 可能就變成可逐的了）；全都被參考就停（略超過上限）。
   */
  private evict() {
    while (this.snaps.size > ModelStore.SNAP_LIMIT || this.total > ModelStore.SNAP_BYTES) {
      let victim: string | undefined;
      for (const [k, s] of this.snaps)
        if (isAlias(s) || !this.refs.get(k)?.size) {
          victim = k;
          break;
        }
      if (victim === undefined) break;
      this.drop(victim);
    }
  }
  private keep(id: string, m: SliceModel) {
    const k = `${id}@${m.baseVersion}`;
    const last = this.keptAt.get(m);
    const target = last && last.rev === m.rev ? this.entity(last.key) : undefined;
    if (target && target.key === k) {
      // 同一個版本、幾何沒變：只刷新順序
      const s = this.snaps.get(k)!;
      this.snaps.delete(k);
      this.snaps.set(k, s);
      return;
    }
    if (target) {
      // 幾何和 target 那個版本一模一樣：存指標（扁平：指向實體）。k 原本若是被參考的實體，把那些指標改指 target
      const was = this.snaps.get(k);
      if (was && !isAlias(was)) {
        for (const a of this.refs.get(k) ?? []) {
          this.snaps.set(a, { sameAs: target.key });
          this.refs.get(target.key)?.add(a);
        }
        this.refs.delete(k);
        this.total -= this.sizes.get(k) ?? 0;
        this.sizes.delete(k);
        this.snaps.delete(k);
      } else this.drop(k);
      this.snaps.set(k, { sameAs: target.key });
      if (!this.refs.has(target.key)) this.refs.set(target.key, new Set());
      this.refs.get(target.key)!.add(k);
      this.evict();
      return;
    }
    // 實體快照：同一個 key 原本的實體被換掉時，指向它的指標跟著指向新的（版本相同＝同一片 voxel，形狀一樣）
    const was = this.snaps.get(k);
    const keepRefs = was && !isAlias(was) ? this.refs.get(k) : undefined;
    if (keepRefs) {
      this.total -= this.sizes.get(k) ?? 0;
      this.snaps.delete(k);
    } else this.drop(k);
    const snap = snapshot(m);
    const b = bytesOf(snap);
    this.snaps.set(k, snap);
    this.sizes.set(k, b);
    this.total += b;
    this.keptAt.set(m, { key: k, rev: m.rev });
    this.evict();
  }

  /**
   * 這一片、這個版本的幾何（必要時建立、還原快照或驗證重描）。
   * seq＝editor 已經算完的步數：比放開時大就表示那一步回來了（沒改到任何格子時版本不變，靠這個知道）。
   * touched（plan v15 A4）＝這一步的 stepTouch 有沒有碰到 (axis, at) 這一片；省略＝true（現行為：驗證）。
   * false 時若這一片沒有在等 Worker、也沒有這個版本的快照，幾何一定還和 voxel 對得上：不驗證、不重描，
   * 只把 baseVersion 接上並存一個指向上一版快照的指標。
   */
  get(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[], version: number, seq = 0, touched = true): Got {
    const id = `${axis}|${at}`;
    let m = this.cur.get(id);
    let fixed: VerifyResult['fixed'] = [];
    let settled = false;
    if (m?.pending && seq > m.pendingSeq) {
      // 那一步算完了：版本變了就驗證；沒變（沒改到）就回到放開前的快照
      m.pending = false;
      m.baseVersion = -1;
      settled = true;
    }
    if (m?.pending && m.pendingFrom === version) {
      // 放開了、Worker 還沒回來：先用已經更新的幾何
    } else if (!m || m.pending || m.baseVersion !== version) {
      const snap = this.entity(`${id}@${version}`);
      if (snap && !m?.pending) {
        m = restore(snap.m);
        // 經指標還原時實體是別的版本的：版本號要接到要的這一版，否則下一次 get 又會再還原一份新的
        m.baseVersion = version;
        // 還原出來的就是那份實體：之後沒改就能用指標
        this.keptAt.set(m, { key: snap.key, rev: m.rev });
      } else if (m && !touched && !m.pending && !settled && m.baseVersion >= 0) {
        m.baseVersion = version;
        this.keep(id, m);
      } else if (m) {
        fixed = verifyAndFix(m, L, vol, keys, version).fixed;
        // 快照先存（rev 沒變＝這次驗證沒重描、也沒人改過幾何 → 指標），再換 rev 讓環的快取重取；
        // 換 rev 不改幾何，所以「這個模型等於哪份實體快照」的紀錄跟著更新，下一次 begin() 仍能存指標
        this.keep(id, m);
        m.rev++;
        const ka = this.keptAt.get(m);
        if (ka) ka.rev = m.rev;
      } else {
        m = buildSliceModel(L, vol, axis, at, keys, version);
        this.keep(id, m);
      }
    }
    ensureKeys(m, L, vol, keys);
    this.remember(id, m);
    return { model: m, fixed };
  }

  /** 放開了一步（在改幾何之前呼叫）：先存這個版本的快照（復原回來用），再標記等待 Worker。seq＝目前已算完的步數。 */
  begin(m: SliceModel, version: number, seq: number) {
    const id = `${m.axis}|${m.at}`;
    if (!m.pending && m.baseVersion === version) this.keep(id, m);
    m.pending = true;
    m.pendingFrom = version;
    m.pendingSeq = seq;
  }
  /** 版本已經回不去（不在任何 split 的 hist／future／cur 裡）的快照刪掉；被 live 指標參考的實體留著。 */
  prune(live: Set<number>) {
    const need = new Set<string>();
    for (const [k, s] of this.snaps) {
      if (!live.has(versionOf(k))) continue;
      need.add(k);
      if (isAlias(s)) need.add(s.sameAs);
    }
    for (const k of [...this.snaps.keys()]) if (!need.has(k)) this.drop(k);
  }
  /** 實體快照的總位元組（估算）。 */
  bytes() {
    return this.total;
  }
  /** 快照筆數（實體、指標）；測試用。 */
  counts() {
    let alias = 0;
    for (const s of this.snaps.values()) if (isAlias(s)) alias++;
    return { entities: this.snaps.size - alias, aliases: alias };
  }
  /** 測試用：某個版本的快照是不是指標、指向誰。 */
  snapOf(axis: Axis, at: number, version: number): { alias: boolean; sameAs?: number } | null {
    const s = this.snaps.get(`${axis}|${at}@${version}`);
    if (!s) return null;
    return isAlias(s) ? { alias: true, sameAs: versionOf(s.sameAs) } : { alias: false };
  }
  /** 換檔案：全部丟掉。 */
  clear() {
    this.cur.clear();
    this.snaps.clear();
    this.sizes.clear();
    this.refs.clear();
    this.total = 0;
  }
}
