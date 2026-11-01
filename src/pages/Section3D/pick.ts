// plan v15 §5.4 B4：3D 拾取的純函式（不依賴 React，pick.test.ts 直接用 three 的 Raycaster／Mesh 測）。
// 1. lazyRaycast：射線碰到 chunk 的外接球才建它的 BVH，而且每個事件有時間預算，超過的 chunk 這一次走三角形級 raycast。
// 2. pickAlong／pickOrdered：chunk 依射線進入外接球的距離排序、逐個 raycast，命中確定不會被後面的 chunk 超車就吐出，
//    只要第一個（或前幾個）命中時不必把射線穿過的每個 chunk 都算完。
// 3. scheduleIdleBVH：閒置時補建 BVH 的單一排程。
import { Mesh, Ray, Raycaster, Sphere, Vector3, type Intersection } from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

/** 每個滑鼠事件同步建 BVH 的時間預算（ms）：超過之後的 chunk 這一次不建樹，idle 再補。 */
export const BVH_BUDGET_MS = 8;
/** 模組層的預算：事件開始時 beginPickEvent() 把 until 設成 now + 預算；lazyRaycast 只在 now ≤ until 時建樹。 */
export const bvhBudget = { until: 0 };
/** 一個會拾取的事件開始了（pointerdown／move／up、滾輪、對準）：重設這一事件的 BVH 建置預算。 */
export const beginPickEvent = (now = performance.now()) => {
  bvhBudget.until = now + BVH_BUDGET_MS;
};
/** 計數（DEV 掛成 window.__bvhBuilds）：sync＝事件裡同步建的棵數、idle＝閒置時補建的棵數。 */
export const bvhStats = { sync: 0, idle: 0 };

const hasTriangles = (m: Mesh) => !!m.geometry.attributes.position?.count;
const buildTree = (m: Mesh) => {
  m.geometry.boundsTree = new MeshBVH(m.geometry);
};

const _sphere = new Sphere();
/**
 * BVH 懶建（plan v9 P5 → v15 B4）：射線碰到這個 chunk 的外接球才建它的 BVH；沒碰到的直接略過。
 * 這一事件的預算用完了就不建，交給 three 內建的 Mesh.prototype.raycast（O(三角形)，一個 64³ chunk 不到 1 ms）；
 * acceleratedRaycast 在沒有 boundsTree 時就是走內建的那條。
 */
export function lazyRaycast(this: Mesh, raycaster: Raycaster, intersects: Intersection[]) {
  const g = this.geometry;
  if (!g.attributes.position?.count) return;
  if (!g.boundingSphere) g.computeBoundingSphere();
  _sphere.copy(g.boundingSphere!).applyMatrix4(this.matrixWorld);
  if (!raycaster.ray.intersectsSphere(_sphere)) return;
  if (!g.boundsTree && performance.now() <= bvhBudget.until) {
    buildTree(this);
    bvhStats.sync++;
  }
  acceleratedRaycast.call(this, raycaster, intersects);
}

const _hitAt = new Vector3();
const _ray = new Ray();
/**
 * 射線進入 mesh 外接球的距離 tIn（射線從球裡出發＝near）；沒交到回 null。
 * 這個 chunk 任何命中的 distance 都 ≥ tIn，所以 tIn 排序後，命中比下一個 chunk 的 tIn 近就不會再被超車。
 */
export const sphereEntry = (raycaster: Raycaster, m: Mesh): number | null => {
  const g = m.geometry;
  if (!g.boundingSphere) g.computeBoundingSphere();
  _sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
  _ray.copy(raycaster.ray).recast(raycaster.near);
  if (_sphere.containsPoint(_ray.origin)) return raycaster.near;
  if (!_ray.intersectSphere(_sphere, _hitAt)) return null;
  const t = raycaster.ray.origin.distanceTo(_hitAt);
  return t > raycaster.far ? null : t;
};

/** 依 distance 插進已排好的陣列（相同距離放在後面，和 intersectObjects 的穩定排序一致）。 */
const insertByDistance = (arr: Intersection[], h: Intersection) => {
  let i = arr.length;
  while (i > 0 && arr[i - 1].distance > h.distance) i--;
  arr.splice(i, 0, h);
};

