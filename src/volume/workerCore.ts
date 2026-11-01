// Worker 的本體（plan v9 §4.2）：每個 split（owner）的體素、結構編號、diff、體積帳在這裡各只有一份，
// 每一步原地貼補丁（不整個陣列影印）。原始是 owner 'base'，永遠不寫。
// 純模組（沒有 self.onmessage），worker.ts 接訊息；測試與 bench 直接呼叫 handle()。
import { type BBox, type Comp, type MeshData, type RawComp, type Volume, DIFF_BIT, VOID, greedyMesh, labelComponents } from './volume';
import { type Scope, clipBox } from './scope';
import { type Op, upgradeOp } from './ops';
import { applyOpInPlace } from './apply';
import { previewOp } from './preview';
import { previewMesh } from './previewMesh';
import { newReport } from './kernel';
import { type TracedHandle, ringCache } from '../slice/relative';
import { type Axes, type DiffAxes, type Step, applyStepInPlace, boxOfAxes, carryStepStats, copyAxes, newAxes, recountAxes, recountMatAxes, unionBox } from './patch';
import { type OpReport, summarize } from './report';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from './chunks';
import { type SplitPatch, type SplitStats, applyPatch, extractPatch, patchStats, stepTouch } from '../splits/lifecycle';
import { pasteArr, cropArr, globalIndex } from './patch';
import { type DecodeOptions, type ExportHint, type ExportMaterial, type ExportStats, type FractionArray, type VtiInfo, type VtiInspect, decodeVti, encodeVti, encodeVtiLike, inspectVti } from './vti';
import { decodeNpy, encodeNpy } from './volume';
import { crc32 } from './zip';

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
export type LayerFilter = { comps: number[]; scope: Scope; box: BBox } | { mat: number } | { diff: true };

