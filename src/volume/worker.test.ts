import { beforeAll, describe, expect, it } from 'vitest';
import type { EditState } from './ops';

// 假 Worker：記下每種請求的次數，馬上回一個形狀對的結果（plan v7 §12 M1：版本號快取命中行為與改造前相同）
const sent: { type: string; req: Record<string, unknown> }[] = [];
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: { id: number; type: string; req: Record<string, unknown> }) {
    sent.push({ type: msg.type, req: msg.req });
    let result: unknown = null;
    if (msg.type === 'load') result = { labels: new Int32Array(8), raw: [] };
    if (msg.type === 'replay') result = { data: new Uint8Array(8), labels: new Int32Array(8), comps: [], keyCounter: 1 };
    queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok: true, result } } as MessageEvent));
  }
}

let client: typeof import('./client');
beforeAll(async () => {
  globalThis.__WORKER_SRC__ = '/* fake */';
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  client = await import('./client');
});

const count = (type: string) => sent.filter((m) => m.type === type).length;
const vol = () => ({ X: 2, Y: 2, Z: 2, data: new Uint8Array(8) });

describe('Worker 常駐狀態用版本號（§8.1）', () => {
  it('載入、重播拿新版本號；已常駐的不補送，retain 掉的才補送一次', async () => {
    const { loadOrig, replayIn, ensure, retain, sidOf } = client;
    const v0 = vol();
    const o = await loadOrig(v0);
    const orig: EditState = { vol: v0, L: { labels: o.labels, comps: [] }, version: o.version };
    expect(sidOf(orig)).toBe(o.version);
    ensure(orig);
    expect(count('put')).toBe(0);

    const r = await replayIn(orig, { ops: [], matNames: {}, keyCounter: 1 });
    expect(r.version).toBeGreaterThan(o.version);
    const next: EditState = { vol: { ...v0, data: r.data }, L: { labels: r.labels, comps: r.comps }, version: r.version };
    expect(ensure(next)).toBe(r.version);
    expect(count('put')).toBe(0);
    expect(sent.find((m) => m.type === 'replay')!.req.from).toBe(o.version);

    // 改名只換 comps、不換版本號：同一個狀態，不補送
    const renamed: EditState = { ...next, L: { ...next.L, comps: [] } };
    expect(ensure(renamed)).toBe(r.version);
    expect(count('put')).toBe(0);

    // retain 掉之後再用（例如復原回來）：補送一次，之後命中
    retain([orig]);
    expect(sent.at(-1)!.req.sids).toEqual([o.version]);
    ensure(next);
    ensure(next);
    expect(count('put')).toBe(1);
    expect(sent.find((m) => m.type === 'put')!.req.sid).toBe(r.version);
  });

  it('同一份陣列但不同版本號＝不同狀態（補丁式更新會原地改陣列，不能再用陣列身分）', async () => {
    const { ensure, newVersion } = client;
    const data = new Uint8Array(8);
    const a: EditState = { vol: { X: 2, Y: 2, Z: 2, data }, L: { labels: new Int32Array(8), comps: [] }, version: newVersion() };
    const b: EditState = { ...a, version: newVersion() };
    const before = count('put');
    expect(ensure(a)).not.toBe(ensure(b));
    expect(count('put')).toBe(before + 2);
  });

  it('沒帶版本號的狀態退回用陣列身分配號（同一份陣列同一個號碼）', () => {
    const { sidOf } = client;
    const v = vol();
    const s1: EditState = { vol: v, L: { labels: new Int32Array(8), comps: [] } };
    const s2: EditState = { vol: v, L: { labels: new Int32Array(8), comps: [] } };
    expect(sidOf(s1)).toBe(sidOf(s2));
    expect(sidOf({ vol: vol() })).not.toBe(sidOf(s1));
  });
});
