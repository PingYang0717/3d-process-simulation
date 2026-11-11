// Worker 的本體（plan v9 §4.2、v17）：原始（owner 'base'，永遠不寫）與目前（'cur'）兩本帳簿的體素、結構編號、diff、體積帳各只有一份，
// 每一步原地貼補丁（不整個陣列影印）。
// 純模組（沒有 self.onmessage），worker.ts 接訊息；測試與 bench 直接呼叫 handle()。
import { type BBox, type Comp, type MeshData, type RawComp, type Volume, DIFF_BIT, VOID, greedyMesh, labelComponents, linerTable } from './volume';
import { type Scope, clipBox } from './scope';
import { type Op, isAdjacent } from './ops';
import { type Probe, type ProbeReq, probe } from './probe';
import { type AppliedPrep, applyOpCommit, applyOpPrepare } from './apply';
import { previewOp } from './preview';
import { previewMesh } from './previewMesh';
import { newReport } from './kernel';
import { type Axes, type DiffAxes, type Step, globalIndex, applyStepInPlace, boxOfAxes, carryStepStats, copyAxes, newAxes, recountAxes, recountMatAxes, stepTouch, unionBox } from './patch';
import { type OpReport, stepEffects, summarize } from './report';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from './chunks';
import { type DecodeOptions, type ExportHint, type ExportMaterial, type ExportStats, type FractionArray, type VtiInfo, type VtiInspect, decodeVti, encodeVti, encodeVtiLike, inspectVti } from './vti';
import { decodeNpy, encodeNpy } from './volume';

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

/**
 * 圖層要畫哪些格子：選取（comps＝結構編號；box＝它們的外框，只用來限制全量時算哪些 chunk）、某個材質，
 * 或差異（plan v12 §5.2：和原始不同的格子，現在有材質畫材質色、被拿掉的畫紅；只算 diff 外框碰到的 chunk）。
 */
export type LayerFilter = { comps: number[]; scope: Scope; box: BBox } | { mat: number };

