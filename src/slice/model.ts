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

/** 一個結構這一片的輪廓（v7 的 traceRings）。 */
function traceKey(L: Labeled, vol: Volume, axis: Axis, at: number, key: string): Ring[] {
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

/** 一次取用的結果：模型＋這次驗證時重描了哪些結構（訊息用）。 */
export interface Got {
  model: SliceModel;
  fixed: VerifyResult['fixed'];
}

/**
 * 幾何層的倉庫（§6）：每個 (axis, at) 一份，最多留 8 片（LRU）。
 * 每個版本的幾何另外留快照：復原／重做回到某個版本時直接還原那時的幾何（節點回到原位）；
 * 沒有快照（換 split、3D 筆刷改了這片）就驗證，對不上的結構重描並保留節點 id。
 */
export class ModelStore {
  static LIMIT = 8;
  static SNAP_LIMIT = 400;
  private cur = new Map<string, SliceModel>();
  private snaps = new Map<string, SliceModel>();

  private remember(id: string, m: SliceModel) {
    this.cur.delete(id);
    this.cur.set(id, m);
    while (this.cur.size > ModelStore.LIMIT) this.cur.delete(this.cur.keys().next().value!);
  }
  private keep(id: string, m: SliceModel) {
    const k = `${id}@${m.baseVersion}`;
    this.snaps.delete(k);
    this.snaps.set(k, snapshot(m));
    while (this.snaps.size > ModelStore.SNAP_LIMIT) this.snaps.delete(this.snaps.keys().next().value!);
  }

  /**
   * 這一片、這個版本的幾何（必要時建立、還原快照或驗證重描）。
   * seq＝editor 已經算完的步數：比放開時大就表示那一步回來了（沒改到任何格子時版本不變，靠這個知道）。
   */
  get(L: Labeled, vol: Volume, axis: Axis, at: number, keys: string[], version: number, seq = 0): Got {
    const id = `${axis}|${at}`;
    let m = this.cur.get(id);
    let fixed: VerifyResult['fixed'] = [];
    if (m?.pending && seq > m.pendingSeq) {
      // 那一步算完了：版本變了就驗證；沒變（沒改到）就回到放開前的快照
      m.pending = false;
      m.baseVersion = -1;
    }
    if (m?.pending && m.pendingFrom === version) {
      // 放開了、Worker 還沒回來：先用已經更新的幾何
    } else if (!m || m.pending || m.baseVersion !== version) {
      const snap = this.snaps.get(`${id}@${version}`);
      if (snap && !m?.pending) m = restore(snap);
      else if (m) {
        fixed = verifyAndFix(m, L, vol, keys, version).fixed;
        m.rev++;
        this.keep(id, m);
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
  /** 換檔案：全部丟掉。 */
  clear() {
    this.cur.clear();
    this.snaps.clear();
  }
}
