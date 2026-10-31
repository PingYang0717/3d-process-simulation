import { describe, expect, it } from 'vitest';
import { type Vec3, type Volume, AIR, MATERIALS, demoVolume, initialLabeled, levelMask } from './volume';
import { type EditState, type Op, applyOp, matNameOf } from './ops';
import { boxVoxels, cropVolume, previewBox, previewOp } from './preview';
import { type Ring, type XY, traceRings } from '../slice/trace';
import { type GestureCtx, type Handle, gestureToOp } from '../slice/gestures';

const matName = matNameOf(MATERIALS);

describe('即時預覽（裁切後在主執行緒算）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  let seq = 1000;
  const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
  const poly = base.L.comps.filter((c) => c.mat === 6);
  const fin = base.L.comps.find((c) => c.mat === 3)!;
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const cases: [string, Op][] = [
    ['筆刷推拉（圓 r3、襯層跟推）', { kind: 'push', keys: [poly[0].key], scope: full, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig', local: { center: [80, poly[0].bbox.y0, 26], radius: 3 } }],
    ['筆刷縮短（方 r4）', { kind: 'push', keys: [poly[2].key], scope: full, dir: [1, 0, 0], n: -3, follow: true, backfill: 'orig', local: { center: [151, 30, 100], radius: 4, shape: 'square' } }],
    ['整面長高 fin（襯層跟推、只改一段 z）', { kind: 'push', keys: [fin.key], scope: { axis: 'z' as const, lo: 20, hi: 60 }, dir: [0, -1, 0], n: 2, follow: true, backfill: 'orig' }],
    ['整面往前縮 poly', { kind: 'push', keys: [poly[1].key], scope: full, dir: [0, 0, -1], n: -2, follow: true, backfill: 'orig' }],
    ['方頭：整根 fin 補到頂（襯層跟推）', { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0, local: { center: [40, 30, 64], radius: null }, backfill: 'orig', follow: true }],
    ['筆刷補平（方 r6）', { kind: 'level', keys: [fin.key], scope: full, dir: [0, -1, 0], to: fin.bbox.y0 + 3, local: { center: [40, 30, 10], radius: 6, shape: 'square' }, backfill: 'orig' }],
    ['平移兩根 poly', { kind: 'translate', keys: [poly[1].key, poly[2].key], scope: full, d: [3, 0, -2], backfill: 'orig' }],
    ['換材質（一段 z）', { kind: 'material', keys: [fin.key], scope: { axis: 'z' as const, lo: 60, hi: 64 }, m: 5 }],
  ];
  for (const [name, op] of cases)
    it(`${name}：範圍內和正式結果逐體素相同，範圍外這一步沒改到`, () => {
      const box = previewBox(base, op)!;
      expect(box).toBeTruthy();
      const p = previewOp(base, vol, op)!;
      expect(p.data.length).toBe(boxVoxels(box));
      const real = applyOp(base, op, ctx).vol;
      expect(p.data).toEqual(cropVolume(real, box).data);
      // 範圍外一個都沒變（否則預覽會漏掉改動）
      let changedInside = 0;
      for (let i = 0; i < vol.data.length; i++) {
        if (real.data[i] === vol.data[i]) continue;
        const x = i % vol.X;
        const y = ((i - x) / vol.X) % vol.Y;
        const z = (i - x - y * vol.X) / (vol.X * vol.Y);
        const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
        if (!inside) expect([x, y, z]).toEqual('inside box');
        changedInside++;
      }
      expect(changedInside).toBeGreaterThan(0);
      // 裁切範圍遠小於整個陣列
      expect(boxVoxels(box)).toBeLessThan(vol.data.length / 4);
    });

  it('超過上限就不預覽', () => {
    expect(previewOp(base, vol, cases[0][1], 10)).toBeNull();
  });
});

describe('補平跟推襯層', () => {
  /** 一根 3 寬的柱子（mat 3）：中間列到 y 2、兩側列到 y 4（圓頭）；上面貼 2 層襯層（4）、再上面是厚的 6。 */
  const stack = (): Volume => {
    const X = 5;
    const Y = 12;
    const Z = 1;
    const data = new Uint8Array(X * Y * Z);
    const set = (x: number, y: number, m: number) => (data[y * X + x] = m);
    for (let y = 2; y < Y; y++) set(2, y, 3);
    for (const x of [1, 3]) for (let y = 4; y < Y; y++) set(x, y, 3);
    // 襯層緊貼每一列的頂，厚度 2；再上面全部是 6（厚）
    for (const [x, top] of [
      [1, 4],
      [2, 2],
      [3, 4],
    ] as [number, number][]) {
      set(x, top - 1, 4);
      set(x, top - 2, 4);
      for (let y = 0; y < top - 2; y++) set(x, y, 6);
    }
    return { X, Y, Z, data };
  };
  const col = (v: Volume, x: number) => Array.from({ length: v.Y }, (_, y) => v.data[y * v.X + x]);
  const mask = (v: Volume) => v.data.map((m) => (m === 3 ? 1 : 0));
  const up: Vec3 = [0, -1, 0];

  it('不跟推：碰到襯層就停（和以前一樣）', () => {
    const v = stack();
    const out = levelMask(v, v, mask(v), { axis: 'z', lo: 0, hi: 0 }, up, [2, 2, 0], Infinity, 'square', 2, 'orig');
    expect(out.data).toEqual(v.data);
  });

  it('跟推：襯層整列往上推、柱子補成方頭，厚的 6 被吃掉兩格', () => {
    const v = stack();
    const out = levelMask(v, v, mask(v), { axis: 'z', lo: 0, hi: 0 }, up, [2, 2, 0], Infinity, 'square', 2, 'orig', true);
    expect(col(out, 2)).toEqual(col(v, 2));
    // 兩側列：柱子補到 y 2，襯層仍然 2 厚、貼在上面（y 0～1），原本 y 0～1 的 6 被推出去
    for (const x of [1, 3]) expect(col(out, x)).toEqual([4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it('跟推削平：襯層跟著退回來、最外面回填 Air', () => {
    const v = stack();
    // 把中間列削到 y 4（和兩側一樣高）
    const out = levelMask(v, v, mask(v), { axis: 'z', lo: 0, hi: 0 }, up, [2, 4, 0], 0, 'square', 4, 'orig', true);
    expect(col(out, 2)).toEqual([AIR, AIR, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(col(out, 1)).toEqual(col(v, 1));
  });
});

describe('profile 的緊外框（plan v8 §7.7）', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName) };
  let seq = 2000;
  const ctx = { orig: vol, matName, newKey: () => `p${seq++}` };
  const full = { axis: 'z' as const, lo: 0, hi: vol.Z - 1 };
  const fins = base.L.comps.filter((c) => c.mat === 3);
  const poly = base.L.comps.find((c) => c.mat === 6)!;
  /** XY 第 z 片的環與手勢環境。 */
  const sliceOf = (key: string, z: number, follow: boolean, scope = full) => {
    const k = base.L.comps.findIndex((c) => c.key === key);
    const inside = (u: number, v: number) => u >= 0 && v >= 0 && u < vol.X && v < vol.Y && base.L.labels[(z * vol.Y + v) * vol.X + u] === k;
    const b = base.L.comps[k].bbox;
    const rings = new Map([[key, traceRings(inside, b.x0, b.y0, b.x1, b.y1)]]);
    let box: { u0: number; v0: number; u1: number; v1: number } | null = null;
    for (let v = b.y0; v <= b.y1; v++)
      for (let u = b.x0; u <= b.x1; u++)
        if (inside(u, v)) box = box ? { u0: Math.min(box.u0, u), v0: Math.min(box.v0, v), u1: Math.max(box.u1, u), v1: Math.max(box.v1, v) } : { u0: u, v0: v, u1: u, v1: v };
    const g: GestureCtx = { axis: 'z', at: z, scope, follow, backfill: 'orig', selKeys: [key], inside: (_k, u, v) => inside(u, v), sliceBox: () => box, nm: 0.5 };
    return { rings, g };
  };
  const corner = (rings: Map<string, Ring[]>, key: string, pick: (p: XY, q: XY) => boolean): Handle => {
    const r = rings.get(key)![0];
    let best = [...r.nodes][0];
    r.nodes.forEach((i) => {
      if (pick(r.pts[i], r.pts[best])) best = i;
    });
    return { kind: 'node', key, ring: 0, index: best };
  };
  const slanted = (rings: Map<string, Ring[]>, key: string): Handle => {
    const r = rings.get(key)![0];
    const i = r.pts.findIndex((p, k) => {
      const q = r.pts[(k + 1) % r.pts.length];
      return p[0] !== q[0] && p[1] !== q[1] && Math.hypot(q[0] - p[0], q[1] - p[1]) > 2;
    });
    return { kind: 'edge', key, ring: 0, index: Math.max(0, i) };
  };
  const cases: [string, () => Op | null][] = [
    ['fin 1 右上角往外 (+2, −2)、襯層跟推', () => {
      const { rings, g } = sliceOf(fins[0].key, 26, true);
      return gestureToOp(rings, corner(rings, fins[0].key, (p, q) => p[0] - p[1] > q[0] - q[1]), [2, -2], false, g);
    }],
    ['fin 1 右上角往外 (+2, −2)、防穿層（follow 關）', () => {
      const { rings, g } = sliceOf(fins[0].key, 26, false);
      return gestureToOp(rings, corner(rings, fins[0].key, (p, q) => p[0] - p[1] > q[0] - q[1]), [2, -2], false, g);
    }],
    ['fin 2 斜邊往外 3（只改一段 z）', () => {
      const { rings, g } = sliceOf(fins[1].key, 40, true, { axis: 'z', lo: 30, hi: 70 });
      return gestureToOp(rings, slanted(rings, fins[1].key), [2.2, -2.2], false, g);
    }],
    ['fin 3 左上角往內 (+2, +2)', () => {
      const { rings, g } = sliceOf(fins[2].key, 60, true);
      return gestureToOp(rings, corner(rings, fins[2].key, (p, q) => -p[0] - p[1] > -q[0] - q[1]), [2, 2], false, g);
    }],
    ['poly 左上角往外（沒有襯層的那一側）', () => {
      const z = (poly.bbox.z0 + poly.bbox.z1) >> 1;
      const { rings, g } = sliceOf(poly.key, z, true, { axis: 'z', lo: poly.bbox.z0, hi: poly.bbox.z1 });
      return gestureToOp(rings, corner(rings, poly.key, (p, q) => -p[0] - p[1] > -q[0] - q[1]), [-2, -2], false, g);
    }],
  ];
  for (const [name, make] of cases)
    it(`${name}：緊外框內與 applyOp 逐體素相同，外框外零改動`, () => {
      const op = make()!;
      expect(op?.kind).toBe('profile');
      const box = previewBox(base, op)!;
      const p = previewOp(base, vol, op)!;
      const real = applyOp(base, op, ctx).vol;
      expect(p.data).toEqual(cropVolume(real, box).data);
      let changed = 0;
      for (let i = 0; i < vol.data.length; i++) {
        if (real.data[i] === vol.data[i]) continue;
        const x = i % vol.X;
        const y = ((i - x) / vol.X) % vol.Y;
        const z = (i - x - y * vol.X) / (vol.X * vol.Y);
        const inside = x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
        if (!inside) expect([x, y, z]).toEqual('inside box');
        changed++;
      }
      expect(changed).toBeGreaterThan(0);
      // 拖拉中的即時預覽上限（LIVE_PREVIEW_CAP）
      expect(boxVoxels(box)).toBeLessThan(400_000);
    }, 30_000);

  it('×1 範例拖 fin 1 節點：外框從 45 萬格（v7）降到 20 萬格以下，進得了拖拉中的即時預覽', () => {
    // 相對式手勢每片要描整個剖面，所以切面上至少是結構外框（12×40）；省下的是四周固定的 17 格
    const op = cases[0][1]()!;
    expect(boxVoxels(previewBox(base, op)!)).toBeLessThan(200_000);
  });
});
