// Web Worker：所有 O(N) 的運算（標記、重播操作＋relabel、網格、diff、計數）都在這裡，主執行緒只畫畫面。
// 狀態常駐在 Worker：原始與每個 split 目前的結果用編號（sid）存著，主執行緒只送編號與小資料，
// 不必每一步都把幾百 MB 的陣列複製過來。結果先在 Worker 裡複製一份（memcpy）再 transfer 回去。
import { type BBox, type Comp, type MeshData, type RawComp, type Volume, DIFF_BIT, greedyMesh, labelComponents } from './volume';
import { type Scope, clipBox } from './scope';
import { type Op, replay } from './ops';
import { applyOpLocal } from './apply';
import { type Step, applyStep } from './patch';
import type { Report } from './kernel';
import { chunkBox, chunkCount, chunksTouching, gridOf, greedyMeshChunk } from './chunks';

/** 一步的結果裡要 transfer 回主執行緒的陣列。 */
const stepBuffers = (st: Step): Transferable[] => {
  const out: Transferable[] = [];
  if (st.data) out.push(st.data.before.buffer, st.data.after.buffer);
  if (st.labels) out.push(st.labels.before.buffer, st.labels.after.buffer);
  return out;
};
/** chunk 網格：k = chunk 編號，m.quads = 0 表示這個 chunk 現在是空的（主執行緒拿掉）。 */
export interface ChunkItem {
  k: number;
  m: MeshData;
}

/** 網格只畫一部分：選取（結構編號 ∩ z 範圍，box = 它們的外框）或某個材質（空洞層）。 */
export type Only = { comps: number[]; scope: Scope; box: BBox } | { mat: number };

export interface Requests {
  /** 載入原始：存起來並標記結構；之前的狀態全部丟掉。 */
  load: { req: { sid: number; vol: Volume }; res: { labels: Int32Array; raw: RawComp[] } };
  /** 主執行緒有、Worker 沒有的狀態（例如復原回來的舊步驟）補送過來。 */
  put: { req: { sid: number; vol: Volume; labels: Int32Array }; res: null };
  /** 只留下這些編號，其他釋放。 */
  retain: { req: { sids: number[] }; res: null };
  replay: {
    req: { from: number; to: number; comps: Comp[]; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    res: { data: Uint8Array; labels: Int32Array; comps: Comp[]; keyCounter: number };
  };
  mesh: {
    req: {
      sid: number;
      /** 長度 256，1 = 不畫這個材質。 */
      hidden: Uint8Array;
      /** 改過的體素混紅、不和沒改過的合併。 */
      diff?: boolean;
      only?: Only;
      /** 長度 768，每個材質的 RGB（0～1）。 */
      palette: Float32Array;
      tint?: [number, number, number];
      /** 頂點沿面法線外推這麼多（選取層用，避免和主網格共面閃爍）。 */
      inflate?: number;
    };
    res: MeshData;
  };
  /** 差異模式：改過的體素（含被拿掉的，畫紅）一層、沒改的一層（半透明灰）。 */
  diffMesh: {
    req: { sid: number; hidden: Uint8Array; palette: Float32Array };
    res: { changed: MeshData; ghost: MeshData };
  };
  diff: { req: { sid: number }; res: { mask: Uint8Array; count: number } };
  /** 一步操作：只在外框裡算（§8.2），結果存成 to，回傳補丁（主執行緒拿它做出新版本）。 */
  apply: {
    req: { from: number; to: number; comps: Comp[]; op: Op; matNames: Record<number, string>; keyCounter: number };
    res: { step: Step; keyCounter: number; report: Report };
  };
  /** 復原／重做：從 from 套補丁（往前或往回）做出 to（§8.3）。 */
  derive: { req: { from: number; to: number; step: Step; dir: 'fwd' | 'back' }; res: null };
  /**
   * chunk 網格（§8.4）：key＝畫法（隱藏、顏色、標紅）；base＝主執行緒現在畫的版本（同一個 key）。
   * base 是 sid 的上一步時只回改到的 chunk（full = false），否則回全部（full = true）。
   */
  chunks: {
    req: { sid: number; key: string; hidden: Uint8Array; diff: boolean; palette: Float32Array; base?: number };
    res: { full: boolean; items: ChunkItem[] };
  };
  count: { req: { sid: number }; res: number[] };
}
export type Kind = keyof Requests;

interface State {
  vol: Volume;
  labels: Int32Array;
}
const store = new Map<number, State>();
const diffs = new Map<number, { mask: Uint8Array; count: number }>();
const counts = new Map<number, Float64Array>();
/** 每個版本從哪一版、改了哪個外框來的（chunk 網格只重算改到的地方）。 */
const parents = new Map<number, { from: number; box: BBox | null }>();
/** chunk 網格快取：`${sid}|${key}` → chunk 編號 → 網格（只存非空的）；最近用的 4 組。 */
const chunkCache = new Map<string, Map<number, MeshData>>();
const CHUNK_CACHE = 4;
let origSid = 0;

/** 新版本 to 的 diff 與材質計數：上一版有算過就只在改到的外框裡更新（§8.5）。 */
function carryStats(from: number, to: number, box: BBox | null) {
  const a = get(from).vol;
  const b = get(to).vol;
  const o = get(origSid).vol.data;
  const d = diffs.get(from);
  const c = counts.get(from);
  if (!box) {
    if (d) diffs.set(to, d);
    if (c) counts.set(to, c);
    return;
  }
  const { X, Y } = b;
  if (d) {
    const mask = d.mask.slice();
    let count = d.count;
    for (let z = box.z0; z <= box.z1; z++)
      for (let y = box.y0; y <= box.y1; y++)
        for (let i = (z * Y + y) * X + box.x0, e = i + box.x1 - box.x0; i <= e; i++) {
          const now = b.data[i] !== o[i] ? 1 : 0;
          count += now - mask[i];
          mask[i] = now;
        }
    diffs.set(to, { mask, count });
  }
  if (c) {
    const out = c.slice();
    for (let z = box.z0; z <= box.z1; z++)
      for (let y = box.y0; y <= box.y1; y++)
        for (let i = (z * Y + y) * X + box.x0, e = i + box.x1 - box.x0; i <= e; i++) {
          out[a.data[i]]--;
          out[b.data[i]]++;
        }
    counts.set(to, out);
  }
}

const get = (sid: number) => {
  const s = store.get(sid);
  if (!s) throw new Error(`Worker 沒有狀態 ${sid}`);
  return s;
};
const diffOf = (sid: number) => {
  let d = diffs.get(sid);
  if (!d) {
    const a = get(origSid).vol.data;
    const b = get(sid).vol.data;
    const mask = new Uint8Array(a.length);
    let count = 0;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) {
        mask[i] = 1;
        count++;
      }
    d = { mask, count };
    diffs.set(sid, d);
  }
  return d;
};

