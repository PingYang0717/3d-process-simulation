// plan v9 之前的 decodeVti（整個檔案先 TextDecoder、ascii 走 split）：vti.test.ts 的對照。
// VTK ImageData（.vti）讀寫，不加套件。
// 讀：CellData（沒有則 PointData）、8 種數值型別、ascii／inline base64／appended raw／appended base64、
//     vtkZLibDataCompressor（header UInt32／UInt64，用 DecompressionStream 解）。
// 寫：同 Extent／Spacing／Origin，UInt8 CellData，appended raw 不壓縮。
import type { Volume } from '../volume';

export interface VtiInfo {
  spacing: number[];
  origin: number[];
  arrayName: string;
  arrays: string[];
  source: 'CellData' | 'PointData';
  dtype: string;
  compressed: boolean;
  format: string;
}

type Ctor = { new (buf: ArrayBufferLike, off: number, len: number): ArrayLike<number | bigint> };
const TYPES: Record<string, { ctor: Ctor; size: number }> = {
  UInt8: { ctor: Uint8Array, size: 1 },
  Int8: { ctor: Int8Array, size: 1 },
  UInt16: { ctor: Uint16Array, size: 2 },
  Int16: { ctor: Int16Array, size: 2 },
  UInt32: { ctor: Uint32Array, size: 4 },
  Int32: { ctor: Int32Array, size: 4 },
  Float32: { ctor: Float32Array, size: 4 },
  Float64: { ctor: Float64Array, size: 8 },
  UInt64: { ctor: BigUint64Array, size: 8 },
  Int64: { ctor: BigInt64Array, size: 8 },
};

const attrs = (tag: string) => {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const nums = (s: string | undefined, def: string) => (s ?? def).trim().split(/\s+/).map(Number);

const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** base64 字串（已去空白）開頭解出至少 nBytes 個位元組所需的那一段。 */
const b64Chars = (nBytes: number) => 4 * Math.ceil(nBytes / 3);

async function inflate(bytes: Uint8Array) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/** header 讀一個整數：UInt32 或 UInt64。 */
const reader = (b: Uint8Array, hsize: number, le: boolean) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return (at: number) => (hsize === 8 ? Number(dv.getBigUint64(at, le)) : dv.getUint32(at, le));
};

/** 一個 binary 區塊（header ＋ 資料）解成資料位元組。 */
async function readBlock(b: Uint8Array, hsize: number, compressed: boolean, le: boolean) {
  const rd = reader(b, hsize, le);
  if (!compressed) return b.subarray(hsize, hsize + rd(0));
  const nb = rd(0);
  const blockSize = rd(hsize);
  const lastSize = rd(2 * hsize);
  const sizes = Array.from({ length: nb }, (_, i) => rd((3 + i) * hsize));
  const out = new Uint8Array(nb ? (nb - 1) * blockSize + (lastSize || blockSize) : 0);
  let at = (3 + nb) * hsize;
  let o = 0;
  for (const s of sizes) {
    const part = await inflate(b.subarray(at, at + s));
    out.set(part, o);
    o += part.length;
    at += s;
  }
  return out;
}

/**
 * base64 的區塊：未壓縮時 header 與資料是同一串；壓縮時 header 單獨一串、資料一串。
 * 只解需要的長度，後面接著別的陣列也不影響。
 */
