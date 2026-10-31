// profile Op（plan v7 §7.3、§10.3）：2D 剖面上拖節點、斜邊、圓弧產生的改動。
// 一份「要加的格子」與「要拿的格子」（切面座標，每格帶往外的方向碼），套用到 scope 裡的每一片：
// 先拿再加；加的格子由近到遠、要和這一片已經是結構的格子 4 鄰接才填；這一片沒有結構就整片略過。
// 實際改體素一律走 kernel（和 3D 的推面、補平同一套規則）。
import type { Backfill, Vec3, Volume } from './volume';
import { type Report, addCell, removeCell } from './kernel';
import { type Scope, axisIndex, planeAxes, to3D } from './scope';
import { type ProfileCell, type Rle2D, decodeRle } from './rle';
import { type RelGesture, type TracedHandle, relativeCells, traceHandle } from '../slice/relative';
import { type RoundGesture, roundCells } from '../slice/round';

export { type ProfileCell, type Rle2D, decodeRle, encodeRle, rleBox } from './rle';

export interface ProfileOp {
  kind: 'profile';
  keys: string[];
  /** axis = 切面法線軸。 */
  scope: Scope;
  /** 參考片（手勢做在哪一片）。 */
  at: number;
  /** 每個結構各自一份要加、要拿的格子。 */
  perKey: Record<string, { add: Rle2D; remove: Rle2D }>;
  follow: boolean;
  backfill: Backfill;
  /** 「頂角節點往外 2 vx」之類，由手勢產生。 */
  text?: string;
  /**
   * 相對式套用（§7.8）：每個結構的手勢本身。有的話每一片先描自己的輪廓、找同一個把手重做手勢；
   * 對不到的片才用上面的絕對 add／remove（報告裡記 fallback）。
   */
  gestures?: Record<string, RelGesture>;
  /**
   * 圓頭（plan v10 §4.6）：每個結構的 RoundGesture。有的話每一片用自己的外框重算（永遠對得到、沒有 fallback），
   * 優先於 gestures。和 gestures 分開放，RelGesture 的型別與既有程式不受影響。
   */
  rounds?: Record<string, RoundGesture>;
  /**
   * 參考片（at）用上面的絕對 add／remove，不重做手勢（plan v8：2D 的幾何層是持久的，參考片的格子
   * 就是那份幾何光柵化出來的，重描 voxel 再重做會差一格）。舊的 Op 沒有這一欄，重播不變。
   */
  refExact?: boolean;
}

/** 方向碼 → 體素方向（切面 axis 上）。 */
export function dirVec(axis: Scope['axis'], code: number): Vec3 {
  const du = code === 0 ? 1 : code === 1 ? -1 : 0;
  const dv = code === 2 ? 1 : code === 3 ? -1 : 0;
  return to3D(axis, du, dv, 0);
}

/**
 * 在 vol 上套用 profile（vol 可以是裁下來的一塊，off = 它在整個陣列的起點）。
 * masks：每個 key 的結構體素（和 vol 同大小）。
 * ringsFor：每片輪廓的快取（拖拉預覽用，plan v9 §4.5）：(key, 片) → 描好的輪廓與把手；沒有就呼叫 make。
 * 前提：vol 在切面上包住結構這一片整個外框（profileBox 有 gestures 時就是這樣），描出來的環才和範圍無關。
 */