/** 差異模式裡「原本有、現在是空氣」的體素代碼（材質編號只到 254）。 */
const REMOVED = 255;

const emptyMesh = (): MeshData => ({ positions: new Float32Array(0), normals: new Float32Array(0), colors: new Float32Array(0), quads: 0 });

/** 符合 test 的體素外框；一個都沒有回傳 null。 */
function boxOf(vol: Volume, test: (i: number) => boolean): BBox | null {
  const { X, Y, Z } = vol;
  const b: BBox = { x0: X, x1: -1, y0: Y, y1: -1, z0: Z, z1: -1 };
  for (let z = 0, i = 0; z < Z; z++)
    for (let y = 0; y < Y; y++)
      for (let x = 0; x < X; x++, i++)
        if (test(i)) {
          if (x < b.x0) b.x0 = x;
          if (x > b.x1) b.x1 = x;
          if (y < b.y0) b.y0 = y;
          if (y > b.y1) b.y1 = y;
          if (z < b.z0) b.z0 = z;
          if (z > b.z1) b.z1 = z;
        }
  return b.x1 < 0 ? null : b;
}

/** 只在 box 裡做單色 greedy mesh，座標再平移回整個陣列。 */
function meshInBox(vol: Volume, box: BBox, test: (i: number) => boolean, rgb: [number, number, number]): MeshData {
  const { X, Y } = vol;
  const bx = box.x1 - box.x0 + 1;
  const by = box.y1 - box.y0 + 1;
  const bz = box.z1 - box.z0 + 1;
  const codes = new Uint16Array(bx * by * bz);
  for (let z = 0, k = 0; z < bz; z++)
    for (let y = 0; y < by; y++) {
      const row = ((z + box.z0) * Y + y + box.y0) * X + box.x0;
      for (let x = 0; x < bx; x++, k++) if (test(row + x)) codes[k] = 1;
    }
  const m = greedyMesh(bx, by, bz, codes, () => rgb);
  for (let i = 0; i < m.positions.length; i += 3) {
    m.positions[i] += box.x0;
    m.positions[i + 1] += box.y0;
    m.positions[i + 2] += box.z0;
  }
  return m;
}

type Handler<K extends Kind> = (req: Requests[K]['req']) => [Requests[K]['res'], Transferable[]];

