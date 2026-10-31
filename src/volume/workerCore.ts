// Worker 的本體（plan v9 §4.2）：每個 split（owner）的體素、結構編號、diff、體積帳在這裡各只有一份，
// 每一步原地貼補丁（不整個陣列影印）。原始是 owner 'base'，永遠不寫。
// 純模組（沒有 self.onmessage），worker.ts 接訊息；測試與 bench 直接呼叫 handle()。
import { type BBox, type Comp, type MeshData, type RawComp, type Volume, DIFF_BIT, greedyMesh, labelComponents } from './volume';
import { type Scope, clipBox } from './scope';
import { type Op, upgradeOp } from './ops';
import { applyOpInPlace, globalIndex } from './apply';
import { previewOp } from './preview';
import { previewMesh } from './previewMesh';
import { newReport } from './kernel';
import { type TracedHandle, ringCache } from '../slice/relative';
import { type Step, applyStepInPlace, carryStepStats } from './patch';
import type { Report } from './kernel';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from './chunks';

/** 一步的結果裡要 transfer 回主執行緒的陣列。 */
const stepBuffers = (st: Step): Transferable[] => {
  const out: Transferable[] = [];
  if (st.data) out.push(st.data.before.buffer, st.data.after.buffer);
  if (st.labels) out.push(st.labels.before.buffer, st.labels.after.buffer);
  return out;
};
/** chunk 網格：k = chunk 編號，m.quads = 0 表示這個 chunk 現在是空的（主執行緒拿掉）。 */
export interface ChunkItem {
  k: number;
  m: MeshData;
}

/** 網格只畫一部分：選取（結構編號 ∩ z 範圍，box = 它們的外框）或某個材質（空洞層）。 */
export type Only = { comps: number[]; scope: Scope; box: BBox } | { mat: number };

export const BASE_OWNER = 'base';