export type RingsFor = (key: string, t: number, make: () => TracedHandle) => TracedHandle;
export function applyProfileMask(vol: Volume, orig: Volume, masks: Map<string, Uint8Array>, op: ProfileOp, off: Vec3, report?: Report, ringsFor?: RingsFor): Volume {
  const { X, Y, Z } = vol;
  const out = new Uint8Array(vol.data);
  const live: Volume = { X, Y, Z, data: out };
  const a = axisIndex(op.scope.axis);
  const [ua, va] = planeAxes(op.scope.axis);
  const dims = [X, Y, Z];
  const len = dims[a];
  // 切面座標 → index：三個 stride 先算好，熱迴圈裡不配陣列（plan v9 P19）
  const stride = [1, X, X * Y];
  const [su, sv, st] = [stride[ua], stride[va], stride[a]];
  const [ou, ov] = [off[ua], off[va]];
  const [nu, nv] = [dims[ua], dims[va]];
  const at = (u: number, v: number, t: number) => {
    const lu = u - ou;
    const lv = v - ov;
    return lu < 0 || lv < 0 || t < 0 || lu >= nu || lv >= nv || t >= len ? -1 : lu * su + lv * sv + t * st;
  };
  const absolute = Object.fromEntries(Object.entries(op.perKey).map(([k, v]) => [k, { add: decodeRle(v.add), remove: decodeRle(v.remove) }]));
  const [A0, B0] = [dims[ua], dims[va]];
  const fellBack = new Set<number>();
  const relMemo = new Map<TracedHandle, ReturnType<typeof relativeCells>>();
  const lo = Math.max(0, op.scope.lo - off[a]);
  const hi = Math.min(len - 1, op.scope.hi - off[a]);
  for (let t = lo; t <= hi; t++) {
    let any = false;
    for (const key of op.keys) {
      const mask = masks.get(key);
      if (!mask || !absolute[key]) continue;
      // 這一片有沒有這個結構（只看 add／remove 附近不夠：結構可能整片不在）
      let has = false;
      const pl = [0, 0, 0];
      pl[a] = t;
      const [A, B] = [dims[ua], dims[va]];
      for (let v = 0, base = t * st; v < B && !has; v++, base += sv)
        for (let u = 0, i = base; u < A; u++, i += su)
          if (mask[i]) {
            has = true;
            break;
          }
      if (!has) continue;
      any = true;
      // 相對式：這一片自己的輪廓上找同一個把手、重做手勢（切面座標＝整個陣列的）
      let c: { add: ProfileCell[]; remove: ProfileCell[] } = absolute[key];
      const g = op.rounds?.[key] ?? op.gestures?.[key];
      if (g && !(op.refExact && t + off[a] === op.at)) {
        const tb = t * st;
        const local = (u: number, v: number) => {
          const lu = u - ou;
          const lv = v - ov;
          return lu >= 0 && lv >= 0 && lu < A0 && lv < B0 && !!mask[tb + lu * su + lv * sv];
        };
        const [ru0, rv0, ru1, rv1] = [off[ua], off[va], off[ua] + A0 - 1, off[va] + B0 - 1];
        if (g.kind === 'round') {
          // 圓頭：這一片自己的外框重算（純函式、只看這一片），不走輪廓快取
          c = roundCells(local, ru0, rv0, ru1, rv1, g) ?? c;
        } else {
          const pre = ringsFor?.(key, t + off[a], () => traceHandle(local, ru0, rv0, ru1, rv1, g));
          // 快取把輪廓一模一樣的片合成同一份（沿法線擠出的結構多半每片都一樣）：同一份只重做一次手勢。
          // 輪廓（含洞）就是這一片結構的邊界，所以輪廓相同＝結構這一片相同，重做的結果也相同。
          let rel = pre ? relMemo.get(pre) : undefined;
          if (rel === undefined) {
            rel = relativeCells(local, ru0, rv0, ru1, rv1, g, pre);
            if (pre) relMemo.set(pre, rel);
          }
          if (rel) c = rel;
          else fellBack.add(t + off[a]);
        }
      }
      // 先拿：只拿屬於這個結構的
      for (const cell of c.remove) {
        const i = at(cell.u, cell.v, t);
        if (i < 0 || !mask[i]) continue;
        const x = i % X;
        const y = ((i - x) / X) % Y;
        const z = (i - x - y * X) / (X * Y);
        const m = out[i];
        removeCell(live, out, orig, x, y, z, dirVec(op.scope.axis, cell.dir), m, m, op.backfill, op.follow, report);
      }
      // 再加：由近到遠（cells 已依 BFS 距離排序），要 4 鄰接「已是結構」的格子才填，材質取那個鄰居的
      const grown = new Set<number>();
      const isStruct = (i: number) => i >= 0 && ((mask[i] && out[i] === vol.data[i]) || grown.has(i));
      const nbrs: [number, number][] = [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      // 加的格子可能要好幾輪才接得上（RLE 是逐列存的）：依「離結構的距離」一層一層加
      let pending = c.add.slice();
      for (let round = 0; pending.length && round < 256; round++) {
        const next: typeof pending = [];
        for (const cell of pending) {
          const i = at(cell.u, cell.v, t);
          if (i < 0) continue;
          let src = -1;
          for (const [du, dv] of nbrs) {
            const j = at(cell.u + du, cell.v + dv, t);
            if (isStruct(j)) {
              src = j;
              break;
            }
          }
          if (src < 0) {
            next.push(cell);
            continue;
          }
          const x = i % X;
          const y = ((i - x) / X) % Y;
          const z = (i - x - y * X) / (X * Y);
          if (out[i] === out[src] && mask[i]) continue;
          if (addCell(live, out, x, y, z, dirVec(op.scope.axis, cell.dir), out[src], op.follow, 'block', report)) grown.add(i);
        }
        if (next.length === pending.length) break;
        pending = next;
      }
    }
    if (!any && report) report.skipped.push(t + off[a]);
  }
  if (report) report.fallback.push(...fellBack);
  return live;
}
