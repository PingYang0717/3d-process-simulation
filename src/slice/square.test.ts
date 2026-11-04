// 2D 拖拉方頭（抱怨「2D 拖拉很難拖成想要的形狀（例如方頭）」）：Shift 鎖軸、所見即所得的階梯 ghost、按兩下斜角＝方角。
import { describe, expect, it } from 'vitest';
import { MATERIALS, demoVolume, initialLabeled } from '../volume/volume';
import { type EditState, type Op, matNameOf } from '../volume/ops';
import { decodeRle } from '../volume/rle';
import { applyOpLocal } from '../volume/apply';
import { sliceContext, squareGesture, commitSquare } from '../pages/Section3D/handleOps';
import { type Handle, chamferSpan, lockAxis, squareCornerOp, squaredPolygon } from './gestures';
import { chamferAt, isAxisCorner } from './snap';
import { editRing, rasterOutline, rasterize } from './raster';
import { type Ring, type XY, ringPolygon, traceRings } from './trace';
import { ModelStore, buildSliceModel, ringsOf, squareCorner, verifyKey } from './model';

const matName = matNameOf(MATERIALS);
const opts = (lo: number, hi: number) => ({ scope: { axis: 'z' as const, lo, hi }, follow: true, backfill: 'orig' as const, nm: 0.5 });

describe('Shift 鎖軸', () => {
  it('只留主要那一軸；相等留 u', () => {
    expect(lockAxis([2.4, -0.7])).toEqual([2.4, 0]);
    expect(lockAxis([0.3, -3])).toEqual([0, -3]);
    expect(lockAxis([1, 1])).toEqual([1, 0]);
    expect(lockAxis([0, 0])).toEqual([0, 0]);
  });
});

describe('所見即所得的 ghost（rasterOutline）', () => {
  it('矩形的邊界就是矩形；斜的多邊形的邊界全是軸向的段、再光柵化逐格相同', () => {
    const rect: XY[] = [[2, 3], [12, 3], [12, 9], [2, 9]];
    const [loop] = rasterOutline([rect]);
    expect(loop.map((p) => p.join(',')).sort()).toEqual(['12,3', '12,9', '2,3', '2,9']);
    // 像拖拉中：頂角斜切的環往上推 1.4（內插後是浮點折線）
    const g = (u: number, v: number) => u >= 4 && u <= 15 && v >= 2 && v <= 20 && Math.min(u - 4, 15 - u) + v >= 4;
    const [r] = traceRings(g, 0, 0, 30, 30);
    const edited = editRing(r, r.pts.map((p) => (p[1] <= 4 ? [0, -1.4] : [0, 0]) as XY));
    const loops = rasterOutline([edited]);
    expect(loops.length).toBe(1);
    loops[0].forEach((p, i) => {
      const q = loops[0][(i + 1) % loops[0].length];
      expect(p[0] === q[0] || p[1] === q[1]).toBe(true);
      expect(Number.isInteger(p[0]) && Number.isInteger(p[1])).toBe(true);
    });
    expect(rasterize(loops, 0, 0, 30, 30)).toEqual(rasterize([edited], 0, 0, 30, 30));
  });
});

