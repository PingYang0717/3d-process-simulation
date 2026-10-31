// VTK ImageData（.vti）讀寫，不加套件。
// 讀：CellData（沒有則 PointData）、8 種數值型別、ascii／inline base64／appended raw／appended base64、
//     vtkZLibDataCompressor（header UInt32／UInt64，用 DecompressionStream 解）。
// 寫：同 Extent／Spacing／Origin，UInt8 CellData，appended raw 不壓縮。
import type { Volume } from './volume';


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

const APPENDED = new TextEncoder().encode('<AppendedData');
/** needle 在 hay 裡第一次出現的位置（逐位元組比對；沒有回傳 −1）。 */
function findBytes(hay: Uint8Array, needle: Uint8Array) {
  const first = needle[0];
  for (let i = hay.indexOf(first); i >= 0 && i <= hay.length - needle.length; i = hay.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/**
 * ascii 資料（plan v9 P16）：逐字元掃描，不 split 成幾千萬個字串。純整數直接累加；
 * 有小數點、指數、nan 之類的那一個 token 才交給 Number()。和 split(/\s+/).map(Number) 結果相同。
 */
export function parseAscii(body: string, N: number): Float64Array {
  const out = new Float64Array(N);
  let n = 0;
  const L = body.length;
  let i = 0;
  while (i < L && n < N) {
    let c = body.charCodeAt(i);
    // 空白：space、\t、\n、\r、\f、\v
    if (c === 32 || (c >= 9 && c <= 13)) {
      i++;
      continue;
    }
    const s = i;
    let neg = false;
    if (c === 45 /* - */ || c === 43 /* + */) {
      neg = c === 45;
      i++;
    }
    let v = 0;
    let digits = 0;
    let simple = true;
    for (; i < L; i++) {
      c = body.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        v = v * 10 + (c - 48);
        digits++;
      } else if (c === 32 || (c >= 9 && c <= 13)) break;
      else simple = false;
    }
    out[n++] = simple && digits && digits < 16 ? (neg ? -v : v) : Number(body.slice(s, i));
  }
  if (n < N) return out.subarray(0, n);
  return out;
}

/** 一個 DataArray：屬性、內文（ascii／inline base64）、在 XML 字串裡的位置（latin1，和位元組一一對應）。 */
export interface ArrDesc {
  a: Record<string, string>;
  body: string;
  section: 'CellData' | 'PointData' | 'FieldData';
  /** 整個 <DataArray …>…</DataArray> 的起止（xml 字串索引）。 */
  start: number;
  end: number;
  /** 開始標籤的結束位置（> 之後）；自閉合時＝end。 */
  tagEnd: number;
}

/** 解析過的標頭：之後讀任何一個陣列、或照原樣寫回都從這裡出發。 */
export interface VtiHead {
  bytes: Uint8Array;
  xml: string;
  appAt: number;
  le: boolean;
  hsize: number;
  compressed: boolean;
  ext: number[];
  spacing: number[];
  origin: number[];
  sections: Record<ArrDesc['section'], ArrDesc[]>;
}

export function parseHead(buf: ArrayBuffer | Uint8Array): VtiHead {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  // plan v9 P16：先在位元組裡找 <AppendedData，只把前面那段（XML 標頭）解成字串；後面幾百 MB 的資料不必變字串。
  // 找不到（ascii／inline base64）就整檔解（資料本來就在 XML 裡）。
  const appAt = findBytes(bytes, APPENDED);
  const xml = new TextDecoder('latin1').decode(appAt >= 0 ? bytes.subarray(0, appAt) : bytes);
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
  const arraysIn = (section: ArrDesc['section']): ArrDesc[] => {
    const re = new RegExp(`<${section}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${section}>)`);
    const m = re.exec(xml);
    if (!m || m[1] === undefined) return [];
    const inner = m[1];
    const base = m.index + m[0].indexOf(inner, m[0].indexOf('>') + 1);
    return [...inner.matchAll(/<DataArray\b([^>]*?)(\/>|>([\s\S]*?)<\/DataArray>)/g)].map((d) => {
      const start = base + d.index!;
      const tagLen = d[0].length - (d[2] === '/>' ? 0 : d[2].length - 1);
      return { a: attrs(d[1]), body: d[3] ?? '', section, start, end: start + d[0].length, tagEnd: start + (d[2] === '/>' ? d[0].length : tagLen) };
    });
  };
  return { bytes, xml, appAt, le, hsize, compressed, ext, spacing, origin, sections: { CellData: arraysIn('CellData'), PointData: arraysIn('PointData'), FieldData: arraysIn('FieldData') } };
}

/** appended 區的編碼（raw／base64）與 '_' 之後第一個位元組的位置。 */
function appendedInfo(h: VtiHead) {
  if (h.appAt < 0) throw new Error('format="appended" 但找不到 AppendedData');
  const latin1 = new TextDecoder('latin1');
  const tagEnd = h.bytes.indexOf(0x3e /* > */, h.appAt);
  const enc = attrs(latin1.decode(h.bytes.subarray(h.appAt, tagEnd))).encoding ?? 'base64';
  const data = h.bytes.indexOf(0x5f /* _ */, h.appAt) + 1;
  return { enc, data };
}

/** 一個 binary 區塊在 appended 區裡佔多少位元組（raw）或字元（base64）。 */
function blockLength(h: VtiHead, enc: string, at: number): number {
  const { bytes, hsize, compressed, le } = h;
  if (enc === 'raw') {
    const rd = reader(bytes.subarray(at, at + (compressed ? 3 * hsize : hsize)), hsize, le);
    if (!compressed) return hsize + rd(0);
    const nb = rd(0);
    const head = reader(bytes.subarray(at, at + (3 + nb) * hsize), hsize, le);
    let total = 0;
    for (let i = 0; i < nb; i++) total += head((3 + i) * hsize);
    return (3 + nb) * hsize + total;
  }
  const latin1 = new TextDecoder('latin1');
  const peek = (n: number) => latin1.decode(bytes.subarray(at, at + n));
  const first = unb64(peek(b64Chars(compressed ? 3 * hsize : hsize)));
  const rd = reader(first, hsize, le);
  if (!compressed) return b64Chars(hsize + rd(0));
  const nb = rd(0);
  const headLen = b64Chars((3 + nb) * hsize);
  const hr = reader(unb64(peek(headLen)), hsize, le);
  let total = 0;
  for (let i = 0; i < nb; i++) total += hr((3 + i) * hsize);
  return headLen + b64Chars(total);
}

/** 陣列的值（count 省略＝整個區塊）。ascii 回 Float64Array；binary 回該型別的 typed array（可能是原始位元組的 view）。 */
export async function readValues(h: VtiHead, d: ArrDesc, count?: number): Promise<ArrayLike<number | bigint>> {
  const dtype = d.a.type ?? 'UInt8';
  const T = dtype === 'String' || dtype === 'Char' ? TYPES.UInt8 : TYPES[dtype];
  if (!T) throw new Error(`不支援的型別 ${dtype}`);
  const format = d.a.format ?? 'ascii';
  if (format === 'ascii') return parseAscii(d.body, count ?? (d.body.match(/\S+/g)?.length ?? 0));
  const data = await readBytes(h, d);
  const aligned = data.byteOffset % T.size === 0 ? data : new Uint8Array(data);
  const n = Math.floor(aligned.byteLength / T.size);
  return new T.ctor(aligned.buffer, aligned.byteOffset, count === undefined ? n : Math.min(count, n));
}

/** binary／appended 陣列解成資料位元組（已解壓）。 */
async function readBytes(h: VtiHead, d: ArrDesc): Promise<Uint8Array> {
  const { bytes, hsize, compressed, le } = h;
  const format = d.a.format ?? 'ascii';
  let block: Uint8Array;
  if (format === 'binary') block = b64Block(d.body, hsize, compressed, le);
  else {
    const { enc, data } = appendedInfo(h);
    const start = data + Number(d.a.offset ?? 0);
    if (enc === 'raw') block = bytes.subarray(start);
    else {
      const end = bytes.indexOf(0x3c /* < */, start);
      block = b64Block(new TextDecoder('latin1').decode(bytes.subarray(start, end < 0 ? bytes.length : end)), hsize, compressed, le);
    }
  }
  return readBlock(block, hsize, compressed, le);
}

/** 名稱像 material_1、material 2、Material3 的單分量陣列（plan v11 §4.0）。 */
export const FRACTION_RE = /^material[_ ]?(\d+)$/i;

/** 比例陣列：名稱、對應的材質編號。 */
export interface FractionArray {
  name: string;
  id: number;
  dtype: string;
}

/** FieldData 材質表的一筆。 */
export interface FieldMaterial {
  code: number;
  name?: string;
  color?: string;
}

export interface VtiInfo {
  spacing: number[];
  origin: number[];
  arrayName: string;
  arrays: string[];
  source: 'CellData' | 'PointData';
  dtype: string;
  compressed: boolean;
  format: string;
  /** PointData（或 CellData）裡每個材質一個比例陣列時：取最大者（plan v11 §4.0）。 */
  fractions?: FractionArray[];
  /** FieldData 材質表（讀得到才有）。 */
  fieldData?: FieldMaterial[];
}

/** 上傳面板的偵測結果（不解資料，只看標頭；FieldData 很小，順便讀）。 */
export interface VtiInspect {
  source: 'CellData' | 'PointData';
  dims: [number, number, number];
  arrays: { name: string; dtype: string; comps: number; matched: number | null }[];
  fractions: FractionArray[];
  fieldData: FieldMaterial[] | null;
  /** FieldData 有、但缺欄位（沒有代碼或沒有名稱）。 */
  fieldWarn: string | null;
}

const isIntType = (t: string) => /^U?Int(8|16|32|64)$/.test(t);

/** 數值或字串 → #rrggbb；認不得回 undefined。 */
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
function colorOf(v: number[] | string | undefined, unit01: boolean): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') {
    const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
    return m ? `#${m[1].toLowerCase()}` : undefined;
  }
  if (v.length < 3 || v.some((x) => !Number.isFinite(x))) return undefined;
  const k = unit01 ? 255 : 1;
  return `#${hex2(v[0] * k)}${hex2(v[1] * k)}${hex2(v[2] * k)}`;
}

