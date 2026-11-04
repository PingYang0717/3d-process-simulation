// Web Worker 入口：所有 O(N) 的運算都在這裡（本體在 workerCore.ts），主執行緒只畫畫面。
// plan v16：apply／chunks／layer 是 generator，每個 yield 回報一次進度、並讓出事件圈一次（setTimeout 0），
// 這時收到 { cancel: id } 就在安全點停掉（帳簿沒動）。其他請求照舊同步處理；請求之間仍然嚴格依序（排在 pendingMsgs）。
import { type GenKind, type Kind, type Progress, gens, handleAny, isGenKind } from './workerCore';

export type { ChunkItem, Kind, Only, Requests } from './workerCore';

type Msg = { id: number; type: Kind; req: unknown } | { cancel: number };
const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

const cancelled = new Set<number>();
/** 正在逐段跑的 generator 時，後到的請求先排著（保持依序）。 */
const pendingMsgs: { id: number; type: Kind; req: unknown }[] = [];
let busy = false;

function fail(id: number, err: unknown) {
  post({ id, ok: false, error: (err as Error)?.message ?? String(err) });
}

/** 逐段驅動 generator：每段之間 setTimeout 0 讓出，取消訊息才進得來。 */
function drive(id: number, type: GenKind, req: unknown) {
  busy = true;
  const g = (gens[type] as (r: unknown) => Generator<Progress, [unknown, Transferable[]], void>)(req);
  let safe = true;
  const finish = () => {
    cancelled.delete(id);
    busy = false;
    next();
  };
  const step = () => {
    try {
      if (safe && cancelled.has(id)) {
        g.return(undefined as never);
        fail(id, 'cancelled');
        finish();
        return;
      }
      const n = g.next();
      if (n.done) {
        post({ id, ok: true, result: n.value[0] }, n.value[1]);
        finish();
        return;
      }
      safe = n.value.cancellable;
      post({ id, progress: n.value });
      setTimeout(step, 0);
    } catch (err) {
      fail(id, err);
      finish();
    }
  };
  step();
}

function runOne(m: { id: number; type: Kind; req: unknown }) {
  const { id, type, req } = m;
  if (isGenKind(type)) {
    drive(id, type, req);
    return;
  }
  try {
    const out = handleAny(type, req);
    if (out instanceof Promise) out.then(([result, transfer]) => post({ id, ok: true, result }, transfer), (e) => fail(id, e));
    else post({ id, ok: true, result: out[0] }, out[1]);
  } catch (err) {
    fail(id, err);
  }
}

function next() {
  while (!busy && pendingMsgs.length) runOne(pendingMsgs.shift()!);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const d = e.data;
  if ('cancel' in d) {
    // 還沒開始的直接回「取消」；正在跑的在下一個安全點停
    const cid = d.cancel;
    const k = pendingMsgs.findIndex((m) => m.id === cid);
    if (k >= 0) {
      pendingMsgs.splice(k, 1);
      fail(cid, 'cancelled');
    } else cancelled.add(cid);
    return;
  }
  pendingMsgs.push(d);
  next();
};