describe('按兩下斜角＝方角', () => {
  const vol = demoVolume();
  const base: EditState = { vol, L: initialLabeled(vol, matName), version: 1 };
  let seq = 7000;
  const ctx = { orig: vol, matName, newKey: () => `m${seq++}` };
  const fin = base.L.comps.filter((c) => c.mat === 3)[0];
  const k = [fin.key];
  const nodeAt = (rings: Map<string, Ring[]>, p: XY): Handle => {
    const r = rings.get(fin.key)![0];
    const i = [...r.nodes].find((j) => r.pts[j][0] === p[0] && r.pts[j][1] === p[1]);
    expect(i).toBeDefined();
    return { kind: 'node', key: fin.key, ring: 0, index: i! };
  };
  const finAt = (s: EditState, x: number, y: number, z: number) => s.vol.data[(z * vol.Y + y) * vol.X + x] === 3;

  it('squaredPolygon：斜角換成兩條直邊，面積多出斜角那個三角（2 格切角＝3 格）', () => {
    const c = sliceContext(base.L, vol, 'z', 45, k, opts(40, 50));
    const r = c.rings.get(fin.key)![0];
    const h = nodeAt(c.rings, [36, 30]);
    const ch = chamferAt(r, h.index)!;
    expect(ch.corner).toEqual([34, 30]);
    const poly = squaredPolygon(r, ch);
    expect(poly.some((p) => p[0] === 34 && p[1] === 30)).toBe(true);
    const before = rasterize([ringPolygon(r)], 30, 28, 20, 45).reduce((n, x) => n + x, 0);
    const after = rasterize([poly], 30, 28, 20, 45).reduce((n, x) => n + x, 0);
    expect(after - before).toBe(3);
    // 斜角的另一端給同一個角、同一條路徑
    const h2 = nodeAt(c.rings, [34, 32]);
    expect(chamferSpan(chamferAt(r, h2.index)!)).toEqual(chamferSpan(ch));
  });

  it('Op：profile、只加 3 格；套用後那一段 z 的左上角是矩形角，別的片沒動；矩形角不產生 Op', () => {
    const c = sliceContext(base.L, vol, 'z', 45, k, opts(40, 50));
    const res = squareCornerOp(c.rings, nodeAt(c.rings, [36, 30]), c.g)!;
    expect(res.op.kind).toBe('profile');
    const pk = res.op.kind === 'profile' ? res.op.perKey[fin.key] : null;
    expect(pk && decodeRle(pk.remove).length).toBe(0);
    expect(pk && decodeRle(pk.add).map((c) => `${c.u},${c.v}`).sort()).toEqual(['34,30', '34,31', '35,30']);
    const s = applyOpLocal(base, res.op, ctx).state;
    for (const z of [40, 45, 50]) {
      expect(finAt(s, 34, 30, z)).toBe(true);
      expect(finAt(s, 35, 30, z)).toBe(true);
      expect(finAt(s, 34, 31, z)).toBe(true);
      // 右上角沒動
      expect(finAt(s, 45, 30, z)).toBe(false);
    }
    expect(finAt(s, 34, 30, 39)).toBe(false);
    expect(finAt(s, 34, 30, 51)).toBe(false);
    // 矩形角（左下）不是斜角
    expect(squareCornerOp(c.rings, nodeAt(c.rings, [34, 70]), c.g)).toBeNull();
  });

  it('幾何層：commitSquare 之後角是矩形角節點、斜角兩端的頂點拿掉、幾何 === 套用後的 voxel（驗證通過）', () => {
    const models = new ModelStore();
    const committed: Op[] = [];
    const ed = { L: base.L, vol, models, version: 1, stepSeq: 0, commit: (op: Op) => committed.push(op) };
    const { model } = models.get(base.L, vol, 'z', 45, k, 1, 0);
    const c = { ...sliceContext(base.L, vol, 'z', 45, k, opts(40, 50), ringsOf(model, k)), model };
    const h = nodeAt(c.rings, [36, 30]);
    const res = squareGesture(c, h)!;
    expect(res.op.kind).toBe('profile');
    commitSquare(ed, c, h, res.chamfer, res.op);
    expect(committed.length).toBe(1);
    const r = ringsOf(model, k).get(fin.key)![0];
    const pts = r.pts.map((p) => p.join(','));
    expect(pts).toContain('34,30');
    expect(pts).not.toContain('36,30');
    expect(pts).not.toContain('34,32');
    const ci = r.pts.findIndex((p) => p[0] === 34 && p[1] === 30);
    expect(r.nodes.has(ci)).toBe(true);
    expect(isAxisCorner(r, ci)).toBe(true);
    // 右上角還是斜角
    expect(chamferAt(r, r.pts.findIndex((p) => p[0] === 44 && p[1] === 30))?.corner).toEqual([46, 30]);
    const s = applyOpLocal(base, committed[0], ctx).state;
    expect(verifyKey(model, s.L, s.vol, fin.key)).toEqual([]);
  });

  it('squareCorner 直接呼叫：環仍封閉、沒有多餘的頂點', () => {
    const m = buildSliceModel(base.L, vol, 'z', 45, k, 1);
    const r0 = ringsOf(m, k).get(fin.key)![0];
    const i = r0.pts.findIndex((p) => p[0] === 44 && p[1] === 30);
    const ch = chamferAt(r0, i)!;
    const { a, b } = chamferSpan(ch);
    const id = squareCorner(m, fin.key, 0, a, b, ch.corner)!;
    expect(m.vertices[id]).toMatchObject({ u: 46, v: 30 });
    const r1 = ringsOf(m, k).get(fin.key)![0];
    expect(r1.pts.length).toBe(r0.pts.length - 1);
    r1.raw.forEach((seg, j) => {
      expect(seg[0]).toEqual(r1.pts[j]);
      expect(seg[seg.length - 1]).toEqual(r1.pts[(j + 1) % r1.pts.length]);
    });
  });
});
