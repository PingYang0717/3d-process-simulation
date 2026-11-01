import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import type { Step } from './patch';

// 假 Worker：真的跑 workerCore（同一套 handler），請求與回應都經過 structuredClone（和 postMessage 一樣是複本）。
// 記下每種請求的次數（plan v9 §7：每一步只送 apply、沒有 diff／count；fork 只一次；head 對不上時 put）。
const sent: { type: string; req: Record<string, unknown> }[] = [];
let core: typeof import('./workerCore');
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: { id: number; type: string; req: Record<string, unknown> }) {
    sent.push({ type: msg.type, req: msg.req });
    const req = structuredClone(msg.req);
    queueMicrotask(() => {
      try {
        const [result] = core.handle(msg.type as never, req);
        this.onmessage?.({ data: { id: msg.id, ok: true, result: structuredClone(result) } } as MessageEvent);
      } catch (e) {
        this.onmessage?.({ data: { id: msg.id, ok: false, error: (e as Error).message } } as MessageEvent);
      }
    });
  }
}

let client: typeof import('./client');
beforeAll(async () => {
  globalThis.__WORKER_SRC__ = '/* fake */';
  (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  core = await import('./workerCore');
  client = await import('./client');
});
beforeEach(() => {
  sent.length = 0;
});

const count = (type: string) => sent.filter((m) => m.type === type).length;
const matName = matNameOf(MATERIALS);
const matNames = Object.fromEntries(MATERIALS.map((m) => [m.id, m.name]));
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.prototype.every.call(a, (v: number, i: number) => v === b[i]);

/** 主執行緒的一本帳簿（editor.ts 的簡化）：原地貼補丁。 */
async function setup() {
  const { loadOrig, forkIn } = client;
  const { applyStepInPlace } = await import('./patch');
  const vol = demoVolume();
  const o = await loadOrig(vol);
  const ref = initialLabeled(vol, matName);
  const orig: EditState = { vol, L: { labels: o.labels, comps: ref.comps }, version: o.version, owner: 'base' };
  const own = (owner: string, src: EditState, sid?: number): EditState => {
    void forkIn(owner, src, sid);
    return { vol: { ...vol, data: src.vol.data.slice() }, L: { labels: src.L.labels.slice(), comps: src.L.comps }, version: sid ?? src.version, owner };
  };
  const step = async (s: EditState, op: Op): Promise<{ next: EditState; step: Step }> => {
    const r = await client.applyIn(s, { op, matNames, keyCounter: 1000 });
    const comps = applyStepInPlace(s.vol, s.vol.data, s.L.labels, r.step, 'fwd') ?? s.L.comps;
    return { next: { ...s, L: { labels: s.L.labels, comps }, version: r.version }, step: r.step };
  };
  return { vol, orig, own, step };
}

describe('單本帳簿的 Worker 協定（plan v9 §4.2）', () => {
  it('own 只送一次 fork；每一步只送 apply（沒有 diff／count／put）；Worker 的帳簿和主執行緒逐位元組相同', async () => {
    const { orig, own, step } = await setup();
    let s = own('s1', orig);
    expect(count('fork')).toBe(1);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    sent.length = 0;
    for (let k = 0; k < 3; k++) s = (await step(s, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    expect(sent.map((m) => m.type)).toEqual(['apply', 'apply', 'apply']);
    const { books, heads } = core.inspect();
    expect(heads.get('s1')).toBe(s.version);
    expect(same(books.get('s1')!.data, s.vol.data)).toBe(true);
    expect(same(books.get('s1')!.labels, s.L.labels)).toBe(true);
    // 原始永遠不被寫
    expect(same(books.get('base')!.data, orig.vol.data)).toBe(true);
    // Worker 的 diff 是差量更新的，和全量相同
    const d = core.handle('diff', { sid: s.version! })[0] as { count: number };
    let n = 0;
    for (let i = 0; i < s.vol.data.length; i++) if (s.vol.data[i] !== orig.vol.data[i]) n++;
    expect(d.count).toBe(n);
    // 結果和純函式重播相同
    let seq = 1000;
    const pure = [0, 1, 2].reduce<EditState>((st) => applyOp(st, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' }, { orig: orig.vol, matName, newKey: () => `c${seq++}` }), { vol: orig.vol, L: orig.L });
    expect(same(pure.vol.data, s.vol.data)).toBe(true);
  });

  it('復原／重做只送 derive；Worker head 跟著前後移動', async () => {
    const { orig, own, step } = await setup();
    const { applyStepInPlace } = await import('./patch');
    let s = own('u1', orig);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    const v0 = s.version!;
    const r = await step(s, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' });
    s = r.next;
    sent.length = 0;
    await client.deriveIn(s, v0, r.step, 'back');
    applyStepInPlace(s.vol, s.vol.data, s.L.labels, r.step, 'back');
    expect(sent.map((m) => m.type)).toEqual(['derive']);
    const { books, heads } = core.inspect();
    expect(heads.get('u1')).toBe(v0);
    expect(same(books.get('u1')!.data, orig.vol.data)).toBe(true);
    expect(same(books.get('u1')!.labels, orig.L.labels)).toBe(true);
  });

  it('複製 split 之後各改各的：一本改了另一本不變', async () => {
    const { orig, own, step } = await setup();
    let a = own('a', orig);
    const poly = a.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: a.vol.Z - 1 };
    a = (await step(a, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    const snapshot = a.vol.data.slice();
    let b = own('b', a, client.newVersion());
    b = (await step(b, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' })).next;
    const { books } = core.inspect();
    expect(same(books.get('a')!.data, snapshot)).toBe(true);
    expect(same(a.vol.data, snapshot)).toBe(true);
    expect(same(books.get('b')!.data, b.vol.data)).toBe(true);
    expect(same(b.vol.data, snapshot)).toBe(false);
  });

  it('head 對不上（Worker 的帳簿掉了）時 put 一次再送；drop 名單正確；過期的版本回錯誤', async () => {
    const { orig, own, step } = await setup();
    let s = own('p1', orig);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    s = (await step(s, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    const old = s.version!;
    s = (await step(s, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    // 過期的版本：畫面拿舊的 sid 要網格 → 錯誤（主執行緒丟掉）
    expect(() => core.handle('count', { sid: old })).toThrow();
    // 模擬 Worker 帳簿遺失：主執行緒下一步 ensure 時補送
    client.dropOwners(['p1']);
    await Promise.resolve();
    sent.length = 0;
    s = (await step(s, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    expect(sent.map((m) => m.type)).toEqual(['put', 'apply']);
    expect(same(core.inspect().books.get('p1')!.data, s.vol.data)).toBe(true);
    sent.length = 0;
    client.dropOwners(['p1', 'zz']);
    expect(sent.at(-1)!.req.owners).toEqual(['p1', 'zz']);
  });

  it('重播：從原始複製出新帳簿、原地套 ops，回傳的 diff／體積帳和內容一致', async () => {
    const { orig } = await setup();
    const poly = orig.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: orig.vol.Z - 1 };
    const r = await client.replayIn('r1', orig, { ops: [{ kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' }], matNames, keyCounter: 1000 });
    let n = 0;
    for (let i = 0; i < r.data.length; i++) if (r.data[i] !== orig.vol.data[i]) n++;
    expect(r.diffCount).toBe(n);
    expect(n).toBeGreaterThan(0);
    expect(core.inspect().heads.get('r1')).toBe(r.version);
    expect(client.headsOf().get('r1')).toBe(r.version);
  });

  it('沒帶版本號的狀態退回用陣列身分配號（同一份陣列同一個號碼）', () => {
    const { sidOf } = client;
    const v = { X: 2, Y: 2, Z: 2, data: new Uint8Array(8) };
    const s1: EditState = { vol: v, L: { labels: new Int32Array(8), comps: [] } };
    const s2: EditState = { vol: v, L: { labels: new Int32Array(8), comps: [] } };
    expect(sidOf(s1)).toBe(sidOf(s2));
    expect(sidOf({ vol: { ...v, data: new Uint8Array(8) } })).not.toBe(sidOf(s1));
  });
});

describe('plan v15 M15.1：axes 外框、報告摘要、VOID 外框、preview 不送 comps', () => {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));
  const pv = { cap: Infinity, hidden: new Uint8Array(256), palette: new Float32Array(768).fill(0.5), showDiff: false, seq: 1, mesh: false };

  it('每個 handler 之後 diffBoxOfAxes === tightBox（apply／derive／fork／replay／put／restore）', async () => {
    const { diffBoxOfAxes, tightBox } = await import('./patch');
    const { applyStepInPlace } = await import('./patch');
    const { extractPatch } = await import('../splits/lifecycle');
    const { orig, own, step } = await setup();
    const checkAll = () => {
      for (const [o, b] of core.inspect().books) if (o !== 'base') expect(diffBoxOfAxes(b.axes)).toEqual(b.diffCount ? tightBox(orig.vol, b.diff!, b.touch) : null);
    };
    let s = own('ax', orig);
    await tick();
    checkAll();
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const fin = s.L.comps.find((c) => c.mat === 3)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    const steps: Step[] = [];
    for (const op of [
      { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' },
      { kind: 'translate', keys: [fin.key], scope: { axis: 'z', lo: 40, hi: 90 }, d: [2, 0, 0], backfill: 'orig', follow: true },
      { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: -2, follow: true, backfill: 'orig' },
    ] as Op[]) {
      const r = await step(s, op);
      s = r.next;
      steps.push(r.step);
      checkAll();
    }
    // 復原兩步、重做一步
    let cur = s;
    for (let k = steps.length - 1; k >= 1; k--) {
      const to = client.newVersion();
      await client.deriveIn(cur, to, steps[k], 'back');
      applyStepInPlace(cur.vol, cur.vol.data, cur.L.labels, steps[k], 'back');
      cur = { ...cur, version: to };
      checkAll();
    }
    // fork、replay
    void client.forkIn('ax2', cur, client.newVersion());
    await tick();
    checkAll();
    await client.replayIn('ax3', orig, { ops: [{ kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 3, follow: true, backfill: 'orig' }], matNames, keyCounter: 1000 });
    checkAll();
    // restore（parked → live）
    const b = core.inspect().books.get('ax3')!;
    const patch = extractPatch(orig.vol, b.data, b.labels, orig.vol.data, orig.L.labels, b.touch, core.inspect().compsOf.get('ax3')!);
    await client.restoreIn('ax4', client.newVersion(), patch);
    checkAll();
    // put（帳簿掉了之後補送）
    client.dropOwners(['ax']);
    await tick();
    cur = (await step(cur, { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 1, follow: true, backfill: 'orig' })).next;
    expect(sent.some((m) => m.type === 'put')).toBe(true);
    checkAll();
  }, 30_000);

  it('apply 回的 report 已摘要（C7）：cells 是 Int32Array、≤ BLOCKED_CAP；slices 的 blocked 總和 === total.blocked；applyParked 同', async () => {
    const { BLOCKED_CAP } = await import('./report');
    const { orig, own } = await setup();
    const s = own('rp', orig);
    const fin = s.L.comps.find((c) => c.mat === 3)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    const op: Op = { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: false };
    const r = await client.applyIn(s, { op, matNames, keyCounter: 1000 });
    const rep = r.report;
    expect(rep.total.blocked).toBeGreaterThan(0);
    expect(rep.cells).toBeInstanceOf(Int32Array);
    expect(rep.cells.length).toBe(Math.min(rep.total.blocked, BLOCKED_CAP));
    expect(rep.slices.reduce((n, x) => n + x.blocked, 0)).toBe(rep.total.blocked);
    expect(rep.axis).toBe('z');
    // 被擋的格子都在改前是 TiN／HfO₂（4、5）
    const bad = Array.from(rep.cells).filter((i) => orig.vol.data[i] !== 4 && orig.vol.data[i] !== 5).length;
    expect(bad).toBe(0);
    const pk = await client.applyParkedIn({ patch: { box: null, data: new Uint8Array(0), labels: new Int32Array(0), comps: orig.L.comps }, ops: [op], matNames, keyCounter: 2000 });
    expect(pk.reports[0].cells).toBeInstanceOf(Int32Array);
    expect(pk.reports[0].total.blocked).toBe(rep.total.blocked);
  }, 30_000);

  it('VOID 層（A5）：全量不呼叫 boxOf，chunk 集合 === 逐 chunk 暴力找 VOID；一步產生新的 VOID 之後一樣', async () => {
    const { chunkBox, chunkCount, gridOf } = await import('./chunks');
    const { VOID } = await import('./volume');
    const vol = demoVolume();
    core.handle('load', { sid: 300, vol: { ...vol, data: vol.data.slice() } });
    const brute = (data: Uint8Array) => {
      const g = gridOf(vol);
      const out: number[] = [];
      for (let k = 0; k < chunkCount(g); k++) {
        const b = chunkBox(vol, g, k);
        let any = false;
        for (let z = b.z0; z <= b.z1 && !any; z++) for (let y = b.y0; y <= b.y1 && !any; y++) for (let x = b.x0; x <= b.x1; x++) if (data[(z * vol.Y + y) * vol.X + x] === VOID) { any = true; break; }
        if (any) out.push(k);
      }
      return out;
    };
    const layerOf = (sid: number) => {
      const n = core.scanStats.boxOf;
      const [r] = core.handle('layer', { sid, key: 'void', filter: { mat: VOID }, tint: [0, 0, 0], inflate: 0.01 }) as [{ full: boolean; items: { k: number; m: { quads: number } }[] }, unknown];
      expect(core.scanStats.boxOf).toBe(n);
      expect(r.full).toBe(true);
      return r.items.filter((it) => it.m.quads > 0).map((it) => it.k).sort((a, b) => a - b);
    };
    expect(core.inspect().origVoidBox).not.toBeNull();
    expect(layerOf(300)).toEqual(brute(vol.data));
    // 一步把一根 poly 換成 VOID（新的 VOID 在 touch 裡）
    const L = initialLabeled(vol, matName);
    const poly = L.comps.filter((c) => c.mat === 6)[1];
    core.handle('fork', { owner: 'v', src: 'base', sid: 300 });
    const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
    core.handle('apply', { owner: 'v', from: 300, to: 301, comps: L.comps, op: { kind: 'material', keys: [poly.key], scope: full, m: VOID }, matNames, keyCounter: 1000 });
    const b = core.inspect().books.get('v')!;
    expect(layerOf(301)).toEqual(brute(b.data));
    // 其他材質仍走 boxOf（對照）
    const n = core.scanStats.boxOf;
    core.handle('layer', { sid: 301, key: 'm6', filter: { mat: 6 }, tint: [0, 0, 0] });
    expect(core.scanStats.boxOf).toBe(n + 1);
    // mesh 的 {mat: VOID} 路徑也不掃
    core.handle('mesh', { sid: 301, hidden: new Uint8Array(256), only: { mat: VOID }, palette: new Float32Array(768) });
    expect(core.scanStats.boxOf).toBe(n + 1);
  }, 30_000);

  it('previewIn 不送 comps（§10）：Worker 用自己存的 compsOf；結果和帶 comps 相同；原始經 compsIn、掉帳簿經 put 都有', async () => {
    const { previewOp } = await import('./preview');
    const { orig, own, step } = await setup();
    let s = own('pc', orig);
    const poly = s.L.comps.find((c) => c.mat === 6)!;
    const full = { axis: 'z' as const, lo: 0, hi: s.vol.Z - 1 };
    const push: Op = { kind: 'push', keys: [poly.key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' };
    s = (await step(s, push)).next;
    sent.length = 0;
    const a = (await client.previewIn(s, { op: push, ...pv })) as { box: unknown; data: Uint8Array };
    expect(sent.map((m) => m.type)).toEqual(['preview']);
    expect('comps' in sent[0].req).toBe(false);
    const [b] = core.handle('preview', { sid: s.version!, comps: s.L.comps, op: push, ...pv }) as [{ box: unknown; data: Uint8Array }, unknown];
    expect(a.box).toEqual(b.box);
    expect(same(a.data, b.data)).toBe(true);
    const p = previewOp(s, orig.vol, push)!;
    expect(same(a.data, p.data)).toBe(true);
    // 原始：主執行緒命名後 compsIn 一次
    await client.compsIn('base', orig.L.comps);
    const c = (await client.previewIn(orig, { op: push, ...pv })) as { data: Uint8Array };
    expect(same(c.data, previewOp(orig, orig.vol, push)!.data)).toBe(true);
    // 帳簿掉了：下一步 put 帶 comps，之後 preview 照常
    client.dropOwners(['pc']);
    await tick();
    s = (await step(s, push)).next;
    expect(sent.find((m) => m.type === 'put')!.req.comps).toBeTruthy();
    const d = (await client.previewIn(s, { op: push, ...pv })) as { data: Uint8Array };
    expect(same(d.data, previewOp(s, orig.vol, push)!.data)).toBe(true);
  }, 30_000);
});