export interface Requests {
  /** 載入原始：存起來並標記結構；之前的狀態全部丟掉。回傳原始的體積帳（主執行緒不再自己數）。 */
  load: { req: { sid: number; vol: Volume }; res: { labels: Int32Array; raw: RawComp[]; counts: Float64Array } };
  /** 開一本新帳簿：複製 src 目前的內容給 owner（這是整個流程裡唯一的整陣列複製）。sid 省略＝沿用 src 的版本號。 */
  fork: { req: { owner: string; src: string; sid?: number }; res: null };
  /** 保險：主執行緒的內容補送過來（只在 head 對不上時）。 */
  put: { req: { owner: string; sid: number; vol: Volume; labels: Int32Array }; res: null };
  /** 釋放這些帳簿。 */
  drop: { req: { owners: string[] }; res: null };
  /** 從 src（版本 from）複製出 owner，原地逐個套 ops，結果是版本 to；複本 transfer 回主執行緒（新 split 一次）。 */
  replay: {
    req: { owner: string; src: string; from: number; to: number; comps: Comp[]; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    res: { data: Uint8Array; labels: Int32Array; diff: Uint8Array; diffCount: number; counts: Float64Array; comps: Comp[]; keyCounter: number };
  };
  mesh: {
    req: {
      sid: number;
      /** 長度 256，1 = 不畫這個材質。 */
      hidden: Uint8Array;
      /** 改過的體素混紅、不和沒改過的合併。 */
      diff?: boolean;
      only?: Only;
      /** 長度 768，每個材質的 RGB（0～1）。 */
      palette: Float32Array;
      tint?: [number, number, number];
      /** 頂點沿面法線外推這麼多（選取層用，避免和主網格共面閃爍）。 */
      inflate?: number;
    };
    res: MeshData;
  };
  /** 差異模式：改過的體素（含被拿掉的，畫紅）一層、沒改的一層（半透明灰）。 */
  diffMesh: {
    req: { sid: number; hidden: Uint8Array; palette: Float32Array };
    res: { changed: MeshData; ghost: MeshData };
  };
  /** 保留給測試與保險；UI 每一步不再呼叫（主執行緒自己差量更新，§4.4）。 */
  diff: { req: { sid: number }; res: { mask: Uint8Array; count: number } };
  /** 一步操作：owner 的帳簿必須正好是版本 from；原地算（§4.3），沒改到時 head 不動。回傳補丁。 */
  apply: {
    req: { owner: string; from: number; to: number; comps: Comp[]; op: Op; matNames: Record<number, string>; keyCounter: number };
    res: { step: Step; keyCounter: number; report: Report };
  };
  /** 復原／重做：owner 從 from 原地套補丁（往前或往回）成為 to（§8.3）。 */
  derive: { req: { owner: string; from: number; to: number; step: Step; dir: 'fwd' | 'back' }; res: null };
  /**
   * chunk 網格（§8.4）：key＝畫法（隱藏、顏色、標紅）；base＝主執行緒現在畫的版本（同一個 key）。
   * base 是 sid 的上一步時只回改到的 chunk（full = false），否則回全部（full = true）。不快取（主執行緒快取，§4.6）。
   */
  chunks: {
    req: { sid: number; key: string; hidden: Uint8Array; diff: boolean; palette: Float32Array; base?: number };
    res: { full: boolean; items: ChunkItem[] };
  };
  /** 保留給測試與保險。 */
  count: { req: { sid: number }; res: number[] };
  /**
   * 拖拉第 2 級預覽（§4.5）：在 Worker 裡裁切重算＋預覽網格；拖拉期間 Worker 閒著、狀態已常駐，不必傳陣列。
   * 每片的輪廓同一次拖拉只描一次（快取 key 含 sid 與手勢的把手，換 sid 就清空）。超過 cap 回 none。
   */
  preview: {
    req: { sid: number; comps: Comp[]; op: Op; cap: number; hidden: Uint8Array; palette: Float32Array; showDiff: boolean; seq: number; mesh: boolean };
    res: { seq: number; sid: number; box: BBox; data: Uint8Array; blockedAt: number[]; mesh: MeshData | null } | { seq: number; sid: number; none: true };
  };
}
export type Kind = keyof Requests;

/** 一本帳簿：一個 owner 目前的內容。diff 為 null＝原始（和自己沒有不同）。 */
export interface Book {
  data: Uint8Array;
  labels: Int32Array;
  diff: Uint8Array | null;
  diffCount: number;
  counts: Float64Array;
}

let dims = { X: 1, Y: 1, Z: 1 };
const books = new Map<string, Book>();
/** 每本帳簿現在是哪個版本。 */
const heads = new Map<string, number>();
/** 每個版本從哪一版、改了哪個外框來的（box：體素；labelBox：結構編號，⊇ box）。chunk／圖層只重算改到的地方。 */
const parents = new Map<number, { from: number; box: BBox | null; labelBox: BBox | null }>();
let origSid = 0;
/** 拖拉預覽的每片輪廓快取（§4.5）：只對 previewSid 有效。 */
const rings = ringCache();
let previewSid = -1;
/** 測試用：輪廓快取命中／描了幾次。 */
export const previewStats = rings.stats;

/** 測試用：看 Worker 的內部狀態。 */
export const inspect = () => ({ books, heads, parents, origSid });

const origBook = () => books.get(BASE_OWNER)!;
const volOf = (b: Book): Volume => ({ X: dims.X, Y: dims.Y, Z: dims.Z, data: b.data });

/** sid 是哪一本帳簿現在的版本；不是任何一本的 head＝主執行緒拿的是過期的版本，回錯誤（主執行緒丟掉這個結果）。 */
function ownerOfSid(sid: number): string {
  for (const [o, h] of heads) if (h === sid) return o;
  throw new Error(`Worker 沒有狀態 ${sid}`);
}
function stateOf(sid: number) {
  const b = books.get(ownerOfSid(sid))!;
  return { vol: volOf(b), labels: b.labels, book: b };
}
const bookAt = (owner: string, sid: number) => {
  const b = books.get(owner);
  if (!b || heads.get(owner) !== sid) throw new Error(`Worker 的 ${owner} 不是版本 ${sid}（${heads.get(owner)}）`);
  return b;
};
const diffMaskOf = (sid: number) => {
  const b = stateOf(sid).book;
  return b.diff && b.diffCount ? b.diff : null;
};
function countAll(data: Uint8Array) {
  const out = new Float64Array(256);
  for (let i = 0; i < data.length; i++) out[data[i]]++;
  return out;
}
function copyBook(b: Book): Book {
  const N = b.data.length;
  return { data: b.data.slice(), labels: b.labels.slice(), diff: b.diff ? b.diff.slice() : new Uint8Array(N), diffCount: b.diffCount, counts: b.counts.slice() };
}
const ctxOf = (matNames: Record<number, string>, keyCounter: number) => {
  let seq = keyCounter;
  return {
    ctx: { orig: volOf(origBook()), matName: (id: number) => matNames[id] ?? `材質 ${id}`, newKey: () => `c${seq++}` },
    seq: () => seq,
  };
};
/** 原地套一個 Op 到 owner 的帳簿，順手更新 diff 與體積帳。 */
function applyTo(b: Book, comps: Comp[], op: Op, ctx: ReturnType<typeof ctxOf>['ctx']) {
  const r = applyOpInPlace({ vol: volOf(b), L: { labels: b.labels, comps } }, op, ctx);
  if (r.step.data) b.diffCount = carryStepStats(dims, b.data, origBook().data, b.diff!, b.diffCount, b.counts, r.step, 'fwd');
  return r;
}

/** 差異模式裡「原本有、現在是空氣」的體素代碼（材質編號只到 254）。 */
const REMOVED = 255;

const emptyMesh = (): MeshData => ({ positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), quads: 0 });

