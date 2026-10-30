import { describe, expect, it } from 'vitest';
import { ringPolygon, traceRings } from './trace';
import { deltaOf, editRing, rasterize } from './raster';

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
