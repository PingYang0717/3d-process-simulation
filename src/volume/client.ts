// 主執行緒呼叫 Worker：call('mesh', {...}) → Promise；並記得哪些狀態已經常駐在 Worker。
import type { Kind, Requests } from './worker';
import type { EditState } from './ops';
import type { Step } from './patch';
import type { ExportStats } from './vti';
import { setProgress } from './progress';
import type { Progress } from './workerCore';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; type: string }>();
/** 每一類請求最新一筆還在跑的 id（取消用）。 */
const inflight = new Map<string, number>();
/** 有進度／可取消的請求（和 workerCore 的 gens 一致）。 */
const TRACKED = new Set(['apply', 'chunks', 'layer']);

/** 單檔 prototype 把 Worker 原始碼放在這個全域變數；平常由 Vite 另外打包。 */
declare global {
  // eslint-disable-next-line no-var
  var __WORKER_SRC__: string | undefined;
}

function get() {
  if (worker) return worker;
  const src = globalThis.__WORKER_SRC__;
  worker = src
    ? new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; ok?: boolean; result?: unknown; error?: string; progress?: Progress }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress) {
      // 進度：只有這一類最新的那一筆才顯示（舊的還在跑也不蓋）
      if (inflight.get(p.type) === e.data.id) setProgress(p.type, e.data.progress);
      return;
    }
    pending.delete(e.data.id);
    if (inflight.get(p.type) === e.data.id) {
      inflight.delete(p.type);
      if (TRACKED.has(p.type)) setProgress(p.type, null);
    }
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  return worker;
}

/** 一筆 Worker 請求的摘要（開發模式 window.__calls，e2e 用；不留大陣列）。 */
export interface CallNote {
  type: string;
  at: number;
  diff?: boolean;
  showDiff?: boolean;
  filter?: string;
  owner?: string;
  keep?: string;
}
const noteOf = (type: string, req: Record<string, unknown>): CallNote => {
  const f = req.filter as Record<string, unknown> | undefined;
  return {
    type,
    at: Date.now(),
    ...(req.diff !== undefined ? { diff: !!req.diff } : {}),
    ...(req.showDiff !== undefined ? { showDiff: !!req.showDiff } : {}),
    ...(f ? { filter: 'diff' in f ? 'diff' : 'mat' in f ? 'mat' : 'comps' } : {}),
    ...(typeof req.owner === 'string' ? { owner: req.owner } : {}),
    ...(typeof req.keep === 'string' ? { keep: req.keep } : {}),
  };
};
const DEV = (() => {
  try {
    return !!import.meta.env?.DEV;
  } catch {
    return false;
  }
})();
/** 開發模式：最近 5,000 筆請求（e2e 斷言用）。 */
function record(type: string, req: unknown) {
  if (!DEV || typeof window === 'undefined') return;
  const w = window as unknown as { __calls?: CallNote[] };
  const list = (w.__calls ??= []);
  list.push(noteOf(type, (req ?? {}) as Record<string, unknown>));
  if (list.length > 5000) list.splice(0, list.length - 5000);
}

/** transfer 只放呼叫端之後不再用的陣列（會被搬走）。Worker 依送出順序一個一個處理。 */
export function call<K extends Kind>(type: K, req: Requests[K]['req'], transfer: Transferable[] = []): Promise<Requests[K]['res']> {
  record(type, req);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, type });
    inflight.set(type, id);
    get().postMessage({ id, type, req }, transfer);
  });
}

/** 取消錯誤（Worker 在安全點停掉、或還沒開始就被拿掉）。 */
export const isCancelled = (e: unknown) => (e as Error)?.message === 'cancelled';

/**
 * 取消這一類最新一筆還在跑的請求（plan v16）：Worker 在下一個安全點停（apply 在寫回帳簿之前、chunks／layer 在兩批之間），
 * 那一筆的 Promise 以 'cancelled' reject。已經過了安全點就讓它做完（呼叫端自己決定要不要復原）。
 */