export interface Requests {
  /** 載入原始：存起來並標記結構；之前的狀態全部丟掉。回傳原始的體積帳（主執行緒不再自己數）。 */
  /** liners：薄層材質（plan v17 §5.4.2，載入時判定一次）。 */
  load: { req: { sid: number; vol: Volume }; res: { labels: Int32Array; raw: RawComp[]; counts: Float64Array; liners: number[] } };
  /** 開一本新帳簿：複製 src 目前的內容給 owner（這是整個流程裡唯一的整陣列複製）。sid 省略＝沿用 src 的版本號。 */
  fork: { req: { owner: string; src: string; sid?: number }; res: null };
  /** 保險：主執行緒的內容補送過來（只在 head 對不上時）。comps：拖拉預覽用（plan v15 §10，Worker 存 compsOf）。 */
  put: { req: { owner: string; sid: number; vol: Volume; labels: Int32Array; comps?: Comp[] }; res: null };
  /** 主執行緒命名好的結構清單（載入後對原始送一次）：拖拉預覽不再每幀送 comps（plan v15 §10）。 */
  comps: { req: { owner: string; comps: Comp[] }; res: null };
  /** 釋放這些帳簿。 */
  drop: { req: { owners: string[] }; res: null };
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
  /** 和原始不同的格子的外框（貼合；沒有不同回 null）。 */
  diffBox: { req: { sid: number }; res: BBox | null };
  /**
   * 匯出要的比例陣列（照原格式寫回，plan v11 §4.0）：載入時送一次。原檔本身在 vtiDecode keepRaw 時就留在 Worker（plan v15 C3）；
   * raw 是舊呼叫端（測試、bench）直接帶原檔用的，省略＝沿用 Worker 手上那份。fractions 為 null＝沒有同格式匯出，原檔一併釋放。
   */
  exportMeta: { req: { raw?: ArrayBuffer | null; fractions: FractionArray[] | null }; res: null };
  /**
   * 匯出（plan v17 §5.8）：owner 給帳簿（省略＝原始）；編碼在 Worker 裡做。stats：同格式匯出時 block 總數與重壓數（bench／e2e 看）。
   * format 'vti'＝輸入有比例陣列時照原檔寫回、否則 UInt8 CellData；'vti1'＝一律 UInt8 CellData；'npy' 留給測試。
   */
  export: {
    req: { owner?: string; format: 'vti' | 'vti1' | 'npy'; spacing: number[]; origin: number[]; arrayName: string; materials: ExportMaterial[] };
    res: { bytes: Uint8Array; stats?: ExportStats };
  };
  /** 上傳的 .vti 只看標頭（plan v15 C3）：buf 由主執行緒 transfer 過來、留在 Worker（pendingRaw）等 vtiDecode 或 vtiDrop。 */
  vtiInspect: { req: { buf: ArrayBuffer }; res: VtiInspect };
  /**
   * 對 pendingRaw 解碼（plan v15 C3＋C4）：vol.data transfer 回主執行緒；keepRaw 且有比例陣列時原檔直接變成匯出用的那份
   * （主執行緒不再留一份），否則釋放。
   */
  vtiDecode: { req: DecodeOptions & { keepRaw: boolean }; res: { vol: Volume; info: VtiInfo; valueMap: Map<number, number> } };
  /** 使用者在確認框取消：釋放 pendingRaw。 */
  vtiDrop: { req: Record<string, never>; res: null };
  /** .npy 也在 Worker 解（plan v15 C3）。 */
  npyDecode: { req: { buf: ArrayBuffer }; res: { vol: Volume } };
  /** 保留給測試與保險；UI 每一步不再呼叫（主執行緒自己差量更新，§4.4）。 */
  diff: { req: { sid: number }; res: { mask: Uint8Array; count: number } };
  /**
   * 試算（plan v17 §5.4.4）：誰會跟著、誰的厚度會變、最多還能做幾格。不寫回帳簿；sid 過期回錯誤（主執行緒丟掉）。
   * comps 省略＝用 Worker 自己存的那份。
   */
  probe: { req: ProbeReq & { sid: number; comps?: Comp[] }; res: Probe };
  /** 一步操作：owner 的帳簿必須正好是版本 from；原地算（§4.3），沒改到時 head 不動。回傳補丁與已摘要的報告（plan v15 C7：cells 有上限）。 */
  apply: {
    req: { owner: string; from: number; to: number; comps: Comp[]; op: Op; matNames: Record<number, string>; keyCounter: number };
    res: { step: Step; keyCounter: number; report: OpReport };
  };
  /** 復原／重做：owner 從 from 原地套補丁（往前或往回）成為 to（§8.3）。 */
  derive: { req: { owner: string; from: number; to: number; step: Step; dir: 'fwd' | 'back' }; res: null };
  /**
   * chunk 網格（§8.4）：key＝畫法（隱藏、顏色、標紅）；base＝主執行緒現在畫的版本（同一個 key）。
   * base 是 sid 的上一步時只回改到的 chunk（full = false），否則回全部（full = true）。不快取（主執行緒快取，§4.6）。
   */
  chunks: {
    /** alts：主執行緒快取裡還有的同畫法版本（例如目前的上一版是原始：從原始的網格增量）。 */
    req: { sid: number; key: string; hidden: Uint8Array; diff: boolean; palette: Float32Array; base?: number; alts?: number[] };
    /** from：增量時是從哪個版本改過來的（主執行緒拿那一組 chunk 當底）。 */
    res: { full: boolean; items: ChunkItem[]; from?: number };
  };
  /** 保留給測試與保險。 */
  count: { req: { sid: number }; res: number[] };
  /**
   * 圖層（§4.6）：選取（結構編號 ∩ scope）或某個材質的單色網格，和主網格同一套 chunk。
   * key＝畫法（選了哪些結構的 key、scope、外推、顏色）；base 是 sid 的上一步時只回改到的 chunk
   * （選取看 labels，髒的範圍是 relabel 的 S；材質看體素，髒的是補丁外框），否則只算和 box 相交的 chunk。
   */
  layer: {
    /** palette：有給就用材質原色（有選取時的「選取實色」），沒給就整層 tint。 */
    req: { sid: number; key: string; filter: LayerFilter; tint: [number, number, number]; inflate?: number; base?: number; palette?: Float32Array };
    res: { full: boolean; items: ChunkItem[] };
  };
  /**
   * 拖拉第 2 級預覽（§4.5）：在 Worker 裡裁切重算＋預覽網格；拖拉期間 Worker 閒著、狀態已常駐，不必傳陣列。超過 cap 回 none。
   */
  preview: {
    /** comps 可省略（plan v15 §10）：Worker 用自己在 apply／derive／comps 存下的那份。 */
    req: { sid: number; comps?: Comp[]; op: Op; cap: number; hidden: Uint8Array; palette: Float32Array; showDiff: boolean; seq: number; mesh: boolean };
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
  /** 三條軸的 diff 直方圖（plan v15 A2）：貼合的 diff 外框 O(X+Y+Z)，不再每步掃寬鬆外框。 */
  axes: DiffAxes;
  /** VOID 的三軸直方圖（plan v15 A5，M15.7）：空洞層的貼合 VOID 外框 O(X+Y+Z)，只在 data 真的改變的格子旁邊差量維護。 */
  voidAxes: Axes;
  /** 所有改過的範圍（data、labels 的 S、換編號的結構外框）的聯集：外面和原始逐位元組相同。 */
  touch: BBox | null;
}

let dims = { X: 1, Y: 1, Z: 1 };
const books = new Map<string, Book>();
/** 每本帳簿現在是哪個版本。 */
const heads = new Map<string, number>();
/** 每個版本從哪一版、改了哪個外框來的（box：體素；labelBox：結構編號，⊇ box）。chunk／圖層只重算改到的地方。 */
const parents = new Map<number, { from: number; box: BBox | null; labelBox: BBox | null }>();
let origSid = 0;
/** 每本帳簿現在的結構清單（plan v15 §10）：apply／derive／put／comps 都會更新，拖拉預覽用它、不必每幀送。 */
const compsOf = new Map<string, Comp[]>();
/** 測試用：整陣列掃描的次數（A5：VOID 層不該呼叫 boxOf）與 layer 算過的 chunk 數（VOID 層只該算貼合 VOID 外框碰到的）。 */
export const scanStats = { boxOf: 0, layerChunks: 0 };

/** 測試用：看 Worker 的內部狀態。 */
export const inspect = () => ({ books, heads, parents, origSid, compsOf, pendingRaw, exportRaw, exportFractions });

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
/** 載入時的一次掃描：體積帳＋ VOID 的三軸直方圖（同一個迴圈，plan v15 A5）。 */
function countAllAndVoid(v: Volume) {
  const { X, Y, Z, data } = v;
  const out = new Float64Array(256);
  const va = newAxes(v);
  for (let z = 0, i = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++, i++) {
        const m = data[i];
        out[m]++;
        if (m === VOID) {
          va.x[x]++;
          va.y[y]++;
          va.z[z]++;
        }
      }
  return { counts: out, voidAxes: va };
}
function copyBook(b: Book): Book {
  const N = b.data.length;
  return {
    data: b.data.slice(),
    labels: b.labels.slice(),
    diff: b.diff ? b.diff.slice() : new Uint8Array(N),
    diffCount: b.diffCount,
    counts: b.counts.slice(),
    axes: copyAxes(b.axes),
    voidAxes: copyAxes(b.voidAxes),
    touch: b.touch ? { ...b.touch } : null,
  };
}
/** 貼合的 diff 外框（plan v12 §5.2；v15 A2 改從三條軸的直方圖來，O(X+Y+Z)）。 */
export function diffBoxOf(b: Book): BBox | null {
  if (!b.diff || !b.diffCount) return null;
  return boxOfAxes(b.axes);
}
/** 一步補丁之後：touch union 這一步碰到的範圍（復原也 union）。diff 外框由 axes 差量維護，不必在這裡記。 */
const growTouch = (b: Book, step: Step) => {
  b.touch = unionBox(b.touch, stepTouch(step));
};
/** VOID 的貼合外框（plan v15 A5，M15.7）：從帳簿的 VOID 三軸直方圖來，O(X+Y+Z)；不掃整個陣列、也不是 touch 那種鬆外框。 */
const voidBoxOf = (b: Book): BBox | null => boxOfAxes(b.voidAxes);

/** 匯出用的原檔（plan v15 C4：全程只有 Worker 這一份）與比例陣列。 */
let exportRaw: ArrayBuffer | null = null;
let exportFractions: FractionArray[] | null = null;
/** 上傳中的 .vti（vtiInspect 收到、等使用者確認）：vtiDecode 用掉或 vtiDrop 釋放。 */
let pendingRaw: ArrayBuffer | null = null;
const ctxOf = (matNames: Record<number, string>, keyCounter: number) => {
  let seq = keyCounter;
  return {
    ctx: { orig: volOf(origBook()), matName: (id: number) => matNames[id] ?? `材質 ${id}`, newKey: () => `c${seq++}` },
    seq: () => seq,
  };
};
/** 原地套一個 Op 到 owner 的帳簿，順手更新 diff 與體積帳。 */
/** 第二段：貼進帳簿、relabel、差量更新 diff 與體積帳。 */
function applyCommitTo(b: Book, comps: Comp[], prep: AppliedPrep, ctx: ReturnType<typeof ctxOf>['ctx']) {
  const r = applyOpCommit({ vol: volOf(b), L: { labels: b.labels, comps } }, prep, ctx);
  if (r.step.data) {
    b.diffCount = carryStepStats(dims, b.data, origBook().data, b.diff!, b.diffCount, b.counts, r.step, 'fwd', b.axes, b.voidAxes);
    growTouch(b, r.step);
  }
  return r;
}

/**
 * 進度（plan v16）：長的請求用 generator 寫，每個 yield 是一次進度回報；worker.ts 在 yield 之間讓出事件圈，
 * 這時收到「取消」就 return 掉（cancellable＝到這個點為止帳簿一格都沒動，取消是安全的）。
 * handle()（測試、bench）同步跑完整個 generator，行為和以前一樣。
 */
export interface Progress {
  phase: 'compute' | 'commit' | 'chunks' | 'layer';
  done: number;
  total: number;
  /** 在這個點停下來可以安全取消（帳簿沒改）。 */
  cancellable: boolean;
}
export type Gen<K extends Kind> = Generator<Progress, [Requests[K]['res'], Transferable[]], void>;
/** 同步跑完一個 generator（忽略進度）。 */
export function drain<K extends Kind>(g: Gen<K>): [Requests[K]['res'], Transferable[]] {
  for (;;) {
    const n = g.next();
    if (n.done) return n.value;
  }
}
/** 一批幾個 chunk 回報一次進度（每個 yield 之間 worker.ts 會 setTimeout 0 讓出一次）。 */
const CHUNK_BATCH = 6;

const emptyMesh = (): MeshData => ({ positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), quads: 0 });