/** 符合 test 的體素外框；一個都沒有回傳 null。 */
function boxOf(vol: Volume, test: (i: number) => boolean): BBox | null {
  const { X, Y, Z } = vol;
  const b: BBox = { x0: X, x1: -1, y0: Y, y1: -1, z0: Z, z1: -1 };
  for (let z = 0, i = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++, i++)
        if (test(i)) {
          if (x < b.x0) b.x0 = x;
          if (x > b.x1) b.x1 = x;
          if (y < b.y0) b.y0 = y;
          if (y > b.y1) b.y1 = y;
          if (z < b.z0) b.z0 = z;
          if (z > b.z1) b.z1 = z;
        }
  return b.x1 < 0 ? null : b;
}

/** 只在 box 裡做單色 greedy mesh，座標再平移回整個陣列。 */
function meshInBox(vol: Volume, box: BBox, test: (i: number) => boolean, rgb: [number, number, number]): MeshData {
  const { X, Y } = vol;
  const bx = box.x1 - box.x0 + 1;
  const by = box.y1 - box.y0 + 1;
  const bz = box.z1 - box.z0 + 1;
  const codes = new Uint16Array(bx * by * bz);
  for (let z = 0, k = 0; z < bz; z++)
    for (let y = 0; y < by; y++) {
      const row = ((z + box.z0) * Y + y + box.y0) * X + box.x0;
      for (let x = 0; x < bx; x++, k++) if (test(row + x)) codes[k] = 1;
    }
  const m = greedyMesh(bx, by, bz, codes, () => rgb);
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i] += box.x0;
    m.positions[i + 1] += box.y0;
    m.positions[i + 2] += box.z0;
  }
  return m;
}

type Handler<K extends Kind> = (req: Requests[K]['req']) => [Requests[K]['res'], Transferable[]];