export function cancelCall(type: string) {
  const id = inflight.get(type);
  if (id === undefined || !worker) return false;
  worker.postMessage({ cancel: id });
  return true;
}

// ---- 常駐狀態：版本號（version）＝ Worker 裡的編號（sid）；帳簿（owner）＝原始（'base'）或目前（'cur'）的那一份陣列 ----
// 版本號全域單調遞增：每個新的體素狀態（載入、每一步的結果）拿一個新號碼；改名、改色不換號碼。
// plan v9 §4.2：Worker 每個 owner 只有一份陣列（原地貼補丁），heads 記主執行緒認為它現在是哪一版。

const heads = new Map<string, number>();
let nextVersion = 1;
/** 沒帶版本號的狀態（測試、舊程式碼）退回用陣列身分配號。 */
const fallback = new WeakMap<Uint8Array, number>();

/** 下一個版本號。 */
export const newVersion = () => nextVersion++;

/** 狀態在哪一本帳簿。 */
export const ownerOf = (s: Pick<EditState, 'owner'>) => s.owner ?? 'base';

/** 狀態的版本號（＝ Worker 裡的 sid）。 */
export function sidOf(s: Pick<EditState, 'vol' | 'version'>) {
  if (s.version !== undefined) return s.version;
  let id = fallback.get(s.vol.data);
  if (!id) {
    id = nextVersion++;
    fallback.set(s.vol.data, id);
  }
  return id;
}


/**
 * 確保 Worker 的帳簿正好是 s（s 必須是主執行緒這本帳簿目前的內容）；對不上就補送（保險，理論上不會發生）。
 * 只在改帳簿的路徑（apply／derive／fork）之前呼叫；畫面的請求直接送 sidOf，過期的由 Worker 回錯誤、丟掉。
 */
export function ensure(s: EditState) {
  const id = sidOf(s);
  const owner = ownerOf(s);
  if (heads.get(owner) !== id) {
    heads.set(owner, id);
    call('put', { owner, sid: id, vol: s.vol, labels: s.L.labels, comps: s.L.comps });
  }
  return id;
}

/** 主執行緒命名好的結構清單送給 Worker（載入後對原始一次；plan v15 §10）：之後拖拉預覽不必每幀送 comps。 */
export function compsIn(owner: string, comps: EditState['L']['comps']) {
  return call('comps', { owner, comps });
}

/** 載入新的原始陣列：Worker 標記結構，之前的帳簿全部丟掉。回傳的 version 是原始的版本號。 */
export async function loadOrig(vol: EditState['vol']) {
  const sid = newVersion();
  heads.clear();
  heads.set('base', sid);
  const r = await call('load', { sid, vol });
  return { ...r, version: sid };
}

/** 開新帳簿 owner：複製 from 的那一本（Worker 端整陣列複製一次）。sid＝新帳簿的版本號（省略＝和 from 相同）。 */
export function forkIn(owner: string, from: EditState, sid = sidOf(from)) {
  ensure(from);
  heads.set(owner, sid);
  return call('fork', { owner, src: ownerOf(from), sid });
}

/** 釋放帳簿。 */
export function dropOwners(owners: string[]) {
  if (!owners.length) return;
  for (const o of owners) heads.delete(o);
  void call('drop', { owners }).catch(() => {});
}

/** 一步操作在 Worker 裡原地算（§4.3）：from.owner 的帳簿前進到新版本號，回傳補丁與報告。 */
export async function applyIn(from: EditState, req: Omit<Requests['apply']['req'], 'owner' | 'from' | 'to' | 'comps'>) {
  const owner = ownerOf(from);
  const fromId = ensure(from);
  const to = newVersion();
  try {
    const r = await call('apply', { ...req, owner, from: fromId, to, comps: from.L.comps });
    heads.set(owner, r.step.data ? to : fromId);
    return { ...r, version: to };
  } catch (e) {
    // 取消：Worker 在寫回之前停的，帳簿仍是 from，不必補送
    if (isCancelled(e)) throw e;
    // Worker 的帳簿狀態不明：主執行緒還沒貼，內容仍是 from，補送回去
    heads.delete(owner);
    ensure(from);
    throw e;
  }
}