/** String 陣列（或 UInt8 以 0 結尾）→ 字串；ascii 的 String 陣列是字元碼（VTK 慣例），不是數字就照空白切。 */
async function readStrings(h: VtiHead, d: ArrDesc): Promise<string[]> {
  if ((d.a.format ?? 'ascii') === 'ascii' && /[^\s\d.+-]/.test(d.body)) return d.body.trim().split(/\s+/);
  const v = await readValues(h, d);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < v.length; i++) {
    const c = Number(v[i]);
    if (c === 0) {
      out.push(cur);
      cur = '';
    } else cur += String.fromCharCode(c);
  }
  if (cur) out.push(cur);
  return out.map((s) => {
    try {
      return decodeURIComponent(escape(s));
    } catch {
      return s;
    }
  });
}

/** FieldData 材質表的三個欄位：代碼、名稱、顏色（找不到的是 undefined）。 */
function fieldColumns(h: VtiHead) {
  const fd = h.sections.FieldData;
  const comps = (d: ArrDesc) => Number(d.a.NumberOfComponents ?? 1);
  const isStr = (d: ArrDesc) => d.a.type === 'String' || d.a.type === 'Char';
  const names =
    fd.find((d) => isStr(d) && /name|名/i.test(d.a.Name ?? '')) ??
    fd.find((d) => (isStr(d) || d.a.type === 'UInt8' || d.a.type === 'Int8') && /name|名/i.test(d.a.Name ?? '')) ??
    fd.find((d) => isStr(d) && !/colou?r|色/i.test(d.a.Name ?? ''));
  const codes = fd.find((d) => d !== names && isIntType(d.a.type ?? '') && comps(d) === 1 && /code|id|index|number|num|編號|代碼/i.test(d.a.Name ?? '')) ?? fd.find((d) => d !== names && isIntType(d.a.type ?? '') && comps(d) === 1);
  const colors = fd.find((d) => d !== names && d !== codes && (/colou?r|rgb|色/i.test(d.a.Name ?? '') || comps(d) >= 3));
  return { names, codes, colors };
}