function b64Block(text: string, hsize: number, compressed: boolean, le: boolean) {
  const s = text.replace(/\s+/g, '');
  const first = unb64(s.slice(0, b64Chars(compressed ? 3 * hsize : hsize)));
  const rd = reader(first, hsize, le);
  if (!compressed) return unb64(s.slice(0, b64Chars(hsize + rd(0))));
  const nb = rd(0);
  const headLen = b64Chars((3 + nb) * hsize);
  const head = unb64(s.slice(0, headLen));
  const hr = reader(head, hsize, le);
  let total = 0;
  for (let i = 0; i < nb; i++) total += hr((3 + i) * hsize);
  const body = unb64(s.slice(headLen, headLen + b64Chars(total)));
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/**
 * 讀 .vti。材質陣列挑名稱像 material／region／label／id 的，否則第一個。
 * 整數值 0～254 直接當編號（254 = VOID）；其他（小數、負數、超出範圍）依值重新編號，原本的 0 仍當空。
 */
export async function decodeVtiOld(buf: ArrayBuffer): Promise<{ vol: Volume; info: VtiInfo; valueMap: Map<number, number> }> {
  const bytes = new Uint8Array(buf);
  const text = new TextDecoder('latin1').decode(bytes);
  const appAt = text.indexOf('<AppendedData');
  const xml = appAt >= 0 ? text.slice(0, appAt) : text;

  const fileTag = xml.match(/<VTKFile\b[^>]*>/);
  const file = fileTag ? attrs(fileTag[0]) : null;
  if (!file || file.type !== 'ImageData') throw new Error('不是 VTK ImageData（.vti）');
  const le = (file.byte_order ?? 'LittleEndian') === 'LittleEndian';
  const hsize = (file.header_type ?? 'UInt32') === 'UInt64' ? 8 : 4;
  const compressed = !!file.compressor;
  if (compressed && !/ZLib/i.test(file.compressor)) throw new Error(`不支援的壓縮 ${file.compressor}（只支援 zlib）`);

  const image = attrs(xml.match(/<ImageData\b[^>]*>/)?.[0] ?? '');
  const piece = attrs(xml.match(/<Piece\b[^>]*>/)?.[0] ?? '');
  const ext = nums(image.WholeExtent ?? piece.Extent, '0 0 0 0 0 0');
  const spacing = nums(image.Spacing, '1 1 1');
  const origin = nums(image.Origin, '0 0 0');
  const [cx, cy, cz] = [ext[1] - ext[0], ext[3] - ext[2], ext[5] - ext[4]];

  const arraysIn = (section: string) => {
    const m = xml.match(new RegExp(`<${section}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${section}>)`));
    return [...(m?.[1] ?? '').matchAll(/<DataArray\b([^>]*?)(?:\/>|>([\s\S]*?)<\/DataArray>)/g)].map((d) => ({
      a: attrs(d[1]),
      body: d[2] ?? '',
    }));
  };
  let source: VtiInfo['source'] = 'CellData';
  let arrays = arraysIn('CellData');
  if (!arrays.length) {
    source = 'PointData';
    arrays = arraysIn('PointData');
  }
  if (!arrays.length) throw new Error('找不到 CellData 或 PointData 的 DataArray');
  const arr = arrays.find((d) => /material|region|mat|label|id/i.test(d.a.Name ?? '')) ?? arrays[0];
  const dtype = arr.a.type ?? 'UInt8';
  const T = TYPES[dtype];
  if (!T) throw new Error(`不支援的型別 ${dtype}`);
  if (Number(arr.a.NumberOfComponents ?? 1) !== 1) throw new Error('材質陣列必須是單分量');
  const format = arr.a.format ?? 'ascii';
  const [X, Y, Z] = source === 'CellData' ? [cx, cy, cz] : [cx + 1, cy + 1, cz + 1];
  const N = X * Y * Z;
  if (!(N > 0)) throw new Error(`Extent ${ext.join(' ')} 沒有任何格子`);

  let values: ArrayLike<number | bigint>;
  if (format === 'ascii') values = arr.body.trim().split(/\s+/).map(Number);
  else {
    let block: Uint8Array;
    if (format === 'binary') block = b64Block(arr.body, hsize, compressed, le);
    else {
      if (appAt < 0) throw new Error('format="appended" 但找不到 AppendedData');
      const enc = attrs(text.slice(appAt, text.indexOf('>', appAt))).encoding ?? 'base64';
      const start = text.indexOf('_', appAt) + 1 + Number(arr.a.offset ?? 0);
      block = enc === 'raw' ? bytes.subarray(start) : b64Block(text.slice(start, text.indexOf('<', start)), hsize, compressed, le);
    }
    const data = await readBlock(block, hsize, compressed, le);
    const aligned = data.byteOffset % T.size === 0 ? data : new Uint8Array(data);
    values = new T.ctor(aligned.buffer, aligned.byteOffset, Math.min(N, Math.floor(aligned.byteLength / T.size)));
  }
  if (values.length < N) throw new Error(`資料長度 ${values.length} 少於格數 ${N}`);

  const out = new Uint8Array(N);
  const valueMap = new Map<number, number>();
  let direct = true;
  for (let i = 0; i < N && direct; i++) {
    const v = Number(values[i]);
    if (v < 0 || v > 254 || v !== Math.round(v)) direct = false;
  }
  if (direct) for (let i = 0; i < N; i++) out[i] = Number(values[i]);
  else {
    // 依值重新編號：原本的 0 仍當空，其他從 1 起
    let next = 1;
    for (let i = 0; i < N; i++) {
      const v = Number(values[i]);
      let id = valueMap.get(v);
      if (id === undefined) {
        if (v === 0) id = 0;
        else {
          if (next > 253) throw new Error('超過 253 種不同的值，無法當材質編號');
          id = next++;
        }
        valueMap.set(v, id);
      }
      out[i] = id;
    }
  }
  return {
    vol: { X, Y, Z, data: out },
    info: { spacing, origin, arrayName: arr.a.Name ?? '', arrays: arrays.map((d) => d.a.Name ?? ''), source, dtype, compressed, format },
    valueMap,
  };
}

