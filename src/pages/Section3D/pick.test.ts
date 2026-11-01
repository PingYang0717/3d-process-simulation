// plan v15 §7：pickOrdered(firstOnly) 回的命中 === intersectObjects 的最近命中；不 firstOnly 時集合相同且由近到遠。
// 三種 chunk 配置（分開的格子、外接球大量重疊、射線從外接球裡面出發）× 三種 BVH 狀態（都沒建、都建了、一半建了），
// 每組 200 條固定種子的隨機射線。另外測每事件的 BVH 預算與單一 idle 排程。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, DoubleSide, FrontSide, Group, Mesh, MeshBasicMaterial, Raycaster, Vector3, type Intersection, type Side } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { beginPickEvent, bvhBudget, bvhStats, idleBVHState, lazyRaycast, pickAlong, pickOrdered, scheduleIdleBVH, sphereEntry } from './pick';

/** 固定種子的亂數（mulberry32）：失敗時可以重現。 */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number, side: Side) => {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(cx, cy, cz);
  g.computeBoundingSphere();
  const m = new Mesh(g, new MeshBasicMaterial({ side }));
  m.raycast = lazyRaycast;
  return m;
};
/** 像 partGroup 一樣翻 y（矩陣不是單位矩陣，外接球與命中都要經過 matrixWorld）。 */
const scene = (meshes: Mesh[], Y = 100) => {
  const g = new Group();
  g.scale.set(1, -1, 1);
  g.position.y = Y;
  for (const m of meshes) g.add(m);
  g.updateMatrixWorld(true);
  return meshes;
};

/** A：3×3×3 分開的格子（外接球只和鄰居稍微重疊，很多射線會打空）。 */
const gridConfig = (side: Side) => {
  const out: Mesh[] = [];
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) out.push(box(20 + x * 14, 20 + y * 14, 20 + z * 14, 10, 10, 10, side));
  return scene(out);
};
/** B：像 64³ chunk 那樣 2×2×2 幾乎貼著的大塊（外接球彼此全部重疊）＋穿過中間的長條（球包住所有東西）。 */
const overlapConfig = (side: Side) => {
  const out: Mesh[] = [];
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) out.push(box(15.25 + x * 30.5, 15.25 + y * 30.5, 15.25 + z * 30.5, 30, 30, 30, side));
  out.push(box(30.5, 30.5, 30.5, 90, 3, 3, side));
  out.push(box(30.5, 30.5, 30.5, 3, 90, 3, side));
  out.push(box(30.5, 30.5, 30.5, 3, 3, 90, side));
  return scene(out);
};
/** C：一個 80³ 的大盒子裡面放幾個小方塊，射線從大盒子的外接球裡面出發。 */
const insideConfig = (side: Side) => {
  const out: Mesh[] = [box(40, 40, 40, 80, 80, 80, side)];
  const r = rng(7);
  for (let k = 0; k < 10; k++) out.push(box(10 + r() * 60, 10 + r() * 60, 10 + r() * 60, 4 + r() * 8, 4 + r() * 8, 4 + r() * 8, side));
  return scene(out);
};

type Ray = { o: Vector3; d: Vector3 };
/** 射線：從遠處對著模型中央附近射（大多會打到）、完全隨機的方向（會打空），inside 時從大盒子裡面出發。 */
const rays = (n: number, seed: number, inside: boolean): Ray[] => {
  const r = rng(seed);
  const out: Ray[] = [];
  for (let k = 0; k < n; k++) {
    const o = inside
      ? new Vector3(12 + r() * 56, 100 - (12 + r() * 56), 12 + r() * 56)
      : new Vector3(r() - 0.5, r() - 0.5, r() - 0.5)
          .normalize()
          .multiplyScalar(150 + r() * 100)
          .add(new Vector3(35, 100 - 35, 35));
    const aim = k % 7 === 6 ? new Vector3(r() - 0.5, r() - 0.5, r() - 0.5) : new Vector3(r() * 70, 100 - r() * 70, r() * 70).sub(o);
    out.push({ o, d: aim.normalize() });
  }
  return out;
};

const same = (a: Intersection, b: Intersection) => {
  expect(a.object).toBe(b.object);
  expect(a.faceIndex).toBe(b.faceIndex);
  expect(a.distance).toBeCloseTo(b.distance, 9);
};
const castRef = (meshes: Mesh[], ray: Ray) => {
  const rc = new Raycaster();
  rc.set(ray.o, ray.d);
  rc.firstHitOnly = false;
  return rc.intersectObjects(meshes, false);
};
const castMine = (meshes: Mesh[], ray: Ray, firstOnly: boolean) => {
  const rc = new Raycaster();
  rc.set(ray.o, ray.d);
  return pickOrdered(rc, meshes, firstOnly);
};
/** BVH 狀態：none＝都沒建（預算關掉）、all＝都建了、half＝偶數個建了。 */
type Trees = 'none' | 'all' | 'half';
const prepare = (meshes: Mesh[], trees: Trees) => {
  bvhBudget.until = 0;
  meshes.forEach((m, i) => {
    if (trees === 'all' || (trees === 'half' && i % 2 === 0)) m.geometry.boundsTree = new MeshBVH(m.geometry);
  });
};

