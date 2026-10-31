// Web Worker 入口：所有 O(N) 的運算都在這裡（本體在 workerCore.ts），主執行緒只畫畫面。
import { type Kind, handle } from './workerCore';

export type { ChunkItem, Kind, Only, Requests } from './workerCore';

self.onmessage = (e: MessageEvent<{ id: number; type: Kind; req: unknown }>) => {
  const { id, type, req } = e.data;
  try {
    const [result, transfer] = handle(type, req);
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
