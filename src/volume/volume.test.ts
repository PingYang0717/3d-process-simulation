import { describe, expect, it } from 'vitest';
import {
  MATERIALS,
  bboxDims,
  decodeNpy,
  demoVolume,
  diffMask,
  encodeNpy,
  initialLabeled,
  materialCounts,
} from './volume';
import { crc32, zipStore } from './zip';
import { type EditState, type Op, type OpContext, applyOp, matNameOf, replay, sweepOps } from './ops';

const UP: [number, number, number] = [0, -1, 0];
const DOWN: [number, number, number] = [0, 1, 0];

function setup() {
  const vol = demoVolume();
  const matName = matNameOf(MATERIALS);
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  let seq = 1000;
  const ctx: OpContext = { orig: vol, matName, newKey: () => `c${seq++}` };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  return { vol, base, ctx, poly, full: { axis: 'z' as const, lo: 0, hi: vol.Z - 1 } };
}

describe('逐體素', () => {
  it('沒操作：匯出與輸入逐體素相同', () => {
    const { vol } = setup();
    const back = decodeNpy(encodeNpy(vol).buffer as ArrayBuffer);
    expect([back.Z, back.Y, back.X]).toEqual([128, 96, 160]);
    expect(diffMask(back, vol).count).toBe(0);
  });

  it('npy header 長度對齊 64 bytes', () => {
    const { vol } = setup();
    const b = encodeNpy(vol);
    const hlen = b[8] | (b[9] << 8);
    expect((10 + hlen) % 64).toBe(0);
    expect(b.length).toBe(10 + hlen + vol.data.length);
  });

  it('poly 整塊往上 1 再往下 1：差異 0', () => {
    const { base, ctx, poly, full } = setup();
    const keys = poly.map((c) => c.key);
    const up: Op = { kind: 'translate', keys, scope: full, d: [0, -1, 0], backfill: 'orig' };
    const down: Op = { kind: 'translate', keys, scope: full, d: [0, 1, 0], backfill: 'orig' };
    const mid = applyOp(base, up, ctx);
    expect(diffMask(mid.vol, base.vol).count).toBeGreaterThan(0);
    // 選取以 key 延續
    expect(keys.every((k) => mid.L.comps.some((c) => c.key === k))).toBe(true);
    expect(diffMask(applyOp(mid, down, ctx).vol, base.vol).count).toBe(0);
  });

  it('poly 長高 2 再縮短 2（襯層跟著走）：差異 0；長高後 SiN 硬罩整層上移', () => {
    const { base, ctx, poly, full } = setup();
    const grow = (keys: string[]): Op => ({ kind: 'push', keys, scope: full, dir: UP, n: 2, follow: true, backfill: 'orig' });
    const shrink = (keys: string[]): Op => ({ kind: 'push', keys, scope: full, dir: UP, n: -2, follow: true, backfill: 'orig' });
    const one = [poly[0].key];
    const grown = applyOp(base, grow(one), ctx);
    expect(diffMask(grown.vol, base.vol).count).toBe(13824);
    // SiN 體積不變、整層往上 2
    const sin0 = base.L.comps.filter((c) => c.mat === 7);
    const sin1 = grown.L.comps.filter((c) => c.mat === 7);
    expect(sin1.map((c) => c.count)).toEqual(sin0.map((c) => c.count));
    const above = (c: { bbox: { z0: number } }) => c.bbox.z0 === poly[0].bbox.z0;
    expect(sin1.find(above)!.bbox.y0).toBe(sin0.find(above)!.bbox.y0 - 2);
    expect(diffMask(applyOp(grown, shrink(one), ctx).vol, base.vol).count).toBe(0);
    // 三根一起：三倍
    const all = poly.map((c) => c.key);
    const grown3 = applyOp(base, grow(all), ctx);
    expect(diffMask(grown3.vol, base.vol).count).toBe(13824 * 3);
    expect(diffMask(applyOp(grown3, shrink(all), ctx).vol, base.vol).count).toBe(0);
  });

  it('只改 z 60–67：只有那 8 片變', () => {
    const { base, ctx, poly } = setup();
    const target = poly.find((c) => c.bbox.z0 <= 60 && c.bbox.z1 >= 67)!;
    const op: Op = { kind: 'push', keys: [target.key], scope: { axis: 'z' as const, lo: 60, hi: 67 }, dir: UP, n: 2, follow: true, backfill: 'orig' };
    const out = applyOp(base, op, ctx);
    const { mask, count } = diffMask(out.vol, base.vol);
    expect(count).toBeGreaterThan(0);
    const plane = base.vol.X * base.vol.Y;
    const touched = new Set<number>();
    for (let i = 0; i < mask.length; i++) if (mask[i]) touched.add(Math.floor(i / plane));
    expect([...touched].sort((a, b) => a - b)).toEqual([60, 61, 62, 63, 64, 65, 66, 67]);
  });

  it('體積帳合計恆為 0', () => {
    const { base, ctx, poly, full } = setup();
    const keys = [poly[0].key];
    const ops: Op[] = [
      { kind: 'push', keys, scope: full, dir: UP, n: 3, follow: false, backfill: 'orig' },
      { kind: 'translate', keys, scope: full, d: [4, 0, 0], backfill: 'orig' },
      { kind: 'material', keys, scope: { axis: 'z' as const, lo: 20, hi: 25 }, m: 254 },
    ];
    const out = replay(base, ops, ctx);
    const before = materialCounts(base.vol);
    const after = materialCounts(out.vol);
    let sum = 0;
    new Set([...before.keys(), ...after.keys()]).forEach((m) => (sum += (after.get(m) ?? 0) - (before.get(m) ?? 0)));
    expect(sum).toBe(0);
    expect((after.get(6) ?? 0) - (before.get(6) ?? 0)).not.toBe(0);
  });

  it('掃描 +1／+2／+3 nm：高 H 42 → 44／46／48、頂部 Y 18 → 16／14／12', () => {
    const { base, ctx, poly, full } = setup();
    const keys = poly.map((c) => c.key);
    const nm = 0.5;
    const ops = sweepOps({ kind: 'push', dir: UP }, keys, full, [1, 2, 3].map((v) => Math.round(v / nm)), true, 'orig');
    const p0 = bboxDims(poly[0].bbox);
    expect([p0.h, p0.y]).toEqual([42, 18]);
    const res = ops.map((op) => {
      const out = replay(base, [op], ctx);
      const c = out.L.comps.find((x) => x.key === poly[0].key)!;
      const d = bboxDims(c.bbox);
      return [d.h, d.y];
    });
    expect(res).toEqual([
      [44, 16],
      [46, 14],
      [48, 12],
    ]);
  });

  it('Poly-Si 3 的 bamboo defect：推面只推外表面，空洞不被填、也不往外蝕', () => {
    const { base, ctx, poly, full } = setup();
    const p3 = poly.find((c) => c.bbox.z0 === 90)!;
    const voids0 = materialCounts(base.vol).get(254) ?? 0;
    expect(voids0).toBeGreaterThan(0);
    // 空洞只在 y 24–55，poly 3 上下仍連著，還是一塊
    expect(base.L.comps.filter((c) => c.mat === 6).length).toBe(3);
    const keys = [p3.key];
    for (const dir of [UP, DOWN, [0, 0, 1] as [number, number, number], [1, 0, 0] as [number, number, number]]) {
      const grow: Op = { kind: 'push', keys, scope: full, dir, n: 2, follow: true, backfill: 'orig' };
      const shrink: Op = { kind: 'push', keys, scope: full, dir, n: -2, follow: true, backfill: 'orig' };
      const g = applyOp(base, grow, ctx);
      expect(materialCounts(g.vol).get(254)).toBe(voids0);
      const sh = applyOp(base, shrink, ctx);
      expect(materialCounts(sh.vol).get(254)).toBe(voids0);
      expect(diffMask(applyOp(g, shrink, ctx).vol, base.vol).count).toBe(0);
    }
  }, 30_000);

  it('縮短的反方向：往下長再往下縮回到原點', () => {
    const { base, ctx, poly, full } = setup();
    const keys = [poly[1].key];
    const a: Op = { kind: 'push', keys, scope: full, dir: DOWN, n: 1, follow: true, backfill: 'orig' };
    const b: Op = { kind: 'push', keys, scope: full, dir: DOWN, n: -1, follow: true, backfill: 'orig' };
    expect(diffMask(replay(base, [a, b], ctx).vol, base.vol).count).toBe(0);
  });
});

describe('zip', () => {
  it('CRC32 標準值', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('store-only 結構：local header、central directory、end record', () => {
    const z = zipStore([
      { name: 'a.npy', data: new Uint8Array([1, 2, 3]) },
      { name: 'manifest.json', data: new TextEncoder().encode('{}') },
    ]);
    const dv = new DataView(z.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    const end = z.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(2);
    const cdOffset = dv.getUint32(end + 16, true);
    expect(dv.getUint32(cdOffset, true)).toBe(0x02014b50);
  });
});