export const handlers: { [K in Kind]: Handler<K> } = {
  load: ({ sid, vol }) => {
    books.clear();
    heads.clear();
    parents.clear();
    dims = { X: vol.X, Y: vol.Y, Z: vol.Z };
    const { labels, raw } = labelComponents(vol);
    const counts = countAll(vol.data);
    books.set(BASE_OWNER, { data: vol.data, labels, diff: null, diffCount: 0, counts });
    heads.set(BASE_OWNER, sid);
    origSid = sid;
    // 主執行緒要一份原始的 labels（一次）
    const out = labels.slice();
    const c = counts.slice();
    return [{ labels: out, raw, counts: c }, [out.buffer, c.buffer]];
  },
  fork: ({ owner, src, sid }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被覆蓋');
    const b = books.get(src);
    if (!b) throw new Error(`Worker 沒有帳簿 ${src}`);
    books.set(owner, copyBook(b));
    heads.set(owner, sid ?? heads.get(src)!);
    return [null, []];
  },
  put: ({ owner, sid, vol, labels }) => {
    if (owner === BASE_OWNER) {
      heads.set(owner, sid);
      return [null, []];
    }
    const o = origBook().data;
    const diff = new Uint8Array(vol.data.length);
    let diffCount = 0;
    for (let i = 0; i < o.length; i++)
      if (o[i] !== vol.data[i]) {
        diff[i] = 1;
        diffCount++;
      }
    books.set(owner, { data: vol.data, labels, diff, diffCount, counts: countAll(vol.data) });
    heads.set(owner, sid);
    return [null, []];
  },
  drop: ({ owners }) => {
    for (const o of owners)
      if (o !== BASE_OWNER) {
        books.delete(o);
        heads.delete(o);
      }
    return [null, []];
  },
  apply: ({ owner, from, to, comps, op, matNames, keyCounter }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被改');
    const b = bookAt(owner, from);
    const { ctx, seq } = ctxOf(matNames, keyCounter);
    let r;
    try {
      r = applyTo(b, comps, op, ctx);
    } catch (e) {
      // 算到一半失敗：帳簿可能已經改了一半，整本丟掉（主執行緒會 put 改前的內容回來）
      books.delete(owner);
      heads.delete(owner);
      throw e;
    }
    if (r.step.data) {
      heads.set(owner, to);
      parents.set(to, { from, box: r.step.data.box, labelBox: r.step.labels?.box ?? r.step.data.box });
    }
    return [{ step: r.step, keyCounter: seq(), report: r.report }, stepBuffers(r.step)];
  },
  derive: ({ owner, from, to, step, dir }) => {
    const b = bookAt(owner, from);
    applyStepInPlace(dims, b.data, b.labels, step, dir);
    b.diffCount = carryStepStats(dims, b.data, origBook().data, b.diff!, b.diffCount, b.counts, step, dir);
    heads.set(owner, to);
    parents.set(to, { from, box: step.data?.box ?? null, labelBox: step.labels?.box ?? step.data?.box ?? null });
    return [null, []];
  },
  replay: ({ owner, src, from, to, comps, ops, matNames, keyCounter }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被覆蓋');
    const b = copyBook(bookAt(src, from));
    const { ctx, seq } = ctxOf(matNames, keyCounter);
    let cs = comps;
    for (const op of ops) cs = applyTo(b, cs, upgradeOp(op), ctx).comps;
    books.set(owner, b);
    heads.set(owner, to);
    parents.delete(to);
    // Worker 自己留一份，複本 transfer 回主執行緒（新 split 一次）
    const out = copyBook(b);
    return [
      { data: out.data, labels: out.labels, diff: out.diff!, diffCount: out.diffCount, counts: out.counts, comps: cs, keyCounter: seq() },
      [out.data.buffer, out.labels.buffer, out.diff!.buffer, out.counts.buffer],
    ];
  },
  chunks: ({ sid, key: _key, hidden, diff, palette, base }) => {
    const { vol } = stateOf(sid);
    const g = gridOf(vol);
    const d = diff ? diffMaskOf(sid) : null;
    const data = vol.data;
    const code = (i: number) => {
      const m = data[i];
      return m && !hidden[m] ? (d?.[i] ? m | DIFF_BIT : m) : 0;
    };
    const color = colorFn(palette);
    const par = parents.get(sid);
    let ks: number[];
    let full = true;
    if (base === sid) {
      full = false;
      ks = [];
    } else if (par && base !== undefined && base === par.from) {
      full = false;
      ks = par.box ? chunksTouching(vol, g, par.box) : [];
    } else ks = Array.from({ length: chunkCount(g) }, (_, k) => k);
    const items: ChunkItem[] = [];
    for (const k of ks) {
      const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
      // 全量時空的 chunk 不必回傳；增量時要回（主執行緒拿掉）
      if (m.quads || !full) items.push({ k, m });
    }
    const transfer: Transferable[] = [];
    for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
    return [{ full, items }, transfer];
  },
  mesh: ({ sid, hidden, diff, only, palette, tint, inflate }) => {
    const { vol, labels } = stateOf(sid);
    if (only) {
      // 選取層、空洞層只在外框裡做 greedy mesh，不掃整個陣列三次
      let test: (i: number) => boolean;
      let box: BBox | null;
      if ('mat' in only) {
        test = (i) => vol.data[i] === only.mat;
        box = boxOf(vol, test);
      } else {
        const on = new Uint8Array(Math.max(1, ...only.comps.map((c) => c + 1)));
        only.comps.forEach((c) => (on[c] = 1));
        test = (i) => labels[i] >= 0 && on[labels[i]] === 1;
        box = clipBox(only.box, only.scope);
      }
      const m = box ? meshInBox(vol, box, test, tint ?? [0.09, 0.47, 1]) : emptyMesh();
      if (inflate) for (let i = 0; i < m.positions.length; i++) m.positions[i] += m.normals[i] * inflate;
      return [m, [m.positions.buffer, m.normals.buffer, m.colors.buffer]];
    }
    const { X, Y, Z, data } = vol;
    const N = X * Y * Z;
    const codes = new Uint16Array(N);
    const d = diff ? diffMaskOf(sid) : null;
    for (let i = 0; i < N; i++) {
      const m = data[i];
      if (m && !hidden[m]) codes[i] = d?.[i] ? m | DIFF_BIT : m;
    }
    const m = greedyMesh(X, Y, Z, codes, (code) => {
      const id = code & 255;
      const r = palette[id * 3];
      const g = palette[id * 3 + 1];
      const b = palette[id * 3 + 2];
      return code & DIFF_BIT ? [r * 0.35 + 0.65, g * 0.35 + 0.2, b * 0.35 + 0.2] : [r, g, b];
    });
    return [m, [m.positions.buffer, m.normals.buffer, m.colors.buffer]];
  },
  diffMesh: ({ sid, hidden, palette }) => {
    const { vol } = stateOf(sid);
    const o = origBook().data;
    const { X, Y, Z, data } = vol;
    const N = X * Y * Z;
    const d = diffMaskOf(sid);
    const changed = new Uint16Array(N);
    const ghost = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      const m = data[i];
      if (d?.[i]) {
        if (m && !hidden[m]) changed[i] = m;
        else if (!m && o[i] && !hidden[o[i]]) changed[i] = REMOVED;
      } else if (m && !hidden[m]) ghost[i] = 1;
    }
    const color = (code: number): [number, number, number] =>
      code === REMOVED ? [0.96, 0.3, 0.3] : [palette[code * 3], palette[code * 3 + 1], palette[code * 3 + 2]];
    const a = greedyMesh(X, Y, Z, changed, color);
    const b = greedyMesh(X, Y, Z, ghost, () => [0.72, 0.74, 0.78]);
    return [{ changed: a, ghost: b }, [a.positions.buffer, a.normals.buffer, a.colors.buffer, b.positions.buffer, b.normals.buffer, b.colors.buffer]];
  },
  diff: ({ sid }) => {
    const b = stateOf(sid).book;
    const mask = b.diff ? b.diff.slice() : new Uint8Array(b.data.length);
    return [{ mask, count: b.diffCount }, [mask.buffer]];
  },
  count: ({ sid }) => [Array.from(stateOf(sid).book.counts), []],
  preview: ({ sid, comps, op, cap, hidden, palette, showDiff, seq, mesh }) => {
    const { vol, labels, book } = stateOf(sid);
    if (previewSid !== sid) {
      rings.clear();
      previewSid = sid;
    }
    const report = newReport();
    const gestures = op.kind === 'profile' ? op.gestures : undefined;
    const ringsFor = gestures
      ? (key: string, t: number, make: () => TracedHandle) => {
          const g = gestures[key];
          return rings.get(`${op.scope.axis}|${t}|${key}|${g.kind}|${g.ref.join(';')}|${g.shift}|${g.hole}`, make);
        }
      : undefined;
    const p = previewOp({ vol, L: { labels, comps } }, volOf(origBook()), op, cap, report, ringsFor);
    if (!p) return [{ seq, sid, none: true }, []];
    const blockedAt = globalIndex(p.box, vol, report.blockedAt);
    const m = mesh ? previewMesh(vol, p.box, p.data, (id) => !!hidden[id], colorFn(palette), showDiff && book.diff ? origBook().data : null) : null;
    const transfer: Transferable[] = [p.data.buffer];
    if (m) transfer.push(m.positions.buffer, m.normals.buffer, m.colors.buffer);
    return [{ seq, sid, box: p.box, data: p.data, blockedAt, mesh: m }, transfer];
  },
};

/** 處理一個請求（worker.ts 與測試共用）。 */
export function handle(type: Kind, req: unknown): [unknown, Transferable[]] {
  return (handlers[type] as Handler<Kind>)(req as never);
}

/** 材質調色盤 → 每個網格代碼的顏色（標紅的混紅）。 */
export const colorFn = (palette: Float32Array) => (c: number): [number, number, number] => {
  const id = c & 255;
  const r = palette[id * 3];
  const g = palette[id * 3 + 1];
  const b = palette[id * 3 + 2];
  return c & DIFF_BIT ? [r * 0.35 + 0.65, g * 0.35 + 0.2, b * 0.35 + 0.2] : [r, g, b];
};