export interface Requests {
  /** 載入原始：存起來並標記結構；之前的狀態全部丟掉。回傳原始的體積帳（主執行緒不再自己數）。 */
  load: { req: { sid: number; vol: Volume }; res: { labels: Int32Array; raw: RawComp[]; counts: Float64Array } };
  /** 開一本新帳簿：複製 src 目前的內容給 owner（這是整個流程裡唯一的整陣列複製）。sid 省略＝沿用 src 的版本號。 */
  fork: { req: { owner: string; src: string; sid?: number }; res: null };
  /** 保險：主執行緒的內容補送過來（只在 head 對不上時）。comps：拖拉預覽用（plan v15 §10，Worker 存 compsOf）。 */
  put: { req: { owner: string; sid: number; vol: Volume; labels: Int32Array; comps?: Comp[] }; res: null };
  /** 主執行緒命名好的結構清單（載入後對原始送一次）：拖拉預覽不再每幀送 comps（plan v15 §10）。 */
  comps: { req: { owner: string; comps: Comp[] }; res: null };
  /** 釋放這些帳簿。 */
  drop: { req: { owners: string[] }; res: null };
  /** 從 src（版本 from）複製出 owner，原地逐個套 ops，結果是版本 to；複本 transfer 回主執行緒（新 split 一次）。 */
  replay: {
    req: { owner: string; src: string; from: number; to: number; comps: Comp[]; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    /** axes：三條軸的 diff 直方圖（plan v15 A2），主執行緒的帳簿接著差量維護。 */
    res: { data: Uint8Array; labels: Int32Array; diff: Uint8Array; diffCount: number; counts: Float64Array; comps: Comp[]; keyCounter: number; blocked: number; touch: BBox | null; axes: DiffAxes };
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
  /** 和原始不同的格子的外框（貼合；沒有不同回 null）。 */
  diffBox: { req: { sid: number }; res: BBox | null };
  /**
   * 產生 split（plan v12 §5.3 D12）：在一本重複使用的 scratch 帳簿上從 src 重播（只把上一次改過的範圍從原始貼回來，
   * 不另外 fork），裁出補丁、算摘要，只傳回補丁（O(外框)）；主執行緒拿到的就是 parked split，Worker 不留帳簿。
   */
  replayPatch: {
    req: { src: string; from: number; comps: Comp[]; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    res: { patch: SplitPatch; stats: SplitStats; keyCounter: number; blocked: number };
  };
  /** 還原 parked split 成 live：原始複本（O(N) memcpy）＋貼補丁，版本 sid；parents 記成「從原始、改了 box」，網格只重算 box 碰到的 chunk。 */
  restore: { req: { owner: string; sid: number; patch: SplitPatch }; res: null };
  /** 對 parked split 套一串 Op（「套用到所有 split」）：scratch 上 restore → 套用 → 裁補丁，不留帳簿。 */
  applyParked: {
    req: { patch: SplitPatch; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    res: { patch: SplitPatch; stats: SplitStats; keyCounter: number; reports: OpReport[]; changed: number[] };
  };
  /**
   * 匯出要的比例陣列（照原格式寫回，plan v11 §4.0）：載入時送一次。原檔本身在 vtiDecode keepRaw 時就留在 Worker（plan v15 C3）；
   * raw 是舊呼叫端（測試、bench）直接帶原檔用的，省略＝沿用 Worker 手上那份。fractions 為 null＝沒有同格式匯出，原檔一併釋放。
   */
  exportMeta: { req: { raw?: ArrayBuffer | null; fractions: FractionArray[] | null }; res: null };
  /**
   * 匯出一個 split（plan v12 §5.3）：live 給 owner（直接用它的帳簿），parked 給 patch；編碼在 Worker 裡做。
   * crc：zip 用的 CRC-32，主執行緒不再算（plan v15 C2）；stats：同格式匯出時 block 總數與重壓數（bench／e2e 看）。
   */
  export: {
    req: { owner?: string; patch?: SplitPatch; format: 'vti' | 'vti1' | 'npy'; spacing: number[]; origin: number[]; arrayName: string; materials: ExportMaterial[] };
    res: { bytes: Uint8Array; crc: number; stats?: ExportStats };
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
    /** alts：主執行緒快取裡還有的同畫法版本（plan v12 §5.3：restore 回來的 split 的上一版是原始，從原始的網格增量）。 */
    req: { sid: number; key: string; hidden: Uint8Array; diff: boolean; palette: Float32Array; base?: number; alts?: number[] };
    /** from：增量時是從哪個版本改過來的（主執行緒拿那一組 chunk 當底）。 */
    res: { full: boolean; items: ChunkItem[]; from?: number };
  };
  /** 保留給測試與保險。 */
  count: { req: { sid: number }; res: number[] };
  /**
   * 圖層（§4.6）：選取（結構編號 ∩ scope）或某個材質（VOID）的單色網格，和主網格同一套 chunk。
   * key＝畫法（選了哪些結構的 key、scope、外推、顏色）；base 是 sid 的上一步時只回改到的 chunk
   * （選取看 labels，髒的範圍是 relabel 的 S；材質看體素，髒的是補丁外框），否則只算和 box 相交的 chunk。
   */
  layer: {
    /** palette：有給就用材質原色（聚焦編輯的「選取實色」，plan v10 §4.5；差異層一定要給），沒給就整層 tint。hidden：差異層不畫的材質。 */
    req: { sid: number; key: string; filter: LayerFilter; tint: [number, number, number]; inflate?: number; base?: number; palette?: Float32Array; hidden?: Uint8Array };
    res: { full: boolean; items: ChunkItem[] };
  };
  /**
   * 拖拉第 2 級預覽（§4.5）：在 Worker 裡裁切重算＋預覽網格；拖拉期間 Worker 閒著、狀態已常駐，不必傳陣列。
   * 每片的輪廓同一次拖拉只描一次（快取 key 含 sid 與手勢的把手，換 sid 就清空）。超過 cap 回 none。
   */
  preview: {
    /** comps 可省略（plan v15 §10）：Worker 用自己在 apply／derive／replay／restore／comps 存下的那份。 */
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
  /** 所有改過的範圍（data、labels 的 S、換編號的結構外框）的聯集：外面和原始逐位元組相同（park／scratch 只碰這裡）。 */
  touch: BBox | null;
}

let dims = { X: 1, Y: 1, Z: 1 };
const books = new Map<string, Book>();
/** 每本帳簿現在是哪個版本。 */
const heads = new Map<string, number>();
/** 每個版本從哪一版、改了哪個外框來的（box：體素；labelBox：結構編號，⊇ box）。chunk／圖層只重算改到的地方。 */
const parents = new Map<number, { from: number; box: BBox | null; labelBox: BBox | null }>();
let origSid = 0;
/** 每本帳簿現在的結構清單（plan v15 §10）：apply／derive／replay／restore／put／comps 都會更新，拖拉預覽用它、不必每幀送。 */
const compsOf = new Map<string, Comp[]>();
/** 測試用：整陣列掃描的次數（A5：VOID 層不該呼叫 boxOf）與 layer 算過的 chunk 數（VOID 層只該算貼合 VOID 外框碰到的）。 */
export const scanStats = { boxOf: 0, layerChunks: 0 };
/** 拖拉預覽的每片輪廓快取（§4.5）：只對 previewSid 有效。 */
const rings = ringCache();
let previewSid = -1;
/** 測試用：輪廓快取命中／描了幾次。 */
export const previewStats = rings.stats;

/** 測試用：看 Worker 的內部狀態。 */
export const inspect = () => ({ books, heads, parents, origSid, compsOf, scratch, pendingRaw, exportRaw, exportFractions });

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

/** 重複使用的帳簿（plan v12 §5.3）：產生 split、對 parked split 套用、匯出 parked split 都在這裡算，不另外 fork。 */
let scratch: Book | null = null;
const copyIn = <T extends Uint8Array | Int32Array>(dst: T, src: T, box: BBox) => pasteArr(dst, dims, box, cropArr(src, dims, box));
/** scratch 變成 src 的內容：先把上一次改過的範圍從原始貼回來（O(外框)），再貼 src 改過的範圍。 */
function resetScratch(src: Book): Book {
  const o = origBook();
  if (!scratch || scratch.data.length !== o.data.length) scratch = { ...copyBook(o), touch: null };
  else if (scratch.touch) {
    copyIn(scratch.data, o.data, scratch.touch);
    copyIn(scratch.labels, o.labels, scratch.touch);
    pasteArr(scratch.diff!, dims, scratch.touch, new Uint8Array(boxSizeOf(scratch.touch)));
  }
  const b = scratch;
  if (src !== o && src.touch) {
    copyIn(b.data, src.data, src.touch);
    copyIn(b.labels, src.labels, src.touch);
    if (src.diff) copyIn(b.diff!, src.diff, src.touch);
  }
  b.counts = src.counts.slice();
  b.diffCount = src.diffCount;
  // scratch 的 data、diff 現在和 src 的逐位元組相同（touch 外都和原始相同），兩種直方圖直接複製
  b.axes = copyAxes(src.axes);
  b.voidAxes = copyAxes(src.voidAxes);
  b.touch = src.touch ? { ...src.touch } : null;
  return b;
}
const boxSizeOf = (b: BBox) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
/** 補丁貼到 b（b 必須是原始的內容）：data、labels、diff、體積帳、外框。 */
function pastePatch(b: Book, p: SplitPatch) {
  const o = origBook();
  if (p.box) {
    // VOID 直方圖差量（A5）：貼之前在 box 裡逐格比「現在的 data」和「補丁要貼的」，從 VOID 變走 −1、變成 VOID ＋1
    const bx = p.box;
    const va = b.voidAxes;
    const W = bx.x1 - bx.x0 + 1;
    for (let z = bx.z0, k = 0; z <= bx.z1; z++)
      for (let y = bx.y0; y <= bx.y1; y++) {
        const row = (z * dims.Y + y) * dims.X + bx.x0;
        for (let x = 0; x < W; x++, k++) {
          const old = b.data[row + x];
          const now = p.data[k];
          if (old === now || (old !== VOID && now !== VOID)) continue;
          const dv = now === VOID ? 1 : -1;
          va.x[bx.x0 + x] += dv;
          va.y[y] += dv;
          va.z[z] += dv;
        }
      }
  }
  applyPatch(dims, b.data, b.labels, p);
  const st = patchStats(dims, p, o.data, o.counts);
  if (p.box) {
    const bx = p.box;
    for (let z = bx.z0; z <= bx.z1; z++)
      for (let y = bx.y0; y <= bx.y1; y++) {
        const row = (z * dims.Y + y) * dims.X;
        for (let x = bx.x0; x <= bx.x1; x++) b.diff![row + x] = b.data[row + x] !== o.data[row + x] ? 1 : 0;
      }
  }
  b.counts = st.counts;
  b.diffCount = st.changed;
  // b 是原始的內容，box 外的 diff 都是 0：在 box 裡重數一次（O(patch)）
  recountAxes(dims, b.diff!, p.box, b.axes);
  b.touch = p.box ? { ...p.box } : null;
}
/** 帳簿 → 補丁＋摘要。 */
function patchOf(b: Book, comps: Comp[]): { patch: SplitPatch; stats: SplitStats } {
  const o = origBook();
  const patch = extractPatch(dims, b.data, b.labels, o.data, o.labels, b.touch, comps);
  return { patch, stats: { changed: b.diffCount, diffBox: diffBoxOf(b), counts: b.counts.slice() } };
}
const patchTransfer = (p: SplitPatch, st?: SplitStats): Transferable[] => [p.data.buffer, p.labels.buffer, ...(st ? [st.counts.buffer] : [])];
/** 匯出用的原檔（plan v15 C4：全程只有 Worker 這一份）與比例陣列。 */
let exportRaw: ArrayBuffer | null = null;
let exportFractions: FractionArray[] | null = null;
/** 上傳中的 .vti（vtiInspect 收到、等使用者確認）：vtiDecode 用掉或 vtiDrop 釋放。 */
let pendingRaw: ArrayBuffer | null = null;
/**
 * parked split 匯出用的重複使用陣列（plan v15 §5.5：parked 不再每次 slice 一份原始）：和 scratch 一樣只把上一次貼過的範圍
 * 從原始貼回來。export 是非同步的（壓縮期間其他請求照常處理），所以不能借用 scratch；busy 時（兩個匯出重疊）退回複製。
 */
let exportBuf: { data: Uint8Array; touch: BBox | null; busy: boolean } | null = null;
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
  if (r.step.data) {
    b.diffCount = carryStepStats(dims, b.data, origBook().data, b.diff!, b.diffCount, b.counts, r.step, 'fwd', b.axes, b.voidAxes);
    growTouch(b, r.step);
  }
  return r;
}

/** 差異模式裡「原本有、現在是空氣」的體素代碼（材質編號只到 254）。 */
export const REMOVED = 255;
/** 被拿掉的紅（和 2D 切面的 REMOVED_RGB #ff4d4f 同色）。 */
const REMOVED_RGB: [number, number, number] = [1, 77 / 255, 79 / 255];

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

export const handlers: { [K in Kind]: Handler<K> } = {
  load: ({ sid, vol }) => {
    books.clear();
    heads.clear();
    parents.clear();
    dims = { X: vol.X, Y: vol.Y, Z: vol.Z };
    compsOf.clear();
    const { labels, raw } = labelComponents(vol);
    const { counts, voidAxes } = countAllAndVoid(vol);
    books.set(BASE_OWNER, { data: vol.data, labels, diff: null, diffCount: 0, counts, axes: newAxes(dims), voidAxes, touch: null });
    scratch = null;
    exportBuf = null;
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
    compsOf.set(owner, r.comps);
    // 報告在 Worker 摘要（plan v15 C7）：被擋的格子只回前 BLOCKED_CAP 個，不 clone 整個 blockedAt
    const report = summarize(r.report, op, dims);
    return [{ step: r.step, keyCounter: seq(), report }, [...stepBuffers(r.step), report.cells.buffer]];
  },
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
  replay: ({ owner, src, from, to, comps, ops, matNames, keyCounter }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被覆蓋');
    const b = copyBook(bookAt(src, from));
    const { ctx, seq } = ctxOf(matNames, keyCounter);
    let cs = comps;
    let blocked = 0;
    for (const op of ops) {
      const r = applyTo(b, cs, upgradeOp(op), ctx);
      cs = r.comps;
      blocked += r.report.blocked;
    }
    books.set(owner, b);
    heads.set(owner, to);
    compsOf.set(owner, cs);
    parents.delete(to);
    // Worker 自己留一份，複本 transfer 回主執行緒（新 split 一次）
    const out = copyBook(b);
    return [
      { data: out.data, labels: out.labels, diff: out.diff!, diffCount: out.diffCount, counts: out.counts, comps: cs, keyCounter: seq(), blocked, touch: out.touch, axes: out.axes },
      [out.data.buffer, out.labels.buffer, out.diff!.buffer, out.counts.buffer, out.axes.x.buffer, out.axes.y.buffer, out.axes.z.buffer],
    ];
  },
  replayPatch: ({ src, from, comps, ops, matNames, keyCounter }) => {
    const b = resetScratch(bookAt(src, from));
    const { ctx, seq } = ctxOf(matNames, keyCounter);
    let cs = comps;
    let blocked = 0;
    for (const op of ops) {
      const r = applyTo(b, cs, upgradeOp(op), ctx);
      cs = r.comps;
      blocked += r.report.blocked;
    }
    const { patch, stats } = patchOf(b, cs);
    return [{ patch, stats, keyCounter: seq(), blocked }, patchTransfer(patch, stats)];
  },
  restore: ({ owner, sid, patch }) => {
    if (owner === BASE_OWNER) throw new Error('原始不能被覆蓋');
    const b = copyBook(origBook());
    pastePatch(b, patch);
    books.set(owner, b);
    heads.set(owner, sid);
    compsOf.set(owner, patch.comps);
    // 網格：從原始的版本只重算補丁外框碰到的 chunk
    parents.set(sid, { from: origSid, box: patch.box, labelBox: patch.box });
    return [null, []];
  },
  applyParked: ({ patch, ops, matNames, keyCounter }) => {
    const b = resetScratch(origBook());
    pastePatch(b, patch);
    const { ctx, seq } = ctxOf(matNames, keyCounter);
    let cs = patch.comps;
    const reports: OpReport[] = [];
    const changed: number[] = [];
    for (const op of ops) {
      const r = applyTo(b, cs, upgradeOp(op), ctx);
      cs = r.comps;
      reports.push(summarize(r.report, op, dims));
      let n = 0;
      if (r.step.data) for (let i = 0; i < r.step.data.before.length; i++) if (r.step.data.before[i] !== r.step.data.after[i]) n++;
      changed.push(n);
    }
    const out = patchOf(b, cs);
    return [{ ...out, keyCounter: seq(), reports, changed }, [...patchTransfer(out.patch, out.stats), ...reports.map((r) => r.cells.buffer)]];
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
  chunks: ({ sid, key: _key, hidden, diff, palette, base: base0, alts }) => {
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
    // 主執行緒現在畫的不是上一版、但快取裡有上一版（例如 restore 回來的 split 的上一版＝原始）：從那一版增量
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
    for (const k of ks) {
      const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
      // 全量時空的 chunk 不必回傳；增量時要回（主執行緒拿掉）
      if (m.quads || !full) items.push({ k, m });
    }
    const transfer: Transferable[] = [];
    for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
    return [{ full, items, ...(full ? {} : { from: base }) }, transfer];
  },
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
  layer: ({ sid, filter, tint, inflate, base, palette, hidden }) => {
    const { vol, labels, book } = stateOf(sid);
    const g = gridOf(vol);
    const data = vol.data;
    let code: (i: number) => number;
    let box: BBox | null;
    let sel = false;
    let isDiff = false;
    if ('diff' in filter) {
      // 差異層（plan v12 §5.2）：只看 diff 外框碰到的 chunk；現在有材質＝材質色、被拿掉的＝紅
      isDiff = true;
      const d = book.diff && book.diffCount ? book.diff : null;
      const o = origBook().data;
      const hid = hidden ?? new Uint8Array(256);
      code = d
        ? (i) => {
            if (!d[i]) return 0;
            const m = data[i];
            if (m) return hid[m] ? 0 : m;
            return o[i] && !hid[o[i]] ? REMOVED : 0;
          }
        : () => 0;
      box = diffBoxOf(book);
    } else if ('mat' in filter) {
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
      if (!sel && !isDiff && (filter as { mat: number }).mat !== VOID) box = boxOf(vol, (i) => data[i] === (filter as { mat: number }).mat);
      ks = box ? chunksTouching(vol, g, box) : [];
    }
    const color = (c: number): [number, number, number] =>
      c === REMOVED && isDiff ? REMOVED_RGB : palette ? [palette[c * 3], palette[c * 3 + 1], palette[c * 3 + 2]] : tint;
    const items: ChunkItem[] = [];
    scanStats.layerChunks += ks.length;
    for (const k of ks) {
      const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
      if (inflate) for (let i = 0; i < m.positions.length; i++) m.positions[i] += m.normals[i] * inflate;
      if (m.quads || !full) items.push({ k, m });
    }
    const transfer: Transferable[] = [];
    for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
    return [{ full, items }, transfer];
  },
  preview: ({ sid, comps: comps0, op, cap, hidden, palette, showDiff, seq, mesh }) => {
    const owner = ownerOfSid(sid);
    const { vol, labels, book } = stateOf(sid);
    // comps：主執行緒不再每幀送（plan v15 §10），用 Worker 自己存的那份（兩邊逐欄相同，worker.test 有斷言）
    const comps = comps0 ?? compsOf.get(owner);
    if (!comps) throw new Error(`Worker 沒有 ${owner} 的結構清單`);
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

/** parked split 的匯出陣列：原始＋補丁，放在重複使用的 exportBuf 裡（O(上次外框＋這次外框)，不重新配置）。 */
function parkedData(patch: SplitPatch): { data: Uint8Array; release: () => void } {
  const o = origBook();
  if (!exportBuf) exportBuf = { data: o.data.slice(), touch: null, busy: false };
  const b = exportBuf;
  if (b.busy) {
    // 另一個匯出還在用它：複製一份（舊路徑）
    const data = o.data.slice();
    if (patch.box) pasteArr(data, dims, patch.box, patch.data);
    return { data, release: () => {} };
  }
  b.busy = true;
  if (b.touch) copyIn(b.data, o.data, b.touch);
  if (patch.box) pasteArr(b.data, dims, patch.box, patch.data);
  b.touch = patch.box ? { ...patch.box } : null;
  return { data: b.data, release: () => void (b.busy = false) };
}

/**
 * 匯出（非同步：.vti 壓縮用 CompressionStream）。live 的帳簿先複製一份（壓縮期間之後的請求可能改到它）；
 * parked 用 exportBuf、原始直接用（永遠不寫），都不另外配置（plan v15 §5.5）。
 * 同格式匯出帶 hint（plan v15 C1）：live 用帳簿的 diff 與外框、parked 用補丁的外框（函式自己在外框裡比對）、原始沒有改點。
 */
async function exportOne(req: Requests['export']['req']): Promise<[Requests['export']['res'], Transferable[]]> {
  const o = origBook();
  let data: Uint8Array;
  let hint: ExportHint;
  let release = () => {};
  if (req.owner) {
    const b = books.get(req.owner);
    if (!b) throw new Error(`Worker 沒有帳簿 ${req.owner}`);
    data = b.data.slice();
    // diff 在 encodeVtiLike 一開始就同步掃完（第一個 await 之前），之後帳簿再改也不影響這次
    hint = { ...(b.diff ? { diff: b.diff } : {}), box: diffBoxOf(b), dims: { ...dims } };
  } else if (req.patch) {
    const p = parkedData(req.patch);
    data = p.data;
    release = p.release;
    hint = { box: req.patch.box, dims: { ...dims } };
  } else {
    data = o.data;
    hint = { box: null, dims: { ...dims } };
  }
  try {
    const vol: Volume = { X: dims.X, Y: dims.Y, Z: dims.Z, data };
    let bytes: Uint8Array;
    let stats: ExportStats | undefined;
    if (req.format === 'npy') bytes = encodeNpy(vol);
    else if (req.format === 'vti' && exportRaw && exportFractions) {
      stats = { blocks: 0, redone: 0 };
      // parts 裡沒碰到的 block 是原檔的 view，不能 transfer 原檔的 buffer：接成一塊再 transfer
      bytes = await encodeVtiLike(exportRaw, exportFractions, data, o.data, req.materials, hint, { stats });
    } else bytes = await encodeVti(vol, req.spacing, req.origin, req.arrayName);
    return [{ bytes, crc: crc32(bytes), ...(stats ? { stats } : {}) }, [bytes.buffer]];
  } finally {
    release();
  }
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
