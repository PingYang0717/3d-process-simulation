// 主執行緒呼叫 Worker：call('mesh', {...}) → Promise。
import type { Kind, Requests } from './worker';

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

/** transfer 只放呼叫端之後不再用的陣列（會被搬走）。 */
export function call<K extends Kind>(type: K, req: Requests[K]['req'], transfer: Transferable[] = []): Promise<Requests[K]['res']> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    get().postMessage({ id, type, req }, transfer);
  });
}
