// Web Worker：所有 O(N) 的運算（標記、重播操作＋relabel、網格、diff、計數）都在這裡，
// 主執行緒只畫畫面。一次處理一個請求，結果用 transfer 回傳。
import { type Labeled, type MeshData, type RawComp, type Volume, DIFF_BIT, countArray, greedyMesh, labelComponents } from './volume';
import { type EditState, type Op, replay } from './ops';

export interface Requests {
  label: { req: { vol: Volume }; res: { labels: Int32Array; raw: RawComp[] } };
  replay: {
    req: { from: EditState; orig: Volume; ops: Op[]; matNames: Record<number, string>; keyCounter: number };
    res: { data: Uint8Array; L: Labeled; keyCounter: number };
  };
  mesh: {
    req: {
      vol: Volume;
      /** 長度 256，1 = 不畫這個材質。 */
      hidden: Uint8Array;
      /** 改過的體素混紅、不和沒改過的合併。 */
      diff?: Uint8Array;
      /** 只畫這個 mask（選取、空洞層），用 tint 一色。 */
      only?: Uint8Array;
      /** 長度 768，每個材質的 RGB（0～1）。 */
      palette: Float32Array;
      tint?: [number, number, number];
    };
    res: MeshData;
  };
  diff: { req: { a: Uint8Array; b: Uint8Array }; res: { mask: Uint8Array; count: number } };
  count: { req: { data: Uint8Array }; res: number[] };
}
export type Kind = keyof Requests;

type Handler<K extends Kind> = (req: Requests[K]['req']) => [Requests[K]['res'], Transferable[]];

const handlers: { [K in Kind]: Handler<K> } = {
  label: ({ vol }) => {
    const r = labelComponents(vol);
    return [r, [r.labels.buffer]];
  },
  replay: ({ from, orig, ops, matNames, keyCounter }) => {
    let seq = keyCounter;
    const s = replay(from, ops, {
      orig,
      matName: (id) => matNames[id] ?? `材質 ${id}`,
      newKey: () => `c${seq++}`,
    });
    // 沒有任何 op 生效時 s 就是 from；複製一份，transfer 才不會動到呼叫端的陣列
    const data = s.vol.data === from.vol.data ? new Uint8Array(s.vol.data) : s.vol.data;
    const labels = s.L.labels === from.L.labels ? new Int32Array(s.L.labels) : s.L.labels;
    return [{ data, L: { labels, comps: s.L.comps }, keyCounter: seq }, [data.buffer, labels.buffer]];
  },
  mesh: ({ vol, hidden, diff, only, palette, tint }) => {
    const { X, Y, Z, data } = vol;
    const codes = new Uint16Array(X * Y * Z);
    if (only) for (let i = 0; i < codes.length; i++) codes[i] = only[i] ? 1 : 0;
    else
      for (let i = 0; i < codes.length; i++) {
        const m = data[i];
        if (m && !hidden[m]) codes[i] = diff?.[i] ? m | DIFF_BIT : m;
      }
    const m = greedyMesh(X, Y, Z, codes, (code) => {
      if (only) return tint ?? [0.09, 0.47, 1];
      const id = code & 255;
      const r = palette[id * 3];
      const g = palette[id * 3 + 1];
      const b = palette[id * 3 + 2];
      return code & DIFF_BIT ? [r * 0.35 + 0.65, g * 0.35 + 0.2, b * 0.35 + 0.2] : [r, g, b];
    });
    return [m, [m.positions.buffer, m.normals.buffer, m.colors.buffer]];
  },
  diff: ({ a, b }) => {
    const mask = new Uint8Array(a.length);
    let count = 0;
    for (let i = 0; i < a.length; i++)
      if (a[i] !== b[i]) {
        mask[i] = 1;
        count++;
      }
    return [{ mask, count }, [mask.buffer]];
  },
  count: ({ data }) => [countArray(data), []],
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