/**
 * 由近到遠吐出命中（和 intersectObjects 排序後的結果同序）：
 * chunk 依 tIn 排序，逐個 raycast；命中的 distance 比下一個還沒算的 chunk 的 tIn 近，就已經確定是下一個最近的，直接吐出。
 * 消費者只要前幾個命中時可以提早 return（例如沿射線前 8 個結構），後面的 chunk 就不必算。
 * raycaster.firstHitOnly = true 時每個 chunk 只回它最近的命中，所以只有第一個吐出的命中是對的（pickOrdered 用）。
 */
export function* pickAlong(raycaster: Raycaster, meshes: Iterable<Mesh>): Generator<Intersection, void, undefined> {
  const cands: { m: Mesh; tIn: number }[] = [];
  for (const m of meshes) {
    if (!hasTriangles(m)) continue;
    const tIn = sphereEntry(raycaster, m);
    if (tIn !== null) cands.push({ m, tIn });
  }
  cands.sort((a, b) => a.tIn - b.tIn);
  const pending: Intersection[] = [];
  const tmp: Intersection[] = [];
  for (let i = 0; i < cands.length; i++) {
    tmp.length = 0;
    cands[i].m.raycast(raycaster, tmp);
    for (const h of tmp) insertByDistance(pending, h);
    const next = i + 1 < cands.length ? cands[i + 1].tIn : Infinity;
    while (pending.length && pending[0].distance < next) yield pending.shift()!;
  }
  yield* pending;
}

/**
 * 拾取：firstOnly＝只要最近的一個（結果 === intersectObjects(...)[0]），否則全部由近到遠（=== intersectObjects(...)）。
 * 取代 intersectObjects(pickables())：不必把射線穿過的每個 chunk 都 raycast（也就不必都建 BVH）。
 */
export const pickOrdered = (raycaster: Raycaster, meshes: Iterable<Mesh>, firstOnly: boolean): Intersection[] => {
  raycaster.firstHitOnly = firstOnly;
  if (!firstOnly) return [...pickAlong(raycaster, meshes)];
  for (const h of pickAlong(raycaster, meshes)) return [h];
  return [];
};

type Idle = { timeRemaining: () => number };
type RIC = (cb: (d: Idle) => void) => number;
const ricOf = () => (globalThis as { requestIdleCallback?: RIC }).requestIdleCallback;
/** 閒置補建的單一排程：handle ≠ 0 表示已經排了；queue 是待建清單（新的一組 chunk 來了就整個換掉）。 */
const idle = { handle: 0, queue: [] as Mesh[] };
/**
 * 閒置時補建還沒建的 BVH（plan v15 B4：單一排程）。
 * 每次呼叫只換待建清單，不另起一條鏈；first 回 true 的（最近一步改到的 chunk）排前面。
 * 沒有 requestIdleCallback 的瀏覽器就等第一次點到再建。
 */
export const scheduleIdleBVH = (meshes: Iterable<Mesh>, first: ((m: Mesh) => boolean) | null = null) => {
  const ric = ricOf();
  if (!ric) return;
  const head: Mesh[] = [];
  const tail: Mesh[] = [];
  for (const m of meshes) if (!m.geometry.boundsTree && hasTriangles(m)) (first?.(m) ? head : tail).push(m);
  idle.queue = head.concat(tail);
  if (idle.handle || !idle.queue.length) return;
  const step = (d: Idle) => {
    idle.handle = 0;
    const q = idle.queue;
    while (q.length) {
      if (d.timeRemaining() < 4) {
        idle.handle = ric(step);
        return;
      }
      const m = q.shift()!;
      if (m.geometry.boundsTree || !hasTriangles(m)) continue;
      buildTree(m);
      bvhStats.idle++;
    }
  };
  idle.handle = ric(step);
};
/** 測試用：目前的待建清單與有沒有排程。 */
export const idleBVHState = () => ({ scheduled: idle.handle !== 0, queue: idle.queue.slice() });
