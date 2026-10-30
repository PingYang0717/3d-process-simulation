// 主執行緒呼叫 Worker：call('mesh', {...}) → Promise；並記得哪些狀態已經常駐在 Worker。
import type { Kind, Requests } from './worker';
import type { EditState } from './ops';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

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
  worker.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.ok) p.resolve(e.data.result);
    else p.reject(new Error(e.data.error));
  };
  return worker;
}

/** transfer 只放呼叫端之後不再用的陣列（會被搬走）。Worker 依送出順序一個一個處理。 */
export function call<K extends Kind>(type: K, req: Requests[K]['req'], transfer: Transferable[] = []): Promise<Requests[K]['res']> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    get().postMessage({ id, type, req }, transfer);
  });
}

// ---- 常駐狀態：版本號（version）＝ Worker 裡的編號（sid） ----
// 版本號全域單調遞增：每個新的體素狀態（載入、每一步的結果）拿一個新號碼；改名、改色不換號碼。
// 以前用陣列身分當 key；之後補丁式更新會原地改陣列，所以改用版本號（plan v7 §8.1）。

const resident = new Set<number>();
/** 已送出、結果還沒回來的編號；retain 時要一起留著。 */
const inflight = new Set<number>();
let nextVersion = 1;
/** 沒帶版本號的狀態（測試、舊程式碼）退回用陣列身分配號。 */
const fallback = new WeakMap<Uint8Array, number>();

/** 下一個版本號。 */
export const newVersion = () => nextVersion++;

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

/** 確保 Worker 有這個狀態；沒有就補送（只有復原回來的舊步驟會走到）。 */
export function ensure(s: EditState) {
  const id = sidOf(s);
  if (!resident.has(id) && !inflight.has(id)) {
    resident.add(id);
    call('put', { sid: id, vol: s.vol, labels: s.L.labels });
  }
  return id;
}

/** 載入新的原始陣列：Worker 標記結構，之前的狀態全部丟掉。回傳的 version 是原始的版本號。 */
export async function loadOrig(vol: EditState['vol']) {
  const sid = newVersion();
  resident.clear();
  inflight.clear();
  resident.add(sid);
  const r = await call('load', { sid, vol });
  return { ...r, version: sid };
}

/** 在 Worker 裡從 from 重播 ops，結果留在 Worker（新的版本號），複本回到主執行緒。 */
export async function replayIn(from: EditState, req: Omit<Requests['replay']['req'], 'from' | 'to' | 'comps'>) {
  const fromId = ensure(from);
  const to = newVersion();
  inflight.add(to);
  try {
    const r = await call('replay', { ...req, from: fromId, to, comps: from.L.comps });
    resident.add(to);
    return { ...r, version: to };
  } finally {
    inflight.delete(to);
  }
}

/** 只留這些狀態在 Worker（原始一定留著）；復原用的舊步驟之後要用再補送。 */
export function retain(states: EditState[]) {
  const keep = new Set(states.map(sidOf));
  for (const id of resident) if (!keep.has(id)) resident.delete(id);
  call('retain', { sids: [...keep, ...inflight] });
}