const configs: [string, (side: Side) => Mesh[], boolean][] = [
  ['分開的格子', gridConfig, false],
  ['外接球重疊', overlapConfig, false],
  ['射線從裡面出發', insideConfig, true],
];

describe('pickOrdered 和 intersectObjects 一樣', () => {
  beforeEach(() => {
    bvhBudget.until = 0;
  });
  for (const [name, make, inside] of configs)
    for (const trees of ['none', 'all', 'half'] as Trees[])
      for (const side of [DoubleSide, FrontSide])
        it(`${name}／BVH ${trees}／${side === DoubleSide ? '雙面' : '單面'}：200 條射線`, () => {
          const meshes = make(side);
          prepare(meshes, trees);
          let hits = 0;
          let misses = 0;
          for (const ray of rays(200, 11, inside)) {
            const ref = castRef(meshes, ray);
            const first = castMine(meshes, ray, true);
            const all = castMine(meshes, ray, false);
            if (!ref.length) {
              misses++;
              expect(first).toEqual([]);
              expect(all).toEqual([]);
              continue;
            }
            hits++;
            expect(first).toHaveLength(1);
            same(first[0], ref[0]);
            expect(all).toHaveLength(ref.length);
            all.forEach((h, i) => same(h, ref[i]));
            for (let i = 1; i < all.length; i++) expect(all[i].distance).toBeGreaterThanOrEqual(all[i - 1].distance);
          }
          // 配置要有意義：有打到的也有打空的（從大盒子裡面出發、雙面時每條都會打到內壁）
          expect(hits).toBeGreaterThan(30);
          if (!inside) expect(misses).toBeGreaterThan(5);
        });
});

describe('由近到遠，命中確定了就停', () => {
  beforeEach(() => {
    bvhBudget.until = 0;
  });
  it('沿一排格子射：firstOnly 只 raycast 第一個 chunk；全部要時也只算射線穿過的那幾個', () => {
    const meshes = gridConfig(DoubleSide);
    const calls = new Map<Mesh, number>();
    for (const m of meshes)
      m.raycast = function (this: Mesh, rc: Raycaster, out: Intersection[]) {
        calls.set(this, (calls.get(this) ?? 0) + 1);
        lazyRaycast.call(this, rc, out);
      };
    // 從 x 很遠處沿 x 軸射向 (y≈20, z≈20) 這一排：三個格子外接球（半徑 8.66、間距 14）彼此重疊
    //（稍微偏離面的中心，不然剛好打在 quad 的對角線上、兩個三角形都算命中）
    const ray: Ray = { o: new Vector3(-200, 100 - 21.3, 18.7), d: new Vector3(1, 0, 0) };
    const first = castMine(meshes, ray, true);
    expect(first).toHaveLength(1);
    expect((first[0].object as Mesh).geometry.boundingSphere!.center.x).toBeCloseTo(20);
    expect([...calls.values()].reduce((a, b) => a + b, 0)).toBe(1);
    calls.clear();
    const all = castMine(meshes, ray, false);
    // 一排三個格子、每個進出各一面（雙面）
    expect(all).toHaveLength(6);
    expect([...calls.values()].reduce((a, b) => a + b, 0)).toBe(3);
  });
  it('pickAlong 可以提早停：只取前兩個命中時不會碰到後面的 chunk', () => {
    const meshes = gridConfig(DoubleSide);
    const calls = new Set<Mesh>();
    for (const m of meshes)
      m.raycast = function (this: Mesh, rc: Raycaster, out: Intersection[]) {
        calls.add(this);
        lazyRaycast.call(this, rc, out);
      };
    const rc = new Raycaster();
    rc.set(new Vector3(-200, 100 - 21.3, 18.7), new Vector3(1, 0, 0));
    rc.firstHitOnly = false;
    const got: Intersection[] = [];
    for (const h of pickAlong(rc, meshes)) {
      got.push(h);
      if (got.length === 2) break;
    }
    expect(got.map((h) => h.distance)).toEqual([215, 225]);
    expect(calls.size).toBe(1);
  });
  it('sphereEntry：從外面＝進入距離、從裡面＝near、沒交到＝null', () => {
    const [m] = scene([box(0, 0, 0, 10, 10, 10, DoubleSide)], 0);
    const rc = new Raycaster();
    rc.set(new Vector3(-50, 0, 0), new Vector3(1, 0, 0));
    expect(sphereEntry(rc, m)).toBeCloseTo(50 - m.geometry.boundingSphere!.radius);
    rc.set(new Vector3(1, 1, 1), new Vector3(1, 0, 0));
    expect(sphereEntry(rc, m)).toBe(0);
    rc.set(new Vector3(-50, 30, 0), new Vector3(1, 0, 0));
    expect(sphereEntry(rc, m)).toBeNull();
    rc.set(new Vector3(-50, 0, 0), new Vector3(-1, 0, 0));
    expect(sphereEntry(rc, m)).toBeNull();
  });
});