/** 讀 FieldData 材質表；沒有 FieldData 回 null。fallbackCodes＝沒有代碼欄時依序對應的編號（比例陣列的編號）。 */
async function readFieldData(h: VtiHead, fallbackCodes: number[]): Promise<{ mats: FieldMaterial[] | null; warn: string | null }> {
  if (!h.sections.FieldData.length) return { mats: null, warn: null };
  const { names, codes, colors } = fieldColumns(h);
  if (!names && !colors) return { mats: null, warn: 'FieldData 沒有材質名稱或顏色欄' };
  const nameList = names ? await readStrings(h, names) : [];
  const codeList = codes ? Array.from(await readValues(h, codes), Number) : null;
  let colorList: (number[] | string)[] = [];
  if (colors) {
    if (colors.a.type === 'String') colorList = await readStrings(h, colors);
    else {
      const nc = Number(colors.a.NumberOfComponents ?? 3);
      const v = Array.from(await readValues(h, colors), Number);
      for (let i = 0; i + nc <= v.length; i += nc) colorList.push(v.slice(i, i + 3));
    }
  }
  const unit01 = colorList.every((c) => typeof c === 'string' || c.every((x) => x <= 1));
  const n = Math.max(nameList.length, colorList.length, codeList?.length ?? 0);
  const code = (i: number) => codeList?.[i] ?? fallbackCodes[i] ?? i + 1;
  const mats: FieldMaterial[] = Array.from({ length: n }, (_, i) => ({ code: code(i), name: nameList[i] || undefined, color: colorOf(colorList[i], unit01) }));
  const warn = !codeList ? `FieldData 沒有代碼欄，名稱依序對應${fallbackCodes.length ? '比例陣列' : ' 1、2、3…'}` : !names ? 'FieldData 沒有名稱欄' : null;
  return { mats, warn };
}

/** 材質陣列所在的段落：CellData 有就用它，否則 PointData（比例陣列兩邊都找，先 PointData）。 */
function pickSection(h: VtiHead) {
  const single = (d: ArrDesc) => Number(d.a.NumberOfComponents ?? 1) === 1;
  for (const sec of ['PointData', 'CellData'] as const) {
    const fr = h.sections[sec].filter((d) => single(d) && FRACTION_RE.test(d.a.Name ?? ''));
    if (fr.length) return { source: sec, arrays: h.sections[sec], fractions: fr };
  }
  if (h.sections.CellData.length) return { source: 'CellData' as const, arrays: h.sections.CellData, fractions: [] };
  return { source: 'PointData' as const, arrays: h.sections.PointData, fractions: [] };
}

