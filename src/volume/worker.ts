// Web Worker 入口：所有 O(N) 的運算都在這裡（本體在 workerCore.ts），主執行緒只畫畫面。
import { type Kind, handleAny } from './workerCore';

export type { ChunkItem, Kind, Only, Requests } from './workerCore';

self.onmessage = (e: MessageEvent<{ id: number; type: Kind; req: unknown }>) => {
  const { id, type, req } = e.data;
  const fail = (err: unknown) => (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  try {
    const out = handleAny(type, req);
    if (out instanceof Promise) out.then(([result, transfer]) => (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer), fail);
    else (self as unknown as Worker).postMessage({ id, ok: true, result: out[0] }, out[1]);
  } catch (err) {
    fail(err);
  }
};
