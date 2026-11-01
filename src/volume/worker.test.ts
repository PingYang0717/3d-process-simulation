import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MATERIALS, type Volume, decodeNpy, demoVolume, encodeNpy, initialLabeled } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import type { Step } from './patch';
import { type VtiInspect, decodeVti, encodeVtiLike, inspectVti } from './vti';
import { crc32 } from './zip';

// 假 Worker：真的跑 workerCore（同一套 handler），請求與回應都經過 structuredClone（和 postMessage 一樣是複本）。
// 記下每種請求的次數（plan v9 §7：每一步只送 apply、沒有 diff／count；fork 只一次；head 對不上時 put）。
const sent: { type: string; req: Record<string, unknown> }[] = [];
let core: typeof import('./workerCore');
class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(msg: { id: number; type: string; req: Record<string, unknown> }) {
    sent.push({ type: msg.type, req: msg.req });
    const req = structuredClone(msg.req);
    queueMicrotask(async () => {
      try {
        const out = core.handleAny(msg.type as never, req);
        const [result] = out instanceof Promise ? await out : out;
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

describe('plan v15 M15.5：解碼在 Worker、原檔只留 Worker 一份、匯出帶 crc 與 hint', () => {
  const FX = 8;
  const FY = 6;
  const FZ = 4;
  const FN = FX * FY * FZ;
  const enc = new TextEncoder();
  const u32 = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (out.set(p, o), (o += p.length));
    return out;
  };
  async function deflate(u: Uint8Array) {
    const cs = new CompressionStream('deflate');
    const w = cs.writable.getWriter();
    void w.write(u);
    void w.close();
    return new Uint8Array(await new Response(cs.readable).arrayBuffer());
  }
  /** 主材質：z < 2 是 1、其他 2，角落 x<2 y<2 z=0 的 4 格是 3（只在第一個 block 裡）。 */
  const mainOf = (i: number) => {
    const x = i % FX;
    const y = Math.floor(i / FX) % FY;
    const z = Math.floor(i / (FX * FY));
    return x < 2 && y < 2 && z === 0 ? 3 : z < 2 ? 1 : 2;
  };
  /** 3 個 Float32 比例陣列（appended raw、zlib、blockSize 256 → 每個陣列 3 塊）＋FieldData 材質表。 */
  async function fractionVti() {
    const blockSize = 256;
    const block = async (b: Uint8Array) => {
      const nb = Math.ceil(b.length / blockSize);
      const parts: Uint8Array[] = [];
      for (let k = 0; k < nb; k++) parts.push(await deflate(b.subarray(k * blockSize, Math.min(b.length, (k + 1) * blockSize))));
      return cat(u32(nb, blockSize, b.length % blockSize, ...parts.map((p) => p.length)), ...parts);
    };
    const app: Uint8Array[] = [];
    const tags: string[] = [];
    let off = 0;
    for (let k = 1; k <= 3; k++) {
      const v = new Float32Array(FN);
      for (let i = 0; i < FN; i++) v[i] = mainOf(i) === k ? 0.8 : 0.1;
      const raw = await block(new Uint8Array(v.buffer));
      tags.push(`<DataArray type="Float32" Name="material_${k}" format="appended" offset="${off}"/>`);
      app.push(raw);
      off += raw.length;
    }
    const names = Array.from(enc.encode('Si\0SiO2\0TiN\0')).join(' ');
    const ext = `0 ${FX - 1} 0 ${FY - 1} 0 ${FZ - 1}`;
    const head = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32" compressor="vtkZLibDataCompressor">
  <ImageData WholeExtent="${ext}" Origin="0 0 0" Spacing="0.5 0.5 0.5">
    <FieldData>
      <DataArray type="Int32" Name="MaterialCode" NumberOfTuples="3" format="ascii">1 2 3</DataArray>
      <DataArray type="String" Name="MaterialName" NumberOfTuples="3" format="ascii">${names}</DataArray>
    </FieldData>
    <Piece Extent="${ext}">
      <PointData Scalars="material_1">
        ${tags.join('\n        ')}
      </PointData>
    </Piece>
  </ImageData>
  <AppendedData encoding="raw">
   _`;
    return cat(enc.encode(head), ...app, enc.encode('\n  </AppendedData>\n</VTKFile>\n'));
  }
  const MATS = [
    { id: 1, name: 'Si', color: '#c8c8be' },
    { id: 2, name: 'SiO2', color: '#96d2e6' },
    { id: 3, name: 'TiN', color: '#8c96aa' },
    { id: 9, name: '新材質', color: '#ff0000' },
  ];
  const bytesSame = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
  type Dec = { vol: Volume; info: { fractions?: { name: string; id: number; dtype: string }[] } };
  const inspectIn = (buf: ArrayBuffer) => core.handleAny('vtiInspect', { buf }) as Promise<[VtiInspect, Transferable[]]>;
  const decodeIn = (req: { keepRaw: boolean; fractions?: { name: string; id: number }[] }) => core.handleAny('vtiDecode', req) as Promise<[Dec & { valueMap: Map<number, number> }, Transferable[]]>;
  type Exp = { bytes: Uint8Array; crc: number; stats?: { blocks: number; redone: number } };
  const exportIn = (req: Record<string, unknown>) => core.handleAny('export', req) as Promise<[Exp, Transferable[]]>;

  it('vtiInspect／vtiDecode 經 handleAny === 直接呼叫 inspectVti／decodeVti；keepRaw 之後原檔就是匯出用的那份；vtiDrop 釋放', async () => {
    const file = await fractionVti();
    const raw = file.slice().buffer;
    const [ins] = await inspectIn(raw);
    expect(ins).toEqual(await inspectVti(file.slice().buffer));
    expect(ins.fractions.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(core.inspect().pendingRaw).toBe(raw);
    const [dec, transfer] = await decodeIn({ keepRaw: true });
    const ref = await decodeVti(file.slice().buffer);
    expect(Array.from(dec.vol.data)).toEqual(Array.from(ref.vol.data));
    expect(Array.from(dec.vol.data)).toEqual(Array.from({ length: FN }, (_, i) => mainOf(i)));
    expect(dec.info).toEqual(ref.info);
    expect([...dec.valueMap]).toEqual([...ref.valueMap]);
    expect(transfer).toEqual([dec.vol.data.buffer]);
    // 原檔沒複製：pendingRaw 直接變成 exportRaw
    expect(core.inspect().pendingRaw).toBeNull();
    expect(core.inspect().exportRaw).toBe(raw);
    expect(core.inspect().exportFractions).toEqual(ref.info.fractions);
    // 沒有待解碼的檔 → 錯誤
    await expect(decodeIn({ keepRaw: true })).rejects.toThrow();
    // 手動指定比例陣列 === decodeVti(buf, { fractions })
    const manual = [
      { name: 'material_1', id: 5 },
      { name: 'material_3', id: 7 },
    ];
    await inspectIn(file.slice().buffer);
    const [dm] = await decodeIn({ keepRaw: true, fractions: manual });
    const rm = await decodeVti(file.slice().buffer, { fractions: manual });
    expect(Array.from(dm.vol.data)).toEqual(Array.from(rm.vol.data));
    expect(dm.info.fractions).toEqual(rm.info.fractions);
    expect(core.inspect().exportFractions).toEqual(rm.info.fractions);
    // keepRaw: false → 解完就丟（exportRaw 不動）
    const before = core.inspect().exportRaw;
    await inspectIn(file.slice().buffer);
    await decodeIn({ keepRaw: false });
    expect(core.inspect().exportRaw).toBe(before);
    // 取消：vtiDrop 釋放 pendingRaw
    const r2 = file.slice().buffer;
    await inspectIn(r2);
    expect(core.inspect().pendingRaw).toBe(r2);
    core.handle('vtiDrop', {});
    expect(core.inspect().pendingRaw).toBeNull();
    // exportMeta 只送 fractions：原檔留著；送 null：原檔一起放掉
    core.handle('exportMeta', { fractions: ref.info.fractions! });
    expect(core.inspect().exportRaw).toBe(before);
    core.handle('exportMeta', { fractions: null });
    expect(core.inspect().exportRaw).toBeNull();
    expect(core.inspect().exportFractions).toBeNull();
    // 壞檔：pendingRaw 不留
    await expect(inspectIn(enc.encode('<nope/>').slice().buffer)).rejects.toThrow();
    expect(core.inspect().pendingRaw).toBeNull();
  });

  it('npyDecode 經 handleAny === decodeNpy，vol.data transfer', () => {
    const vol = demoVolume();
    const buf = encodeNpy(vol).slice().buffer;
    const [r, transfer] = core.handleAny('npyDecode', { buf: buf.slice(0) }) as [{ vol: Volume }, Transferable[]];
    const ref = decodeNpy(buf);
    expect([r.vol.X, r.vol.Y, r.vol.Z]).toEqual([ref.X, ref.Y, ref.Z]);
    expect(same(r.vol.data, ref.data)).toBe(true);
    expect(transfer).toEqual([r.vol.data.buffer]);
  });

  it('export：crc === crc32(bytes)；同格式 parked ≡ live ≡ 純函式整陣列路徑、原始 === 原檔；只重壓碰到的 block', async () => {
    const { extractPatch } = await import('../splits/lifecycle');
    const file = await fractionVti();
    await inspectIn(file.slice().buffer);
    const [dec] = await decodeIn({ keepRaw: true });
    const vol = dec.vol;
    const [ld] = core.handle('load', { sid: 500, vol }) as [{ labels: Int32Array }, unknown];
    core.handle('exportMeta', { fractions: dec.info.fractions! });
    const L = initialLabeled(vol, (id) => `材質 ${id}`);
    const req = { format: 'vti', spacing: [0.5, 0.5, 0.5], origin: [0, 0, 0], arrayName: 'material', materials: MATS };
    // 原始：逐位元組 === 原檔，沒有 block 重壓
    const [o, tr] = await exportIn(req);
    expect(bytesSame(o.bytes, file)).toBe(true);
    expect(o.crc).toBe(crc32(file));
    expect(o.stats).toEqual({ blocks: 0, redone: 0 }); // 沒改點：純函式直接回原檔，沒碰任何 block
    expect(tr).toEqual([o.bytes.buffer]);
    // live：角落的 TiN（4 格、只在第一個 block）換成新材質 9
    const tin = L.comps.find((c) => c.mat === 3)!;
    core.handle('fork', { owner: 'e', src: 'base', sid: 500 });
    const full = { axis: 'z' as const, lo: 0, hi: FZ - 1 };
    core.handle('apply', { owner: 'e', from: 500, to: 501, comps: L.comps, op: { kind: 'material', keys: [tin.key], scope: full, m: 9 }, matNames: {}, keyCounter: 1000 });
    const b = core.inspect().books.get('e')!;
    expect(b.diffCount).toBe(4);
    const [live] = await exportIn({ ...req, owner: 'e' });
    const ref = live.bytes;
    expect(live.crc).toBe(crc32(ref));
    // 和純函式帶 hint（diff＋外框）的結果逐位元組相同；整陣列路徑重壓每一塊（壓縮位元組可能不同），比解回來的值
    const diff = new Uint8Array(FN);
    for (let i = 0; i < FN; i++) diff[i] = b.data[i] !== vol.data[i] ? 1 : 0;
    const box = { x0: 0, x1: 1, y0: 0, y1: 1, z0: 0, z1: 0 };
    expect(bytesSame(ref, await encodeVtiLike(file, dec.info.fractions!, b.data, vol.data, MATS, { diff, box, dims: { X: FX, Y: FY, Z: FZ } }))).toBe(true);
    const whole = await encodeVtiLike(file, dec.info.fractions!, b.data, vol.data, MATS, undefined, { whole: true });
    expect(Array.from((await decodeVti(whole.slice().buffer)).vol.data)).toEqual(Array.from(b.data));
    // 3 個原陣列各 3 塊，只有第一塊重壓；新材質的陣列另算
    expect(live.stats!.redone).toBeLessThan(live.stats!.blocks);
    expect(live.stats!.blocks).toBeGreaterThanOrEqual(9);
    // 解回來的值：角落是 9、其他照舊
    const back = await decodeVti(ref.slice().buffer);
    expect(Array.from(back.vol.data)).toEqual(Array.from(b.data));
    // parked（補丁）：和 live 逐位元組相同；連做兩次（exportBuf 重複使用）仍相同；原始再匯一次不受影響
    const patch = extractPatch(vol, b.data, b.labels, vol.data, ld.labels, b.touch, core.inspect().compsOf.get('e')!);
    const [p1] = await exportIn({ ...req, patch });
    expect(bytesSame(p1.bytes, ref)).toBe(true);
    expect(p1.crc).toBe(crc32(ref));
    const [p2] = await exportIn({ ...req, patch });
    expect(bytesSame(p2.bytes, ref)).toBe(true);
    const [o2] = await exportIn(req);
    expect(bytesSame(o2.bytes, file)).toBe(true);
    // 兩個 parked 匯出重疊（exportBuf busy → 退回複製）也對
    const [q1, q2] = await Promise.all([exportIn({ ...req, patch }), exportIn({ ...req, patch: { box: null, data: new Uint8Array(0), labels: new Int32Array(0), comps: [] } })]);
    expect(bytesSame(q1[0].bytes, ref)).toBe(true);
    expect(bytesSame(q2[0].bytes, file)).toBe(true);
    // vti1／npy 的 crc
    const [v1] = await exportIn({ ...req, format: 'vti1', owner: 'e' });
    expect(v1.crc).toBe(crc32(v1.bytes));
    expect(v1.stats).toBeUndefined();
    const [np] = await exportIn({ ...req, format: 'npy', patch });
    expect(np.crc).toBe(crc32(np.bytes));
    expect(same(decodeNpy(np.bytes.slice().buffer).data, b.data)).toBe(true);
  }, 30_000);

  it('client：inspectVtiIn 帶 transfer list、decodeVtiIn → exportMetaIn(fractions) → exportIn 回位元組附 crc', async () => {
    const file = await fractionVti();
    const buf = file.slice().buffer;
    sent.length = 0;
    const ins = await client.inspectVtiIn(buf);
    expect(ins.fractions.length).toBe(3);
    const { vol, info } = await client.decodeVtiIn({ keepRaw: true });
    expect(Array.from(vol.data)).toEqual(Array.from({ length: FN }, (_, i) => mainOf(i)));
    const o = await client.loadOrig(vol);
    await client.exportMetaIn(info.fractions!);
    expect(sent.find((m) => m.type === 'exportMeta')!.req).toEqual({ fractions: info.fractions });
    const orig: EditState = { vol, L: { labels: o.labels, comps: [] }, version: o.version, owner: 'base' };
    const bytes = await client.exportIn({ state: orig }, { format: 'vti', spacing: [1, 1, 1], origin: [0, 0, 0], arrayName: 'material', materials: MATS });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytesSame(bytes, file)).toBe(true);
    expect(bytes.crc).toBe(crc32(file));
    expect(bytes.stats).toEqual({ blocks: 0, redone: 0 });
    const { vol: nv } = await client.decodeNpyIn(encodeNpy(vol).slice().buffer);
    expect(same(nv.data, vol.data)).toBe(true);
    await client.dropVtiIn();
  });
});
