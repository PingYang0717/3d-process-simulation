// Web Worker：所有 O(N) 的運算（標記、重播操作＋relabel、網格、diff、計數）都在這裡，主執行緒只畫畫面。
// 狀態常駐在 Worker：原始與每個 split 目前的結果用編號（sid）存著，主執行緒只送編號與小資料，
// 不必每一步都把幾百 MB 的陣列複製過來。結果先在 Worker 裡複製一份（memcpy）再 transfer 回去。
import { type BBox, type Comp, type MeshData, type RawComp, type Volume, type ZRange, DIFF_BIT, greedyMesh, labelComponents } from './volume';
import { type Op, replay } from './ops';

/** 網格只畫一部分：選取（結構編號 ∩ z 範圍，box = 它們的外框）或某個材質（空洞層）。 */
export type Only = { comps: number[]; zRange: ZRange; box: BBox } | { mat: number };

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
    };
    res: MeshData;
  };
  diff: { req: { sid: number }; res: { mask: Uint8Array; count: number } };
  count: { req: { sid: number }; res: number[] };
}
export type Kind = keyof Requests;

interface State {
  vol: Volume;
  labels: Int32Array;
}
const store = new Map<number, State>();
const diffs = new Map<number, { mask: Uint8Array; count: number }>();
let origSid = 0;

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
    const { labels, raw } = labelComponents(vol);
    store.set(sid, { vol, labels });
    origSid = sid;
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
    return [null, []];
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
  mesh: ({ sid, hidden, diff, only, palette, tint }) => {
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
        const z0 = Math.max(only.box.z0, only.zRange[0]);
        const z1 = Math.min(only.box.z1, only.zRange[1]);
        box = z0 <= z1 ? { ...only.box, z0, z1 } : null;
      }
      const m = box ? meshInBox(vol, box, test, tint ?? [0.09, 0.47, 1]) : emptyMesh();
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
  diff: ({ sid }) => {
    const d = diffOf(sid);
    const mask = d.mask.slice();
    return [{ mask, count: d.count }, [mask.buffer]];
  },
  count: ({ sid }) => {
    const data = get(sid).vol.data;
    const out = new Float64Array(256);
    for (let i = 0; i < data.length; i++) out[data[i]]++;
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