const dimsOf = (h: VtiHead, source: 'CellData' | 'PointData'): [number, number, number] => {
  const [cx, cy, cz] = [h.ext[1] - h.ext[0], h.ext[3] - h.ext[2], h.ext[5] - h.ext[4]];
  return source === 'CellData' ? [cx, cy, cz] : [cx + 1, cy + 1, cz + 1];
};

/** 比例陣列的編號：名稱裡的數字（material_254＝VOID）；0 或超過 254 的改用沒用到的編號（0 是 Air）。 */
function fractionIds(list: { name: string; id: number | null; dtype: string }[]): FractionArray[] {
  const used = new Set(list.map((f) => f.id).filter((v): v is number => v !== null && v > 0 && v <= 254));
  let next = 1;
  const free = () => {
    while (used.has(next)) next++;
    if (next > 253) throw new Error('超過 253 種材質，無法當材質編號');
    used.add(next);
    return next;
  };
  const seen = new Set<number>();
  return list.map((f) => {
    let id = f.id !== null && f.id > 0 && f.id <= 254 && !seen.has(f.id) ? f.id : free();
    if (seen.has(id)) id = free();
    seen.add(id);
    return { name: f.name, id, dtype: f.dtype };
  });
}

/** 上傳面板用：只看標頭（和 FieldData），列出偵測結果。 */
export async function inspectVti(buf: ArrayBuffer): Promise<VtiInspect> {
  const h = parseHead(buf);
  const sec = pickSection(h);
  const fractions = fractionIds(sec.fractions.map((d) => ({ name: d.a.Name ?? '', id: Number((d.a.Name ?? '').match(FRACTION_RE)![1]), dtype: d.a.type ?? 'Float32' })));
  const fd = await readFieldData(h, fractions.map((f) => f.id));
  return {
    source: sec.source,
    dims: dimsOf(h, sec.source),
    arrays: sec.arrays.map((d) => {
      const m = (d.a.Name ?? '').match(FRACTION_RE);
      return { name: d.a.Name ?? '', dtype: d.a.type ?? 'UInt8', comps: Number(d.a.NumberOfComponents ?? 1), matched: m ? fractions.find((f) => f.name === d.a.Name)?.id ?? null : null };
    }),
    fractions,
    fieldData: fd.mats,
    fieldWarn: fd.warn,
  };
}

export interface DecodeOptions {
  /** 手動指定的比例陣列（陣列名 → 材質編號）；有給就用它取代名稱規則（上傳面板的手動對應）。空陣列＝不用比例陣列。 */
  fractions?: { name: string; id: number }[];
}

/**
 * 讀 .vti。
 * - 比例陣列（PointData／CellData 裡名稱像 material_k、或手動指定）：每一點取比例最大者（argmax；平手取編號小的；
 *   全為 0 → Air）。只有一個比例陣列時以 ≥ 0.5 判定（plan v11 §4.0）。FieldData 有材質表時一併讀（info.fieldData）。
 * - 否則：材質陣列挑名稱像 material／region／label／id 的，否則第一個；整數值 0～254 直接當編號（254 = VOID），
 *   其他（小數、負數、超出範圍）依值重新編號，原本的 0 仍當空。
 */