const handlers: { [K in Kind]: Handler<K> } = {
  load: ({ sid, vol }) => {
    store.clear();
    diffs.clear();
    counts.clear();
    parents.clear();
    chunkCache.clear();
    const { labels, raw } = labelComponents(vol);
    store.set(sid, { vol, labels });
    origSid = sid;
    // 原始和自己沒有不同：之後每一步的 diff 都從這裡在外框裡更新
    diffs.set(sid, { mask: new Uint8Array(vol.data.length), count: 0 });
    const out = labels.slice();
    return [{ labels: out, raw }, [out.buffer]];
  },
  put: ({ sid, vol, labels }) => {
    store.set(sid, { vol, labels });
    return [null, []];
  },
  retain: ({ sids }) => {
    const keep = new Set([...sids, origSid]);
    for (const k of store.keys()) if (!keep.has(k)) store.delete(k);
    for (const k of diffs.keys()) if (!keep.has(k)) diffs.delete(k);
    for (const k of counts.keys()) if (!keep.has(k)) counts.delete(k);
    return [null, []];
  },
  apply: ({ from, to, comps, op, matNames, keyCounter }) => {
    const src = get(from);
    let seq = keyCounter;
    const r = applyOpLocal({ vol: src.vol, L: { labels: src.labels, comps } }, op, {
      orig: get(origSid).vol,
      matName: (id) => matNames[id] ?? `材質 ${id}`,
      newKey: () => `c${seq++}`,
    });
    store.set(to, { vol: r.state.vol, labels: r.state.L.labels });
    parents.set(to, { from, box: r.step.data?.box ?? null });
    carryStats(from, to, r.step.data?.box ?? null);
    return [{ step: r.step, keyCounter: seq, report: r.report }, stepBuffers(r.step)];
  },
  derive: ({ from, to, step, dir }) => {
    if (!store.has(to)) {
      const src = get(from);
      const out = applyStep({ vol: src.vol, L: { labels: src.labels, comps: [] } }, step, dir);
      store.set(to, { vol: out.vol, labels: out.L.labels });
      carryStats(from, to, step.data?.box ?? null);
    }
    parents.set(to, { from, box: step.data?.box ?? null });
    return [null, []];
  },
  chunks: ({ sid, key, hidden, diff, palette, base }) => {
    const { vol } = get(sid);
    const g = gridOf(vol);
    const d = diff && sid !== origSid ? diffOf(sid).mask : null;
    const data = vol.data;
    const code = (i: number) => {
      const m = data[i];
      return m && !hidden[m] ? (d?.[i] ? m | DIFF_BIT : m) : 0;
    };
    const color = (c: number): [number, number, number] => {
      const id = c & 255;
      const r = palette[id * 3];
      const gg = palette[id * 3 + 1];
      const b = palette[id * 3 + 2];
      return c & DIFF_BIT ? [r * 0.35 + 0.65, gg * 0.35 + 0.2, b * 0.35 + 0.2] : [r, gg, b];
    };
    const ck = `${sid}|${key}`;
    const par = parents.get(sid);
    let map = chunkCache.get(ck);
    let dirty: number[] | null = null;
    if (par) dirty = par.box ? chunksTouching(vol, g, par.box) : [];
    if (!map) {
      const pmap = par ? chunkCache.get(`${par.from}|${key}`) : undefined;
      if (pmap && dirty) {
        map = new Map(pmap);
        for (const k of dirty) {
          const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
          if (m.quads) map.set(k, m);
          else map.delete(k);
        }
      } else {
        map = new Map();
        for (let k = 0; k < chunkCount(g); k++) {
          const m = greedyMeshChunk(vol, code, chunkBox(vol, g, k), color);
          if (m.quads) map.set(k, m);
        }
      }
    }
    chunkCache.delete(ck);
    chunkCache.set(ck, map);
    while (chunkCache.size > CHUNK_CACHE) chunkCache.delete(chunkCache.keys().next().value!);
    const copy = (k: number): ChunkItem => {
      const m = map!.get(k);
      return m
        ? { k, m: { positions: m.positions.slice(), normals: m.normals.slice(), colors: m.colors.slice(), quads: m.quads } }
        : { k, m: emptyMesh() };
    };
    let full = true;
    let items: ChunkItem[];
    if (base === sid) {
      full = false;
      items = [];
    } else if (par && base === par.from && dirty) {
      full = false;
      items = dirty.map(copy);
    } else items = [...map.keys()].map(copy);
    const transfer: Transferable[] = [];
    for (const it of items) transfer.push(it.m.positions.buffer, it.m.normals.buffer, it.m.colors.buffer);
    return [{ full, items }, transfer];
  },
  replay: ({ from, to, comps, ops, matNames, keyCounter }) => {
    const src = get(from);
    let seq = keyCounter;
    const s = replay({ vol: src.vol, L: { labels: src.labels, comps } }, ops, {
      orig: get(origSid).vol,
      matName: (id) => matNames[id] ?? `材質 ${id}`,
      newKey: () => `c${seq++}`,
    });
    store.set(to, { vol: s.vol, labels: s.L.labels });
    // Worker 自己留一份，複本 transfer 回主執行緒
    const data = s.vol.data.slice();
    const labels = s.L.labels.slice();
    return [{ data, labels, comps: s.L.comps, keyCounter: seq }, [data.buffer, labels.buffer]];
  },
  mesh: ({ sid, hidden, diff, only, palette, tint, inflate }) => {
    const { vol, labels } = get(sid);
    if (only) {
      // 選取層、空洞層只在外框裡做 greedy mesh，不掃整個陣列三次
      let test: (i: number) => boolean;
      let box: BBox | null;
      if ('mat' in only) {
        test = (i) => vol.data[i] === only.mat;
        box = boxOf(vol, test);
      } else {
        const on = new Uint8Array(Math.max(1, ...only.comps.map((c) => c + 1)));
        only.comps.forEach((c) => (on[c] = 1));
        test = (i) => labels[i] >= 0 && on[labels[i]] === 1;
        box = clipBox(only.box, only.scope);
      }
      const m = box ? meshInBox(vol, box, test, tint ?? [0.09, 0.47, 1]) : emptyMesh();
      if (inflate) for (let i = 0; i < m.positions.length; i++) m.positions[i] += m.normals[i] * inflate;
      return [m, [m.positions.buffer, m.normals.buffer, m.colors.buffer]];
    }
    const { X, Y, Z, data } = vol;
    const N = X * Y * Z;
    const codes = new Uint16Array(N);
    const d = diff && sid !== origSid ? diffOf(sid).mask : null;
    for (let i = 0; i < N; i++) {
      const m = data[i];
      if (m && !hidden[m]) codes[i] = d?.[i] ? m | DIFF_BIT : m;
    }
    const m = greedyMesh(X, Y, Z, codes, (code) => {
      const id = code & 255;
      const r = palette[id * 3];
      const g = palette[id * 3 + 1];
      const b = palette[id * 3 + 2];
      return code & DIFF_BIT ? [r * 0.35 + 0.65, g * 0.35 + 0.2, b * 0.35 + 0.2] : [r, g, b];
    });
    return [m, [m.positions.buffer, m.normals.buffer, m.colors.buffer]];
  },
  diffMesh: ({ sid, hidden, palette }) => {
    const { vol } = get(sid);
    const o = get(origSid).vol.data;
    const { X, Y, Z, data } = vol;
    const N = X * Y * Z;
    const d = sid === origSid ? null : diffOf(sid).mask;
    const changed = new Uint16Array(N);
    const ghost = new Uint16Array(N);
    for (let i = 0; i < N; i++) {
      const m = data[i];
      if (d?.[i]) {
        if (m && !hidden[m]) changed[i] = m;
        else if (!m && o[i] && !hidden[o[i]]) changed[i] = REMOVED;
      } else if (m && !hidden[m]) ghost[i] = 1;
    }
    const color = (code: number): [number, number, number] =>
      code === REMOVED ? [0.96, 0.3, 0.3] : [palette[code * 3], palette[code * 3 + 1], palette[code * 3 + 2]];
    const a = greedyMesh(X, Y, Z, changed, color);
    const b = greedyMesh(X, Y, Z, ghost, () => [0.72, 0.74, 0.78]);
    return [{ changed: a, ghost: b }, [a.positions.buffer, a.normals.buffer, a.colors.buffer, b.positions.buffer, b.normals.buffer, b.colors.buffer]];
  },
  diff: ({ sid }) => {
    const d = diffOf(sid);
    const mask = d.mask.slice();
    return [{ mask, count: d.count }, [mask.buffer]];
  },
  count: ({ sid }) => {
    let out = counts.get(sid);
    if (!out) {
      const data = get(sid).vol.data;
      out = new Float64Array(256);
      for (let i = 0; i < data.length; i++) out[data[i]]++;
      counts.set(sid, out);
    }
    return [Array.from(out), []];
  },
};

self.onmessage = (e: MessageEvent<{ id: number; type: Kind; req: unknown }>) => {
  const { id, type, req } = e.data;
  try {
    const [result, transfer] = (handlers[type] as Handler<Kind>)(req as never);
    (self as unknown as Worker).postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
};