describe('BVH 預算', () => {
  afterEach(() => {
    bvhBudget.until = 0;
  });
  it('沒開始事件（預算 0）：不建樹，計數不動，結果仍對', () => {
    const meshes = gridConfig(DoubleSide);
    const n0 = bvhStats.sync;
    const ray: Ray = { o: new Vector3(-200, 100 - 21.3, 18.7), d: new Vector3(1, 0, 0) };
    const all = castMine(meshes, ray, false);
    expect(all).toHaveLength(6);
    expect(meshes.some((m) => m.geometry.boundsTree)).toBe(false);
    expect(bvhStats.sync).toBe(n0);
  });
  it('事件開始後：只有真的 raycast 到的 chunk 建樹，每建一棵計數 +1', () => {
    const meshes = gridConfig(DoubleSide);
    const n0 = bvhStats.sync;
    beginPickEvent();
    const ray: Ray = { o: new Vector3(-200, 100 - 21.3, 18.7), d: new Vector3(1, 0, 0) };
    expect(castMine(meshes, ray, true)).toHaveLength(1);
    expect(meshes.filter((m) => m.geometry.boundsTree)).toHaveLength(1);
    expect(bvhStats.sync).toBe(n0 + 1);
    expect(castMine(meshes, ray, false)).toHaveLength(6);
    expect(meshes.filter((m) => m.geometry.boundsTree)).toHaveLength(3);
    expect(bvhStats.sync).toBe(n0 + 3);
  });
  it('預算過期：這一次不建樹，改走三角形級 raycast，結果相同', () => {
    const meshes = overlapConfig(DoubleSide);
    beginPickEvent(performance.now() - 1000);
    const n0 = bvhStats.sync;
    for (const ray of rays(30, 3, false)) {
      const ref = castRef(meshes, ray);
      const all = castMine(meshes, ray, false);
      expect(all).toHaveLength(ref.length);
      all.forEach((h, i) => same(h, ref[i]));
    }
    expect(meshes.some((m) => m.geometry.boundsTree)).toBe(false);
    expect(bvhStats.sync).toBe(n0);
  });
});

describe('idle 補建：單一排程', () => {
  type Cb = (d: { timeRemaining: () => number }) => void;
  let cbs: Cb[] = [];
  beforeEach(() => {
    cbs = [];
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = (cb: Cb) => (cbs.push(cb), cbs.length);
  });
  afterEach(() => {
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  });
  it('叫兩次只排一次；新清單換掉舊的；first 的排前面；時間不夠就下一次 idle 再來', () => {
    const a = gridConfig(DoubleSide);
    const b = overlapConfig(DoubleSide);
    scheduleIdleBVH(a);
    expect(cbs).toHaveLength(1);
    expect(idleBVHState()).toMatchObject({ scheduled: true });
    expect(idleBVHState().queue).toHaveLength(a.length);
    scheduleIdleBVH(b, (m) => m === b[5]);
    expect(cbs).toHaveLength(1);
    const q = idleBVHState().queue;
    expect(q).toHaveLength(b.length);
    expect(q[0]).toBe(b[5]);
    expect(q.every((m) => b.includes(m))).toBe(true);
    const n0 = bvhStats.idle;
    // 第一次 idle 只夠建兩棵
    let left = 2;
    cbs[0]({ timeRemaining: () => (left-- > 0 ? 50 : 1) });
    // 先 b[5]（first）再 b[0]（清單裡的第一個）；filter 照 b 的順序回
    expect(b.filter((m) => m.geometry.boundsTree)).toEqual([b[0], b[5]]);
    expect(bvhStats.idle).toBe(n0 + 2);
    expect(cbs).toHaveLength(2);
    expect(idleBVHState().queue).toHaveLength(b.length - 2);
    // 第二次全部建完，不再排
    cbs[1]({ timeRemaining: () => 50 });
    expect(b.every((m) => m.geometry.boundsTree)).toBe(true);
    expect(bvhStats.idle).toBe(n0 + b.length);
    expect(cbs).toHaveLength(2);
    expect(idleBVHState()).toEqual({ scheduled: false, queue: [] });
    // a 一棵都沒建（清單被換掉了）
    expect(a.some((m) => m.geometry.boundsTree)).toBe(false);
  });
  it('已經建好的不排；沒有 requestIdleCallback 就什麼都不做', () => {
    const a = gridConfig(DoubleSide);
    a.forEach((m) => (m.geometry.boundsTree = new MeshBVH(m.geometry)));
    scheduleIdleBVH(a);
    expect(cbs).toHaveLength(0);
    expect(idleBVHState()).toEqual({ scheduled: false, queue: [] });
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
    scheduleIdleBVH(overlapConfig(DoubleSide));
    expect(idleBVHState()).toEqual({ scheduled: false, queue: [] });
  });
});