export async function decodeVti(buf: ArrayBuffer, opts: DecodeOptions = {}): Promise<{ vol: Volume; info: VtiInfo; valueMap: Map<number, number> }> {
  const h = parseHead(buf);
  const sec = pickSection(h);
  let source = sec.source;
  let arrays = sec.arrays;
  let fracDescs: { d: ArrDesc; id: number | null }[] = sec.fractions.map((d) => ({ d, id: Number((d.a.Name ?? '').match(FRACTION_RE)![1]) }));
  if (opts.fractions) {
    const all = [...h.sections.PointData.map((d) => ['PointData', d] as const), ...h.sections.CellData.map((d) => ['CellData', d] as const)];
    fracDescs = [];
    for (const f of opts.fractions) {
      const hit = all.find(([, d]) => d.a.Name === f.name);
      if (!hit) throw new Error(`找不到陣列 ${f.name}`);
      source = hit[0];
      arrays = h.sections[source];
      fracDescs.push({ d: hit[1], id: f.id });
    }
  }
  if (!arrays.length) throw new Error('找不到 CellData 或 PointData 的 DataArray');
  const [X, Y, Z] = dimsOf(h, source);
  const N = X * Y * Z;
  if (!(N > 0)) throw new Error(`Extent ${h.ext.join(' ')} 沒有任何格子`);
  const base = { spacing: h.spacing, origin: h.origin, arrays: arrays.map((d) => d.a.Name ?? ''), source, compressed: h.compressed };

  if (fracDescs.length) {
    const fractions = fractionIds(fracDescs.map(({ d, id }) => ({ name: d.a.Name ?? '', id, dtype: d.a.type ?? 'Float32' })));
    // 編號小的先處理：平手時只有「嚴格大於」才換，所以編號小的留下
    const order = fractions.map((f, k) => ({ f, d: fracDescs[k].d })).sort((p, q) => p.f.id - q.f.id);
    const out = new Uint8Array(N);
    const best = new Float32Array(N);
    const one = order.length === 1;
    for (const { f, d } of order) {
      const v = await readValues(h, d, N);
      if (v.length < N) throw new Error(`${f.name} 長度 ${v.length} 少於點數 ${N}`);
      const big = v instanceof BigInt64Array || v instanceof BigUint64Array;
      for (let i = 0; i < N; i++) {
        const x = big ? Number(v[i]) : (v[i] as number);
        if (one ? x >= 0.5 : x > best[i]) {
          best[i] = x;
          out[i] = f.id;
        }
      }
    }
    const fd = await readFieldData(h, fractions.map((f) => f.id));
    const first = order[0].d;
    return {
      vol: { X, Y, Z, data: out },
      info: { ...base, arrayName: fractions[0].name, dtype: first.a.type ?? 'Float32', format: first.a.format ?? 'ascii', fractions, ...(fd.mats ? { fieldData: fd.mats } : {}) },
      valueMap: new Map(),
    };
  }

  const arr = arrays.find((d) => /material|region|mat|label|id/i.test(d.a.Name ?? '')) ?? arrays[0];
  const dtype = arr.a.type ?? 'UInt8';
  if (!TYPES[dtype]) throw new Error(`不支援的型別 ${dtype}`);
  if (Number(arr.a.NumberOfComponents ?? 1) !== 1) throw new Error('材質陣列必須是單分量');
  const format = arr.a.format ?? 'ascii';
  const values = await readValues(h, arr, N);
  if (values.length < N) throw new Error(`資料長度 ${values.length} 少於格數 ${N}`);

  const out = new Uint8Array(N);
  const valueMap = new Map<number, number>();
  // 整數 0～254 直接當編號；型別化陣列的檢查不經過 Number()（BigInt 陣列才要）
  const isBig = values instanceof BigInt64Array || values instanceof BigUint64Array;
  let direct = true;
  if (isBig)
    for (let i = 0; i < N && direct; i++) {
      const v = Number(values[i]);
      if (v < 0 || v > 254 || v !== Math.round(v)) direct = false;
    }
  else {
    const vs = values as ArrayLike<number>;
    for (let i = 0; i < N; i++) {
      const v = vs[i];
      if (!(v >= 0 && v <= 254 && v === Math.round(v))) {
        direct = false;
        break;
      }
    }
  }
  if (direct) {
    if (values instanceof Uint8Array) out.set(values.subarray(0, N));
    else if (isBig) for (let i = 0; i < N; i++) out[i] = Number(values[i]);
    else for (let i = 0, vs = values as ArrayLike<number>; i < N; i++) out[i] = vs[i];
  } else {
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
    info: { ...base, arrayName: arr.a.Name ?? '', dtype, format },
    valueMap,
  };
}

/** 寫 .vti：UInt8 CellData，appended raw、UInt64 header，不壓縮。 */
export function encodeVti(vol: Volume, spacing: number[] = [1, 1, 1], origin: number[] = [0, 0, 0], name = 'material') {
  const ext = `0 ${vol.X} 0 ${vol.Y} 0 ${vol.Z}`;
  const head = new TextEncoder().encode(`<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt64">
  <ImageData WholeExtent="${ext}" Origin="${origin.join(' ')}" Spacing="${spacing.join(' ')}">
    <Piece Extent="${ext}">
      <PointData/>
      <CellData Scalars="${name}">
        <DataArray type="UInt8" Name="${name}" NumberOfComponents="1" format="appended" offset="0"/>
      </CellData>
    </Piece>
  </ImageData>
  <AppendedData encoding="raw">
_`);
  const tail = new TextEncoder().encode('\n  </AppendedData>\n</VTKFile>\n');
  const out = new Uint8Array(head.length + 8 + vol.data.length + tail.length);
  out.set(head);
  new DataView(out.buffer).setBigUint64(head.length, BigInt(vol.data.length), true);
  out.set(vol.data, head.length + 8);
  out.set(tail, head.length + 8 + vol.data.length);
  return out;
}

// ---- 與輸入同格式匯出（plan v11 §4.0、§9 D15）----

const latin1Bytes = (s: string) => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
  return u;
};
const catBytes = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** base64（分段，避免大陣列一次 String.fromCharCode 爆堆疊）。 */
export function b64(u: Uint8Array) {
  let out = '';
  const STEP = 3 * 8192;
  for (let i = 0; i < u.length; i += STEP) {
    const part = u.subarray(i, Math.min(u.length, i + STEP));
    let s = '';
    for (let k = 0; k < part.length; k++) s += String.fromCharCode(part[k]);
    out += btoa(s);
  }
  return out;
}