/**
 * 復原／重做：Worker 的帳簿從 from 原地套補丁成為 to（to 通常是以前的版本號，內容相同）。
 * 必須在主執行緒原地貼之前呼叫（ensure 可能要補送 from 的內容）。
 */
export function deriveIn(from: EditState, to: number, step: Step, dir: 'fwd' | 'back') {
  const owner = ownerOf(from);
  const fromId = ensure(from);
  heads.set(owner, to);
  return call('derive', { owner, from: fromId, to, step, dir }).catch((e) => {
    // Worker 沒跟上：下一次 ensure 會補送主執行緒的內容
    if (heads.get(owner) === to) heads.delete(owner);
    throw e;
  });
}

/** 拖拉第 2 級預覽（§4.5）：在 Worker 裡對 s（目前的版本）算預覽與網格。s 過期時 Worker 回錯誤。comps 不送（plan v15 §10），Worker 用自己那份。 */
export function previewIn(s: EditState, req: Omit<Requests['preview']['req'], 'sid' | 'comps'>) {
  return call('preview', { ...req, sid: sidOf(s) });
}

/** 試算（plan v17 §5.4.4）：對 s（目前的版本）算誰跟著、誰變薄、最多幾格。s 過期時 Worker 回錯誤。 */
export function probeIn(s: EditState, req: Omit<Requests['probe']['req'], 'sid' | 'comps'>) {
  return call('probe', { ...req, sid: sidOf(s) });
}

// ---- 載入與匯出（plan v15 C2～C4：解碼在 Worker、原檔只留 Worker 一份、匯出帶 crc） ----

/** 上傳的 .vti 只看標頭：buf transfer 給 Worker（呼叫之後主執行緒的 buf 已空），Worker 留著等 decodeVtiIn 或 dropVtiIn。 */
export function inspectVtiIn(buf: ArrayBuffer) {
  return call('vtiInspect', { buf }, [buf]);
}

/** 對剛 inspect 的 .vti 解碼；keepRaw 且有比例陣列時原檔留在 Worker 當匯出用（之後 exportMetaIn 只要送 fractions）。 */
export function decodeVtiIn(req: Requests['vtiDecode']['req']) {
  return call('vtiDecode', req);
}

/** 使用者取消：釋放 Worker 裡的原檔。 */
export function dropVtiIn() {
  return call('vtiDrop', {}).catch(() => {});
}

/** .npy 也在 Worker 解（buf transfer）。 */
export function decodeNpyIn(buf: ArrayBuffer) {
  return call('npyDecode', { buf }, [buf]);
}

/** 匯出要的比例陣列（載入時送一次）；原檔已在 Worker（decodeVtiIn keepRaw）。null＝沒有同格式匯出，Worker 把原檔也放掉。 */
export function exportMetaIn(fractions: Requests['exportMeta']['req']['fractions']) {
  return call('exportMeta', { fractions });
}

/** 匯出結果：位元組本身，附同格式匯出的 block 統計。 */
export type ExportBytes = Uint8Array & { stats?: ExportStats };

/** 匯出一個狀態：目前的帳簿（state）；沒有＝原始。 */
export async function exportIn(src: { state?: EditState }, req: Omit<Requests['export']['req'], 'owner'>): Promise<ExportBytes> {
  let r: Requests['export']['res'];
  if (src.state && ownerOf(src.state) !== 'base') {
    ensure(src.state);
    r = await call('export', { ...req, owner: ownerOf(src.state) });
  } else r = await call('export', req);
  return Object.assign(r.bytes, r.stats ? { stats: r.stats } : {});
}
