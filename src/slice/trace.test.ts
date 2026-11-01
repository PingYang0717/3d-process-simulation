import { describe, expect, it } from 'vitest';
import { ringPolygon, traceRings } from './trace';
import { deltaOf, editRing, rasterize } from './raster';
import { profileDelta } from './gestures';
import { encodeRle } from '../volume/rle';
import type { Ring, XY } from './trace';

/** 字元圖 → 格子（# = 結構）。 */
function grid(rows: string[]) {
  const H = rows.length;
  const W = rows[0].length;
  const m = new Uint8Array(W * H);
  rows.forEach((r, v) => [...r].forEach((c, u) => (m[v * W + u] = c === '#' ? 1 : 0)));
  return { W, H, m, inside: (u: number, v: number) => u >= 0 && v >= 0 && u < W && v < H && m[v * W + u] === 1 };
}
const roundtrip = (g: ReturnType<typeof grid>) => {
  const rings = traceRings(g.inside, 0, 0, g.W - 1, g.H - 1);
  return { rings, back: rasterize(rings.map(ringPolygon), 0, 0, g.W, g.H) };
};

describe('描輪廓（§10.1）', () => {
  it('方柱：一個外環、4 個角都是節點；重新光柵化逐格相同', () => {
    const g = grid(['......', '.####.', '.####.', '.####.', '......']);
    const { rings, back } = roundtrip(g);
    expect(rings.length).toBe(1);
    expect(rings[0].hole).toBe(false);
    expect(rings[0].pts.length).toBe(4);
    expect(rings[0].nodes.size).toBe(4);
    expect([...back]).toEqual([...g.m]);
  });

  it('圓頂（斜角）：簡化後頂點少於原始轉折點，節點在角上；重新光柵化逐格相同', () => {
    const g = grid([
      '..............',
      '.....####.....',
      '....######....',
      '...########...',
      '...########...',
      '...########...',
      '...########...',
      '...########...',
      '..............',
    ]);
    const { rings, back } = roundtrip(g);
    expect(rings.length).toBe(1);
    expect(rings[0].pts.length).toBeLessThan(16);
    expect(rings[0].nodes.size).toBeGreaterThanOrEqual(2);
    expect([...back]).toEqual([...g.m]);
  });

  it('有洞（VOID 缺陷）：外環＋內環，內環挖空', () => {
    const g = grid(['.......', '.#####.', '.#...#.', '.#...#.', '.#####.', '.......']);
    const { rings, back } = roundtrip(g);
    expect(rings.length).toBe(2);
    expect(rings.filter((r) => r.hole).length).toBe(1);
    expect([...back]).toEqual([...g.m]);
  });

  it('U 形是一個環；分開的兩塊是兩個環；斜對角相碰算兩塊', () => {
    const u = grid(['.......', '.#...#.', '.#...#.', '.#####.', '.......']);
    expect(roundtrip(u).rings.length).toBe(1);
    expect([...roundtrip(u).back]).toEqual([...u.m]);
    const two = grid(['.......', '.##.##.', '.##.##.', '.......']);
    expect(roundtrip(two).rings.length).toBe(2);
    const diag = grid(['....', '.#..', '..#.', '....']);
    const d = roundtrip(diag);
    expect(d.rings.length).toBe(2);
    expect([...d.back]).toEqual([...diag.m]);
  });
});