async function deflate(u: Uint8Array) {
  if (typeof CompressionStream === 'undefined') throw new Error('這個瀏覽器不支援 CompressionStream，無法寫壓縮的 .vti；請改用「單一編號 .vti」匯出');
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  void w.write(u);
  void w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** 整數寫進 header（UInt32／UInt64）。 */
const putInts = (vals: number[], hsize: number, le: boolean) => {
  const out = new Uint8Array(vals.length * hsize);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => (hsize === 8 ? dv.setBigUint64(i * hsize, BigInt(v), le) : dv.setUint32(i * hsize, v, le)));
  return out;
};

/** 資料位元組 → 區塊（header＋資料）；壓縮時每 blockSize 一塊、各自 zlib。 */
async function encodeBlock(data: Uint8Array, h: VtiHead, blockSize: number) {
  if (!h.compressed) return { head: putInts([data.length], h.hsize, h.le), body: data };
  const nb = data.length ? Math.ceil(data.length / blockSize) : 0;
  const parts: Uint8Array[] = [];
  for (let k = 0; k < nb; k++) parts.push(await deflate(data.subarray(k * blockSize, Math.min(data.length, (k + 1) * blockSize))));
  const last = nb ? data.length - (nb - 1) * blockSize : 0;
  return { head: putInts([nb, blockSize, last, ...parts.map((p) => p.length)], h.hsize, h.le), body: catBytes(parts) };
}
/** 區塊的文字形式（inline binary／appended base64）：壓縮時 header 與資料各自一串（VTK 慣例）。 */
const blockText = (b: { head: Uint8Array; body: Uint8Array }, compressed: boolean) => (compressed ? b64(b.head) + b64(b.body) : b64(catBytes([b.head, b.body])));

/** 原檔這個陣列壓縮時的 blockSize（沒壓縮或讀不到回 32768）。 */
function blockSizeOf(h: VtiHead, d: ArrDesc): number {
  if (!h.compressed) return 32768;
  const format = d.a.format ?? 'ascii';
  let head: Uint8Array;
  if (format === 'binary') head = unb64(d.body.replace(/\s+/g, '').slice(0, b64Chars(3 * h.hsize)));
  else if (format === 'appended') {
    const { enc, data } = appendedInfo(h);
    const at = data + Number(d.a.offset ?? 0);
    head = enc === 'raw' ? h.bytes.subarray(at, at + 3 * h.hsize) : unb64(new TextDecoder('latin1').decode(h.bytes.subarray(at, at + b64Chars(3 * h.hsize))));
  } else return 32768;
  return reader(head, h.hsize, h.le)(h.hsize) || 32768;
}

