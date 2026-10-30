// 主執行緒呼叫 Worker：call('mesh', {...}) → Promise；並記得哪些狀態已經常駐在 Worker。
import type { Kind, Requests } from './worker';
import type { EditState } from './ops';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function get() {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
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

// ---- 常駐狀態：體素陣列 → 編號（sid） ----

const sids = new WeakMap<Uint8Array, number>();
const resident = new Set<number>();
/** 已送出、結果還沒回來的編號；retain 時要一起留著。 */
const inflight = new Set<number>();
let nextSid = 1;

/** 每個體素陣列一個編號（同一份陣列＝同一個狀態，改名只換 comps 不換陣列）。 */
export function sidOf(data: Uint8Array) {
  let id = sids.get(data);
  if (!id) {
    id = nextSid++;
    sids.set(data, id);
  }
  return id;
}

/** 確保 Worker 有這個狀態；沒有就補送（只有復原回來的舊步驟會走到）。 */
export function ensure(s: EditState) {
  const id = sidOf(s.vol.data);
  if (!resident.has(id) && !inflight.has(id)) {
    resident.add(id);
    call('put', { sid: id, vol: s.vol, labels: s.L.labels });
  }
  return id;
}

/** 載入新的原始陣列：Worker 標記結構，之前的狀態全部丟掉。 */
export async function loadOrig(vol: EditState['vol']) {
  const sid = sidOf(vol.data);
  resident.clear();
  inflight.clear();
  resident.add(sid);
  return call('load', { sid, vol });
}

/** 在 Worker 裡從 from 重播 ops，結果留在 Worker，複本回到主執行緒。 */
export async function replayIn(from: EditState, req: Omit<Requests['replay']['req'], 'from' | 'to' | 'comps'>) {
  const fromId = ensure(from);
  const to = nextSid++;
  inflight.add(to);
  try {
    const r = await call('replay', { ...req, from: fromId, to, comps: from.L.comps });
    sids.set(r.data, to);
    resident.add(to);
    return r;
  } finally {
    inflight.delete(to);
  }
}

/** 只留這些狀態在 Worker（原始一定留著）；復原用的舊步驟之後要用再補送。 */
export function retain(states: EditState[]) {
  const keep = new Set(states.map((s) => sidOf(s.vol.data)));
  for (const id of resident) if (!keep.has(id)) resident.delete(id);
  call('retain', { sids: [...keep, ...inflight] });
}