describe('光柵化與差（§10.2）', () => {
  const g = grid(['..........', '..........', '...####...', '...####...', '...####...', '...####...', '..........']);
  const ring = traceRings(g.inside, 0, 0, g.W - 1, g.H - 1)[0];
  const top = ring.pts.map((p, i) => [p, i] as const).filter(([p]) => p[1] === 2).map(([, i]) => i);

  it('整數平移：格子整塊搬、和搬格子相同', () => {
    const moved = rasterize([editRing(ring, ring.pts.map(() => [2, 1]))], 0, 0, g.W, g.H);
    const want = new Uint8Array(g.W * g.H);
    for (let v = 0; v < g.H; v++) for (let u = 0; u < g.W; u++) if (g.m[v * g.W + u] && v + 1 < g.H && u + 2 < g.W) want[(v + 1) * g.W + u + 2] = 1;
    expect([...moved]).toEqual([...want]);
  });

  it('頂邊往上推 2：多出兩排，方向碼都是往上（3）', () => {
    const disp = ring.pts.map((_, i) => (top.includes(i) ? ([0, -2] as [number, number]) : ([0, 0] as [number, number])));
    const after = rasterize([editRing(ring, disp)], 0, 0, g.W, g.H);
    const { add, remove } = deltaOf(g.m, after, 0, 0, g.W, g.H);
    expect(remove.length).toBe(0);
    expect(add.length).toBe(8);
    expect(add.every((c) => c.dir === 3 && c.v < 2)).toBe(true);
    // 由近到遠：先 v = 1 再 v = 0
    expect(add.slice(0, 4).every((c) => c.v === 1)).toBe(true);
  });

  it('節點拖動：只有動到的那兩段附近改變；拿掉的格子方向朝外', () => {
    const corner = ring.pts.findIndex((p) => p[0] === 7 && p[1] === 2);
    const disp = ring.pts.map((_, i) => (i === corner ? ([-2, 2] as [number, number]) : ([0, 0] as [number, number])));
    const after = rasterize([editRing(ring, disp)], 0, 0, g.W, g.H);
    const { add, remove } = deltaOf(g.m, after, 0, 0, g.W, g.H);
    expect(add.length).toBe(0);
    expect(remove.length).toBeGreaterThan(0);
    // 左下角那一格沒動
    expect(after[5 * g.W + 3]).toBe(1);
    expect(remove.every((c) => c.u >= 3)).toBe(true);
    expect(remove.every((c) => c.dir === 0 || c.dir === 3)).toBe(true);
  });
});

/** v14 的 profileDelta（外框＝所有環改前 ∪ 改後）：對照用。 */
function profileDeltaRef(rs: Ring[], ring: number, disp: XY[], inside: (u: number, v: number) => boolean) {
  const after = rs.map((r, i) => (i === ring ? editRing(r, disp) : ringPolygon(r)));
  let u0 = Infinity;
  let v0 = Infinity;
  let u1 = -Infinity;
  let v1 = -Infinity;
  for (const p of [...after, ...rs.map(ringPolygon)])
    for (const [u, v] of p) {
      u0 = Math.min(u0, Math.floor(u) - 1);
      v0 = Math.min(v0, Math.floor(v) - 1);
      u1 = Math.max(u1, Math.ceil(u) + 1);
      v1 = Math.max(v1, Math.ceil(v) + 1);
    }
  const W = u1 - u0 + 1;
  const H = v1 - v0 + 1;
  const before = new Uint8Array(W * H);
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) if (inside(u + u0, v + v0)) before[v * W + u] = 1;
  const { add, remove } = deltaOf(before, rasterize(after, u0, v0, W, H), u0, v0, W, H);
  if (!add.length && !remove.length) return null;
  return { add: encodeRle(add), remove: encodeRle(remove) };
}

describe('profileDelta 外框只看改的環（plan v15 B3）', () => {
  const cases = [
    // 有洞：外環＋內環
    grid(['..........', '.########.', '.#......#.', '.#..##..#.', '.#..##..#.', '.#......#.', '.########.', '..........']),
    // 兩塊分開的結構（同一個 key 兩個環）
    grid(['............', '.###....###.', '.###....###.', '.###....###.', '............']),
    // 三個環：大塊＋洞＋遠處的小塊
    grid(['...............', '.#######.......', '.#.....#.......', '.#.###.#.......', '.#.###.#....##.', '.#.....#....##.', '.#######.......', '...............']),
  ];
  it('每個環、每個頂點、幾種位移：和舊版（所有環的聯集外框）的 RLE 逐欄相同', () => {
    let n = 0;
    let nonNull = 0;
    for (const g of cases) {
      const rings = traceRings(g.inside, 0, 0, g.W - 1, g.H - 1);
      expect(rings.length).toBeGreaterThanOrEqual(2);
      rings.forEach((r, ri) => {
        for (let i = 0; i < r.pts.length; i++)
          for (const d of [
            [1, 0],
            [0, -1],
            [-1, 1],
            [2, 2],
            [0, 0],
          ] as XY[]) {
            const disp = r.pts.map((_, k) => (k === i ? d : ([0, 0] as XY)));
            const a = profileDelta(rings, ri, disp, g.inside);
            const b = profileDeltaRef(rings, ri, disp, g.inside);
            expect(a).toEqual(b);
            n++;
            if (a) nonNull++;
          }
        // 整個環平移（含洞縮小／放大）
        const all = r.pts.map(() => [1, -1] as XY);
        expect(profileDelta(rings, ri, all, g.inside)).toEqual(profileDeltaRef(rings, ri, all, g.inside));
      });
    }
    expect(n).toBeGreaterThan(50);
    expect(nonNull).toBeGreaterThan(20);
  });
});