/** 開始標籤裡設一個屬性（沒有就加在最後）。 */
function setAttr(tag: string, name: string, value: string) {
  const re = new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`);
  if (re.test(tag)) return tag.replace(re, `$1${value}$2`);
  return tag.replace(/\s*(\/?>)$/, ` ${name}="${value}"$1`);
}

type Typed = Exclude<ReturnType<typeof makeTyped>, never>;
function makeTyped(dtype: string, n: number) {
  const T = TYPES[dtype] ?? TYPES.Float32;
  const buf = new ArrayBuffer(n * T.size);
  return new (T.ctor as unknown as { new (b: ArrayBuffer): ArrayLike<number | bigint> & { [i: number]: number | bigint; buffer: ArrayBuffer } })(buf);
}
const typedBytes = (t: Typed) => new Uint8Array(t.buffer);
const isBigType = (dtype: string) => dtype === 'UInt64' || dtype === 'Int64';

/** ascii 內文：只換 changed 的那幾個 token，其他字元原封不動。 */
function rewriteAscii(body: string, changed: Uint8Array, value: (i: number) => string) {
  const out: string[] = [];
  const re = /\S+/g;
  let last = 0;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (i < changed.length && changed[i]) {
      out.push(body.slice(last, m.index), value(i));
      last = m.index + m[0].length;
    }
    i++;
  }
  out.push(body.slice(last));
  return out.join('');
}

export interface ExportMaterial {
  id: number;
  name: string;
  color: string;
}

/**
 * 寫 .vti，和輸入一模一樣（plan v11 §4.0）：XML 結構、Extent／Spacing／Origin、比例陣列的名稱與型別、FieldData、
 * 編碼與壓縮都照原檔。沒改到的點每個陣列 bit-identical（ascii 連文字都不動）；改到的點新材質的比例寫 1、其他 0（§9 D16）；
 * 新出現的材質補一個 material_{id} 陣列（同型別，未改點全 0），FieldData 有材質表時補一筆。
 * 一次只解一個比例陣列（§9 D18）。orig＝原檔位元組；data／origData＝這個 split 與原始的材質編號。
 */
export async function encodeVtiLike(orig: ArrayBuffer | Uint8Array, fractions: FractionArray[], data: Uint8Array, origData: Uint8Array, mats: ExportMaterial[]): Promise<Uint8Array> {
  const h = parseHead(orig);
  const N = data.length;
  const changed = new Uint8Array(N);
  const chg: number[] = [];
  for (let i = 0; i < N; i++)
    if (data[i] !== origData[i]) {
      changed[i] = 1;
      chg.push(i);
    }
  const descOf = (name: string) => h.sections.PointData.find((d) => d.a.Name === name) ?? h.sections.CellData.find((d) => d.a.Name === name);
  const fr = fractions.map((f) => ({ f, d: descOf(f.name)! }));
  if (fr.some((x) => !x.d)) throw new Error('原檔裡找不到比例陣列，無法照原格式匯出');
  const known = new Set(fractions.map((f) => f.id));
  const newIds = [...new Set(chg.map((i) => data[i]))].filter((id) => id !== 0 && !known.has(id)).sort((a, b) => a - b);

  /** 每個要改的陣列：新內文（inline）或新區塊位元組／文字（appended）；attrs＝要改的屬性。 */
  const edits = new Map<ArrDesc, { body?: string; block?: Uint8Array; attrs?: Record<string, string> }>();
  const { enc, data: appData } = h.appAt >= 0 ? appendedInfo(h) : { enc: 'raw', data: -1 };
  /** 依原陣列的格式把新值寫成內文或 appended 區塊。 */
  const encodeLike = async (d: ArrDesc, bytes: Uint8Array) => {
    const format = d.a.format ?? 'ascii';
    const b = await encodeBlock(bytes, h, blockSizeOf(h, d));
    if (format === 'binary') return { body: blockText(b, h.compressed) };
    return { block: enc === 'raw' ? catBytes([b.head, b.body]) : latin1Bytes(blockText(b, h.compressed)) };
  };

  // 1. 比例陣列：改到的點 1／0
  for (const { f, d } of fr) {
    if (!chg.length) break;
    const dtype = d.a.type ?? 'Float32';
    if ((d.a.format ?? 'ascii') === 'ascii') {
      edits.set(d, { body: rewriteAscii(d.body, changed, (i) => (data[i] === f.id ? '1' : '0')) });
      continue;
    }
    const raw = (await readBytes(h, d)).slice();
    const T = TYPES[dtype];
    const t = new (T.ctor as unknown as { new (b: ArrayBufferLike, o: number, n: number): { [i: number]: number | bigint } })(raw.buffer, 0, Math.floor(raw.length / T.size));
    const big = isBigType(dtype);
    for (const i of chg) t[i] = big ? BigInt(data[i] === f.id ? 1 : 0) : data[i] === f.id ? 1 : 0;
    edits.set(d, await encodeLike(d, raw));
  }

  // 2. 新材質：補比例陣列（同第一個比例陣列的型別與格式）
  const first = fr[0].d;
  const dtype0 = first.a.type ?? 'Float32';
  const added: { name: string; tag: string; body?: string; block?: Uint8Array }[] = [];
  for (const id of newIds) {
    const name = `material_${id}`;
    const fmt = first.a.format ?? 'ascii';
    const tagAttrs = `type="${dtype0}" Name="${name}" NumberOfComponents="1" format="${fmt}"`;
    if (fmt === 'ascii') {
      const parts = new Array<string>(N);
      for (let i = 0; i < N; i++) parts[i] = data[i] === id ? '1' : '0';
      added.push({ name, tag: `<DataArray ${tagAttrs}>`, body: parts.join(' ') });
      continue;
    }
    const t = makeTyped(dtype0, N);
    const big = isBigType(dtype0);
    for (const i of chg) if (data[i] === id) (t as { [i: number]: number | bigint })[i] = big ? 1n : 1;
    const e = await encodeLike(first, typedBytes(t));
    added.push({ name, tag: fmt === 'binary' ? `<DataArray ${tagAttrs}>` : `<DataArray ${tagAttrs} offset="0"/>`, ...e });
  }

  // 3. FieldData：新材質補一筆（代碼、名稱、顏色）
  if (newIds.length && h.sections.FieldData.length) {
    const { names, codes, colors } = fieldColumns(h);
    const newMats = newIds.map((id) => mats.find((m) => m.id === id) ?? { id, name: `材質 ${id}`, color: '#808080' });
    const tuples = (d: ArrDesc, add: number) => (d.a.NumberOfTuples ? { NumberOfTuples: String(Number(d.a.NumberOfTuples) + add) } : undefined);
    const rewrite = async (d: ArrDesc, asciiAppend: string, bytesAppend: Uint8Array) => {
      const fmt = d.a.format ?? 'ascii';
      const attrsUp = tuples(d, newMats.length);
      if (fmt === 'ascii') {
        const trimmed = d.body.replace(/\s+$/, '');
        const ws = d.body.slice(trimmed.length);
        edits.set(d, { body: `${trimmed} ${asciiAppend}${ws}`, attrs: attrsUp });
        return;
      }
      const old = await readBytes(h, d);
      edits.set(d, { ...(await encodeLike(d, catBytes([old, bytesAppend]))), attrs: attrsUp });
    };
    if (codes) {
      const ct = codes.a.type ?? 'Int32';
      const t = makeTyped(ct, newMats.length);
      newMats.forEach((m, k) => ((t as { [i: number]: number | bigint })[k] = isBigType(ct) ? BigInt(m.id) : m.id));
      await rewrite(codes, newMats.map((m) => m.id).join(' '), typedBytes(t));
    }
    if (names) {
      const utf8 = (s: string) => unescape(encodeURIComponent(s));
      const asWords = (names.a.format ?? 'ascii') === 'ascii' && /[^\s\d.+-]/.test(names.body);
      const strBytes = latin1Bytes(newMats.map((m) => utf8(m.name) + '\0').join(''));
      await rewrite(names, asWords ? newMats.map((m) => m.name.replace(/\s+/g, '_')).join(' ') : Array.from(strBytes).join(' '), strBytes);
    }
    if (colors) {
      if (colors.a.type === 'String') {
        const strBytes = latin1Bytes(newMats.map((m) => m.color + '\0').join(''));
        await rewrite(colors, Array.from(strBytes).join(' '), strBytes);
      } else {
        const nc = Number(colors.a.NumberOfComponents ?? 3);
        const ct = colors.a.type ?? 'Float32';
        const existing = Array.from(await readValues(h, colors), Number);
        const unit01 = existing.every((x) => x <= 1) && !isIntType(ct);
        const vals: number[] = [];
        for (const m of newMats) {
          const rgb = [1, 3, 5].map((o) => parseInt(m.color.slice(o, o + 2), 16) || 0).map((v) => (unit01 ? v / 255 : v));
          vals.push(...rgb, ...Array(Math.max(0, nc - 3)).fill(unit01 ? 1 : 255));
        }
        const t = makeTyped(ct, vals.length);
        vals.forEach((v, k) => ((t as { [i: number]: number | bigint })[k] = isBigType(ct) ? BigInt(Math.round(v)) : isIntType(ct) ? Math.round(v) : v));
        await rewrite(colors, vals.map((v) => (unit01 ? +v.toFixed(6) : Math.round(v))).join(' '), typedBytes(t));
      }
    }
  }

  // 4. appended 區重排：照原 offset 順序，沒改的區塊原封不動複製，改過的換新；新陣列接在最後
  const all = [...h.sections.CellData, ...h.sections.PointData, ...h.sections.FieldData];
  const app = all.filter((d) => (d.a.format ?? 'ascii') === 'appended').sort((p, q) => Number(p.a.offset ?? 0) - Number(q.a.offset ?? 0));
  const blocks: Uint8Array[] = [];
  const offsetOf = new Map<ArrDesc, number>();
  let off = 0;
  let tailStart = -1;
  for (const d of app) {
    const at = appData + Number(d.a.offset ?? 0);
    const len = blockLength(h, enc, at);
    tailStart = Math.max(tailStart, at + len);
    const b = edits.get(d)?.block ?? h.bytes.subarray(at, at + len);
    offsetOf.set(d, off);
    blocks.push(b);
    off += b.length;
  }
  const addedTags = added.map((a) => {
    if (a.block) {
      const tag = a.tag.replace('offset="0"', `offset="${off}"`);
      blocks.push(a.block);
      off += a.block.length;
      return tag;
    }
    return `${a.tag}${a.body}</DataArray>`;
  });

  // 5. XML：由後往前換（位置才不會跑掉）
  const reps: { s: number; e: number; text: string }[] = [];
  for (const d of all) {
    const ed = edits.get(d);
    const newOff = offsetOf.get(d);
    if (!ed && (newOff === undefined || newOff === Number(d.a.offset ?? 0))) continue;
    let tag = h.xml.slice(d.start, d.tagEnd);
    if (newOff !== undefined) tag = setAttr(tag, 'offset', String(newOff));
    for (const [k, v] of Object.entries(ed?.attrs ?? {})) tag = setAttr(tag, k, v);
    if (ed?.body !== undefined) reps.push({ s: d.start, e: d.end, text: `${tag}${ed.body}</DataArray>` });
    else reps.push({ s: d.start, e: d.tagEnd, text: tag });
  }
  if (addedTags.length) {
    const lastFr = fr.reduce((p, q) => (q.d.end > p.d.end ? q : p)).d;
    const lineStart = h.xml.lastIndexOf('\n', lastFr.start) + 1;
    const indent = h.xml.slice(lineStart, lastFr.start).match(/^[ \t]*/)?.[0] ?? '';
    reps.push({ s: lastFr.end, e: lastFr.end, text: addedTags.map((t) => `\n${indent}${t}`).join('') });
  }
  reps.sort((p, q) => q.s - p.s || q.e - p.e);
  let xml = h.xml;
  for (const r of reps) xml = xml.slice(0, r.s) + r.text + xml.slice(r.e);
  if (h.appAt < 0) return latin1Bytes(xml);
  const tail = tailStart >= 0 ? h.bytes.subarray(tailStart) : h.bytes.subarray(appData);
  return catBytes([latin1Bytes(xml), h.bytes.subarray(h.appAt, appData), ...blocks, tail]);
}
