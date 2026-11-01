// 切面層（plan v12 §5.3、§5.4「不卡的三個規定」c）：任何 split（live、parked、原始）的一片，
// 以 (split 版本, 原始版本, 軸, 片) 快取；parked 不還原，從原始那一片＋補丁做出來。
import type { Axis } from '../../volume/volume';
import type { EditState } from '../../volume/ops';
import { sidOf } from '../../volume/client';
import { type Slab, slabOfArrays, slabOfPatch } from '../../splits/lifecycle';
import type { Split } from './editor';

const cache = new Map<string, Slab>();
let bytes = 0;
/** 快取上限（位元組）：一片 data＋labels＋diff＋原始 ≈ 7 B／格。 */
const LIMIT = 96 * 1024 * 1024;
const sizeOf = (s: Slab) => s.vol.data.length * 7;
let hits = 0;
let misses = 0;

/** s 的版本（parked 的 cur 也有自己的版本號）；null＝原始。 */
export const versionOf = (orig: EditState, s: Split | null) => (s ? sidOf(s.cur) : sidOf(orig));

/** split（或原始）在 axis＝at 的一片（法線軸長度 1 的假 Volume，at 換成 0）。 */
export function slabOf(orig: EditState, s: Split | null, axis: Axis, at: number): Slab {
  const key = `${versionOf(orig, s)}|${sidOf(orig)}|${axis}|${at}`;
  const hit = cache.get(key);
  if (hit) {
    hits++;
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  misses++;
  const o = orig.vol;
  let slab: Slab;
  if (s && s.state === 'parked' && s.patch) slab = slabOfPatch(o, o.data, orig.L.labels, s.patch, axis, at);
  else {
    const st = s ? s.cur : orig;
    slab = slabOfArrays(o, st.vol.data, st.L.labels, st.L.comps, o.data, axis, at);
  }
  cache.set(key, slab);
  bytes += sizeOf(slab);
  while (bytes > LIMIT && cache.size > 1) {
    const k = cache.keys().next().value!;
    bytes -= sizeOf(cache.get(k)!);
    cache.delete(k);
  }
  return slab;
}

/** 開發模式量測：命中／重算次數。 */
export const slabStats = () => ({ hits, misses, size: cache.size, bytes });
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  (window as unknown as { __slabStats?: unknown }).__slabStats = slabStats;
  // e2e：任一 split（id；'base'＝原始）在 axis＝at 的一片
  (window as unknown as { __slab?: unknown }).__slab = (ed: { orig: EditState; splits: Split[] }, id: string, axis: Axis, at: number) =>
    slabOf(ed.orig, ed.splits.find((s) => s.id === id) ?? null, axis, at);
}

/** 兩片不同的格子（A vs B 的基準不是原始時）。純函式；並排卡片走有快取的 pairMaskOf。 */
export function pairMask(a: Uint8Array, b: Uint8Array) {
  const m = new Uint8Array(a.length);
  let n = 0;
  for (let i = 0; i < a.length; i++)
    if (a[i] !== b[i]) {
      m[i] = 1;
      n++;
    }
  return { mask: m, count: n };
}

/** A vs B 差異 mask 的快取（plan v15 §5.6 C5）：key＝兩個版本＋軸＋片，值是片大小的 mask；上限 32 MB、LRU。 */
const pairs = new Map<string, { mask: Uint8Array; count: number }>();
let pairBytes = 0;
const PAIR_LIMIT = 32 * 1024 * 1024;
export function pairMaskOf(va: number, a: Uint8Array, vb: number, b: Uint8Array, axis: Axis, at: number) {
  const key = `${va}|${vb}|${axis}|${at}`;
  const hit = pairs.get(key);
  if (hit) {
    pairs.delete(key);
    pairs.set(key, hit);
    return hit;
  }
  const r = pairMask(a, b);
  pairs.set(key, r);
  pairBytes += r.mask.length;
  while (pairBytes > PAIR_LIMIT && pairs.size > 1) {
    const k = pairs.keys().next().value!;
    pairBytes -= pairs.get(k)!.mask.length;
    pairs.delete(k);
  }
  return r;
}
/** 開發模式量測：A vs B 快取有幾筆、幾位元組。 */
export const pairStats = () => ({ size: pairs.size, bytes: pairBytes });