/** 符合 test 的體素外框；一個都沒有回傳 null。O(N)，每格一個 closure call：VOID 層改走 voidBoxOf（A5），其他材質才用它。 */
function boxOf(vol: Volume, test: (i: number) => boolean): BBox | null {
  scanStats.boxOf++;
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

function* applyGen({ owner, from, to, comps, op, matNames, keyCounter }: Requests['apply']['req']): Gen<'apply'> {
  if (owner === BASE_OWNER) throw new Error('原始不能被改');
  const b = bookAt(owner, from);
  const { ctx, seq } = ctxOf(matNames, keyCounter);
  // 第一段純算（最重的部分）：這之前與之後都還沒動帳簿，取消都安全
  yield { phase: 'compute', done: 0, total: 1, cancellable: true };
  const prep = applyOpPrepare({ vol: volOf(b), L: { labels: b.labels, comps } }, op, ctx);
  yield { phase: 'commit', done: 1, total: 1, cancellable: true };
  let r;
  try {
    r = applyCommitTo(b, comps, prep, ctx);
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
  compsOf.set(owner, r.comps);
  // 報告在 Worker 摘要（plan v15 C7）：被擋的格子只回前 BLOCKED_CAP 個，不 clone 整個 blockedAt
  const report = summarize(r.report, op, dims);
  if (isAdjacent(op)) {
    // plan v17 §5.5：鄰居怎麼了由這一步的補丁算（O(補丁)）
    const keys = new Set(op.keys);
    const self = new Set(comps.filter((c) => keys.has(c.key)).map((c) => c.mat));
    const fx = r.step.data ? stepEffects(r.step.data.before, r.step.data.after, self, new Set(op.follow ? op.liners : [])) : { effects: { follow: [], lost: [], gained: [], both: [] }, changed: 0 };
    report.effects = fx.effects;
    report.changed = fx.changed;
  }
  return [{ step: r.step, keyCounter: seq(), report }, [...stepBuffers(r.step), report.cells.buffer]];
}

/** 有進度／可取消的請求（worker.ts 逐段驅動；handle() 用 drain 同步跑完）。 */
export const gens = { apply: applyGen, chunks: chunksGen, layer: layerGen } as const;
export type GenKind = keyof typeof gens;
export const isGenKind = (t: string): t is GenKind => t in gens;

function* chunksGen({ sid, key: _key, hidden, diff, palette, base: base0, alts }: Requests['chunks']['req']): Gen<'chunks'> {
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
  // 主執行緒現在畫的不是上一版、但快取裡有上一版（例如目前的上一版＝原始）：從那一版增量
  const base = base0 !== sid && par && base0 !== par.from && alts?.includes(par.from) ? par.from : base0;
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
  yield { phase: 'chunks', done: 0, total: ks.length, cancellable: true };
  for (let n = 0; n < ks.length; n++) {
    const k = ks[n];
    const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
    // 全量時空的 chunk 不必回傳；增量時要回（主執行緒拿掉）
    if (m.quads || !full) items.push({ k, m });
    if ((n + 1) % CHUNK_BATCH === 0 && n + 1 < ks.length) yield { phase: 'chunks', done: n + 1, total: ks.length, cancellable: true };
  }
  const transfer: Transferable[] = [];
  for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
  return [{ full, items, ...(full ? {} : { from: base }) }, transfer];
}

function* layerGen({ sid, filter, tint, inflate, base, palette }: Requests['layer']['req']): Gen<'layer'> {
  const { vol, labels, book } = stateOf(sid);
  const g = gridOf(vol);
  const data = vol.data;
  let code: (i: number) => number;
  let box: BBox | null;
  let sel = false;
  if ('mat' in filter) {
    const mat = filter.mat;
    code = (i) => (data[i] === mat ? 1 : 0);
    // 空洞層（A5）：帳簿的 VOID 直方圖給貼合外框（O(X+Y+Z)），不掃整個陣列；其他材質在全量時才 boxOf
    box = mat === VOID ? voidBoxOf(book) : null;
  } else {
    sel = true;
    const on = new Uint8Array(Math.max(1, ...filter.comps.map((c) => c + 1)));
    filter.comps.forEach((c) => (on[c] = 1));
    box = clipBox(filter.box, filter.scope);
    // scope 只看一個軸：沿那個軸的座標在 [lo, hi] 裡
    const { X, Y } = vol;
    const plane = X * Y;
    const { axis, lo, hi } = filter.scope;
    const along = axis === 'z' ? (i: number) => Math.floor(i / plane) : axis === 'y' ? (i: number) => Math.floor(i / X) % Y : (i: number) => i % X;
    code = (i) => {
      const l = labels[i];
      if (l < 0 || l >= on.length || !on[l]) return 0;
      const t = along(i);
      return t >= lo && t <= hi ? (palette ? data[i] : 1) : 0;
    };
  }
  const par = parents.get(sid);
  let ks: number[];
  let full = true;
  if (base === sid) {
    full = false;
    ks = [];
  } else if (par && base !== undefined && base === par.from) {
    full = false;
    const d = sel ? par.labelBox : par.box;
    ks = d ? chunksTouching(vol, g, d) : [];
  } else {
    if (!sel && (filter as { mat: number }).mat !== VOID) box = boxOf(vol, (i) => data[i] === (filter as { mat: number }).mat);
    ks = box ? chunksTouching(vol, g, box) : [];
  }
  const color = (c: number): [number, number, number] => (palette ? [palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]] : tint);
  const items: ChunkItem[] = [];
  scanStats.layerChunks += ks.length;
  yield { phase: 'layer', done: 0, total: ks.length, cancellable: true };
  for (let n = 0; n < ks.length; n++) {
    const k = ks[n];
    const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
    if (inflate) for (let i = 0; i < m.positions.length; i++) m.positions[i] += m.normals[i] * inflate;
    if (m.quads || !full) items.push({ k, m });
    if ((n + 1) % CHUNK_BATCH === 0 && n + 1 < ks.length) yield { phase: 'layer', done: n + 1, total: ks.length, cancellable: true };
  }
  const transfer: Transferable[] = [];
  for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
  return [{ full, items }, transfer];
}

export const handlers: { [K in Kind]: Handler<K> } = {
  load: ({ sid, vol }) => {
    books.clear();
    heads.clear();
    parents.clear();
    dims = { X: vol.X, Y: vol.Y, Z: vol.Z };
    compsOf.clear();
    const { labels, raw } = labelComponents(vol);
    const { counts, voidAxes } = countAllAndVoid(vol);
    const liners = linerTable(vol);
    books.set(BASE_OWNER, { data: vol.data, labels, diff: null, diffCount: 0, counts, axes: newAxes(dims), voidAxes, touch: null });
    heads.set(BASE_OWNER, sid);
    origSid = sid;
    // 主執行緒要一份原始的 labels（一次）
    const out = labels.slice();
    const c = counts.slice();
    return [{ labels: out, raw, counts: c, liners }, [out.buffer, c.buffer]];
  },
  fork: ({ owner, src, sid }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被覆蓋');
    const b = books.get(src);
    if (!b) throw new Error(`Worker 沒有帳簿 ${src}`);
    books.set(owner, copyBook(b));
    heads.set(owner, sid ?? heads.get(src)!);
    const cs = compsOf.get(src);
    if (cs) compsOf.set(owner, cs);
    return [null, []];
  },
  comps: ({ owner, comps }) => {
    compsOf.set(owner, comps);
    return [null, []];
  },
  put: ({ owner, sid, vol, labels, comps }) => {
    if (comps) compsOf.set(owner, comps);
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
    const all: BBox = { x0: 0, x1: dims.X - 1, y0: 0, y1: dims.Y - 1, z0: 0, z1: dims.Z - 1 };
    // 主執行緒送來的整本帳簿：diff 與 VOID 直方圖各一次 O(N) 重數
    books.set(owner, { data: vol.data, labels, diff, diffCount, counts: countAll(vol.data), axes: recountAxes(dims, diff, diffCount ? all : null), voidAxes: recountMatAxes(dims, vol.data, VOID, null), touch: all });
    heads.set(owner, sid);
    return [null, []];
  },
  drop: ({ owners }) => {
    for (const o of owners)
      if (o !== BASE_OWNER) {
        books.delete(o);
        heads.delete(o);
        compsOf.delete(o);
      }
    return [null, []];
  },
  apply: (req) => drain(gens.apply(req)),
  derive: ({ owner, from, to, step, dir }) => {
    const b = bookAt(owner, from);
    const cs = applyStepInPlace(dims, b.data, b.labels, step, dir);
    if (cs) compsOf.set(owner, cs);
    b.diffCount = carryStepStats(dims, b.data, origBook().data, b.diff!, b.diffCount, b.counts, step, dir, b.axes, b.voidAxes);
    growTouch(b, step);
    heads.set(owner, to);
    parents.set(to, { from, box: step.data?.box ?? null, labelBox: step.labels?.box ?? step.data?.box ?? null });
    return [null, []];
  },
  exportMeta: ({ raw, fractions }) => {
    if (raw !== undefined) exportRaw = raw;
    if (!fractions) exportRaw = null;
    exportFractions = fractions;
    return [null, []];
  },
  export: (() => {
    throw new Error('export 是非同步的，請用 handleAny');
  }) as never,
  vtiInspect: (() => {
    throw new Error('vtiInspect 是非同步的，請用 handleAny');
  }) as never,
  vtiDecode: (() => {
    throw new Error('vtiDecode 是非同步的，請用 handleAny');
  }) as never,
  vtiDrop: () => {
    pendingRaw = null;
    return [null, []];
  },
  npyDecode: ({ buf }) => {
    const vol = decodeNpy(buf);
    return [{ vol }, [vol.data.buffer]];
  },
  chunks: (req) => drain(gens.chunks(req)),
  mesh: ({ sid, hidden, diff, only, palette, tint, inflate }) => {
    const { vol, labels } = stateOf(sid);
    if (only) {
      // 選取層、空洞層只在外框裡做 greedy mesh，不掃整個陣列三次
      let test: (i: number) => boolean;
      let box: BBox | null;
      if ('mat' in only) {
        test = (i) => vol.data[i] === only.mat;
        // 空洞層（A5）：帳簿的 VOID 直方圖給貼合外框；其他材質才掃整個陣列
        box = only.mat === VOID ? voidBoxOf(stateOf(sid).book) : boxOf(vol, test);
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
  diffBox: ({ sid }) => {
    const b = stateOf(sid).book;
    const box = diffBoxOf(b);
    return [box ? { ...box } : null, []];
  },
  diff: ({ sid }) => {
    const b = stateOf(sid).book;
    const mask = b.diff ? b.diff.slice() : new Uint8Array(b.data.length);
    return [{ mask, count: b.diffCount }, [mask.buffer]];
  },
  count: ({ sid }) => [Array.from(stateOf(sid).book.counts), []],
  probe: ({ sid, comps: comps0, ...req }) => {
    const owner = ownerOfSid(sid);
    const { vol, labels } = stateOf(sid);
    const comps = comps0 ?? compsOf.get(owner);
    if (!comps) throw new Error(`Worker 沒有 ${owner} 的結構清單`);
    return [probe({ vol, L: { labels, comps } }, req), []];
  },
  layer: (req) => drain(gens.layer(req)),
  preview: ({ sid, comps: comps0, op, cap, hidden, palette, showDiff, seq, mesh }) => {
    const owner = ownerOfSid(sid);
    const { vol, labels, book } = stateOf(sid);
    // comps：主執行緒不再每幀送（plan v15 §10），用 Worker 自己存的那份（兩邊逐欄相同，worker.test 有斷言）
    const comps = comps0 ?? compsOf.get(owner);
    if (!comps) throw new Error(`Worker 沒有 ${owner} 的結構清單`);
    const report = newReport();
    const p = previewOp({ vol, L: { labels, comps } }, volOf(origBook()), op, cap, report);
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

/**
 * 匯出（非同步：.vti 壓縮用 CompressionStream）。帳簿先複製一份（壓縮期間之後的請求可能改到它）；原始直接用（永遠不寫）。
 * 同格式匯出帶 hint（plan v15 C1）：帳簿的 diff 與外框、原始沒有改點。
 */
async function exportOne(req: Requests['export']['req']): Promise<[Requests['export']['res'], Transferable[]]> {
  const o = origBook();
  let data: Uint8Array;
  let hint: ExportHint;
  if (req.owner) {
    const b = books.get(req.owner);
    if (!b) throw new Error(`Worker 沒有帳簿 ${req.owner}`);
    data = b.data.slice();
    // diff 在 encodeVtiLike 一開始就同步掃完（第一個 await 之前），之後帳簿再改也不影響這次
    hint = { ...(b.diff ? { diff: b.diff } : {}), box: diffBoxOf(b), dims: { ...dims } };
  } else {
    data = o.data;
    hint = { box: null, dims: { ...dims } };
  }
  const vol: Volume = { X: dims.X, Y: dims.Y, Z: dims.Z, data };
  let bytes: Uint8Array;
  let stats: ExportStats | undefined;
  if (req.format === 'npy') bytes = encodeNpy(vol);
  else if (req.format === 'vti' && exportRaw && exportFractions) {
    stats = { blocks: 0, redone: 0 };
    // parts 裡沒碰到的 block 是原檔的 view，不能 transfer 原檔的 buffer：接成一塊再 transfer
    bytes = await encodeVtiLike(exportRaw, exportFractions, data, o.data, req.materials, hint, { stats });
  } else bytes = await encodeVti(vol, req.spacing, req.origin, req.arrayName);
  return [{ bytes, ...(stats ? { stats } : {}) }, [bytes.buffer]];
}

/** 上傳的 .vti：只看標頭，原檔留在 Worker 等確認（plan v15 C3）。 */
async function vtiInspectOne(req: Requests['vtiInspect']['req']): Promise<[VtiInspect, Transferable[]]> {
  pendingRaw = req.buf;
  try {
    return [await inspectVti(req.buf), []];
  } catch (e) {
    pendingRaw = null;
    throw e;
  }
}

/** 對 pendingRaw 解碼；keepRaw 且有比例陣列時它就成為匯出用的原檔（主執行緒從頭到尾沒有第二份）。 */
async function vtiDecodeOne(req: Requests['vtiDecode']['req']): Promise<[Requests['vtiDecode']['res'], Transferable[]]> {
  const raw = pendingRaw;
  if (!raw) throw new Error('Worker 沒有待解碼的 .vti（要先 vtiInspect）');
  pendingRaw = null;
  const { keepRaw, ...opts } = req;
  const r = await decodeVti(raw, opts);
  if (keepRaw && r.info.fractions) {
    exportRaw = raw;
    exportFractions = r.info.fractions;
  }
  return [r, [r.vol.data.buffer]];
}

/** worker.ts 用：同步的照舊；export／vtiInspect／vtiDecode 回 Promise。 */
export function handleAny(type: Kind, req: unknown): [unknown, Transferable[]] | Promise<[unknown, Transferable[]]> {
  if (type === 'export') return exportOne(req as Requests['export']['req']);
  if (type === 'vtiInspect') return vtiInspectOne(req as Requests['vtiInspect']['req']);
  if (type === 'vtiDecode') return vtiDecodeOne(req as Requests['vtiDecode']['req']);
  return handle(type, req);
}

/** 材質調色盤 → 每個網格代碼的顏色（標紅的混紅）。 */
export const colorFn = (palette: Float32Array) => (c: number): [number, number, number] => {
  const id = c & 255;
  const r = palette[id * 3];
  const g = palette[id * 3 + 1];
  const b = palette[id * 3 + 2];
  return c & DIFF_BIT ? [r * 0.35 + 0.65, g * 0.35 + 0.2, b * 0.35 + 0.2] : [r, g, b];
};
