// plan v11 §4.0：PointData 多材質比例（argmax）＋FieldData 材質表；與輸入同格式匯出（encodeVtiLike）。
import { describe, expect, it } from 'vitest';
import { b64, b64Bytes, decodeVti, encodeVtiLike, encodeVtiLikeParts, inspectVti, parseHead, readValues } from './vti';

const PX = 4;
const PY = 3;
const PZ = 2;
const N = PX * PY * PZ;
const enc = new TextEncoder();
async function deflate(u: Uint8Array) {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(u);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
const u32 = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};

// 三個材質的比例：第 0 點平手（1、2 各 0.5 → 取 1）、第 1 點全 0（Air）、其他輪流
const fr: number[][] = [[], [], []];
for (let i = 0; i < N; i++) {
  const v = i === 0 ? [0.5, 0.5, 0] : i === 1 ? [0, 0, 0] : i % 3 === 0 ? [0.7, 0.2, 0.1] : i % 3 === 1 ? [0.1, 0.25, 0.65] : [0, 1, 0];
  v.forEach((x, k) => fr[k].push(x));
}
const expected = Array.from({ length: N }, (_, i) => (i === 0 ? 1 : i === 1 ? 0 : i % 3 === 0 ? 1 : i % 3 === 1 ? 3 : 2));
const names = enc.encode('Si\0SiO2\0TiN\0');

interface Arr {
  section: 'PointData' | 'FieldData';
  name: string;
  type: string;
  comps?: number;
  tuples?: number;
  bytes: Uint8Array;
  ascii: string;
}
const arrays: Arr[] = [
  ...fr.map((v, k): Arr => ({ section: 'PointData', name: `material_${k + 1}`, type: 'Float32', bytes: new Uint8Array(new Float32Array(v).buffer), ascii: v.join(' ') })),
  { section: 'PointData', name: 'Potential', type: 'Float64', bytes: new Uint8Array(new Float64Array(Array.from({ length: N }, (_, i) => i * 0.1)).buffer), ascii: Array.from({ length: N }, (_, i) => (i * 0.1).toFixed(1)).join(' ') },
  { section: 'FieldData', name: 'MaterialCode', type: 'Int32', tuples: 3, bytes: new Uint8Array(new Int32Array([1, 2, 3]).buffer), ascii: '1 2 3' },
  { section: 'FieldData', name: 'MaterialName', type: 'String', tuples: 3, bytes: names, ascii: Array.from(names).join(' ') },
  { section: 'FieldData', name: 'MaterialColor', type: 'UInt8', comps: 3, tuples: 3, bytes: Uint8Array.from([200, 200, 190, 150, 210, 230, 140, 150, 170]), ascii: '200 200 190 150 210 230 140 150 170' },
];

type Mode = 'ascii' | 'raw' | 'raw-z' | 'binary-z' | 'b64' | 'b64-z';
async function make(mode: Mode) {
  const compressed = mode.endsWith('-z');
  const block = async (b: Uint8Array) => (compressed ? { head: u32(1, b.length, b.length, (await deflate(b)).length), body: await deflate(b) } : { head: u32(b.length), body: b });
  const text = (x: { head: Uint8Array; body: Uint8Array }) => (compressed ? b64(x.head) + b64(x.body) : b64(cat(x.head, x.body)));
  const app: Uint8Array[] = [];
  let off = 0;
  const tag = async (a: Arr) => {
    const at = `type="${a.type}" Name="${a.name}"${a.comps ? ` NumberOfComponents="${a.comps}"` : ''}${a.tuples ? ` NumberOfTuples="${a.tuples}"` : ''}`;
    if (mode === 'ascii') return `<DataArray ${at} format="ascii">\n          ${a.ascii}\n        </DataArray>`;
    const b = await block(a.bytes);
    if (mode === 'binary-z') return `<DataArray ${at} format="binary">\n          ${text(b)}\n        </DataArray>`;
    const raw = mode.startsWith('raw') ? cat(b.head, b.body) : enc.encode(text(b));
    const t = `<DataArray ${at} format="appended" offset="${off}"/>`;
    app.push(raw);
    off += raw.length;
    return t;
  };
  const sec = async (s: Arr['section']) => (await Promise.all(arrays.filter((a) => a.section === s).map(tag))).join('\n        ');
  const fd = await sec('FieldData');
  const pd = await sec('PointData');
  const ext = `0 ${PX - 1} 0 ${PY - 1} 0 ${PZ - 1}`;
  const head = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32"${compressed ? ' compressor="vtkZLibDataCompressor"' : ''}>
  <ImageData WholeExtent="${ext}" Origin="0 0 0" Spacing="0.5 0.5 0.5">
    <FieldData>
        ${fd}
    </FieldData>
    <Piece Extent="${ext}">
      <PointData Scalars="material_1">
        ${pd}
      </PointData>
      <CellData>
      </CellData>
    </Piece>
  </ImageData>`;
  if (!app.length) return enc.encode(head + '\n</VTKFile>\n');
  const appTag = `\n  <AppendedData encoding="${mode.startsWith('raw') ? 'raw' : 'base64'}">\n   _`;
  return cat(enc.encode(head + appTag), ...app, enc.encode('\n  </AppendedData>\n</VTKFile>\n'));
}

const MODES: Mode[] = ['ascii', 'raw', 'raw-z', 'binary-z', 'b64', 'b64-z'];

describe('PointData 比例陣列＋FieldData（plan v11 §4.0）', () => {
  for (const mode of MODES)
    it(`${mode}：argmax、平手取小、全 0 為 Air；FieldData 的名稱與顏色`, async () => {
      const bytes = await make(mode);
      const { vol, info } = await decodeVti(bytes.slice().buffer);
      expect([vol.X, vol.Y, vol.Z]).toEqual([PX, PY, PZ]);
      expect(Array.from(vol.data)).toEqual(expected);
      expect(info.fractions?.map((f) => [f.name, f.id])).toEqual([
        ['material_1', 1],
        ['material_2', 2],
        ['material_3', 3],
      ]);
      expect(info.fieldData).toEqual([
        { code: 1, name: 'Si', color: '#c8c8be' },
        { code: 2, name: 'SiO2', color: '#96d2e6' },
        { code: 3, name: 'TiN', color: '#8c96aa' },
      ]);
      const ins = await inspectVti(bytes.slice().buffer);
      expect(ins.fractions.length).toBe(3);
      expect(ins.arrays.find((a) => a.name === 'Potential')?.matched).toBeNull();
      expect(ins.fieldWarn).toBeNull();
    });

  it('只有一個比例陣列：≥ 0.5 才算', async () => {
    const xml = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian">
  <ImageData WholeExtent="0 1 0 0 0 0" Origin="0 0 0" Spacing="1 1 1">
    <Piece Extent="0 1 0 0 0 0">
      <PointData><DataArray type="Float32" Name="material_5" format="ascii">0.49 0.5</DataArray></PointData>
    </Piece>
  </ImageData>
</VTKFile>`;
    const { vol } = await decodeVti(enc.encode(xml).buffer);
    expect(Array.from(vol.data)).toEqual([0, 5]);
  });

  it('手動指定陣列 ↔ 材質（名稱不符規則時）', async () => {
    const bytes = await make('ascii');
    const { vol } = await decodeVti(bytes.slice().buffer, { fractions: [{ name: 'material_2', id: 7 }, { name: 'material_3', id: 9 }] });
    expect(vol.data[2]).toBe(7);
    expect(vol.data[4]).toBe(9);
  });

  for (const mode of MODES)
    it(`${mode}：encodeVtiLike 沒改＝逐位元組相同；改一格後未改點 bit-identical、改點 1／0、新材質補陣列與 FieldData`, async () => {
      const bytes = await make(mode);
      const { vol, info } = await decodeVti(bytes.slice().buffer);
      const mats = [
        { id: 1, name: 'Si', color: '#c8c8be' },
        { id: 2, name: 'SiO2', color: '#96d2e6' },
        { id: 3, name: 'TiN', color: '#8c96aa' },
        { id: 254, name: 'VOID', color: '#1f1f1f' },
      ];
      const same = await encodeVtiLike(bytes, info.fractions!, vol.data, vol.data, mats);
      expect(same.length === bytes.length && same.every((b, i) => b === bytes[i])).toBe(true);

      const data = vol.data.slice();
      data[5] = 2; // 原本 3
      data[9] = 254; // 原本 1，新材質
      const out = await encodeVtiLike(bytes, info.fractions!, data, vol.data, mats);
      const back = await decodeVti(out.slice().buffer);
      expect(Array.from(back.vol.data)).toEqual(Array.from(data));
      expect(back.info.fractions?.map((f) => f.name)).toEqual(['material_1', 'material_2', 'material_3', 'material_254']);
      expect(back.info.fieldData?.length).toBe(4);
      expect(back.info.fieldData?.slice(0, 3)).toEqual((await decodeVti(bytes.slice().buffer)).info.fieldData);
      expect(back.info.fieldData?.[3]).toEqual({ code: 254, name: 'VOID', color: '#1f1f1f' });
      // 每個比例陣列：未改點的值（Float32 位元）完全相同；改點 1／0
      const h0 = parseHead(bytes);
      const h1 = parseHead(out);
      for (let k = 0; k < 3; k++) {
        const name = `material_${k + 1}`;
        const a = Float32Array.from((await readValues(h0, h0.sections.PointData.find((d) => d.a.Name === name)!, N)) as ArrayLike<number>);
        const b = Float32Array.from((await readValues(h1, h1.sections.PointData.find((d) => d.a.Name === name)!, N)) as ArrayLike<number>);
        for (let i = 0; i < N; i++) {
          if (i === 5) expect(b[i]).toBe(k + 1 === 2 ? 1 : 0);
          else if (i === 9) expect(b[i]).toBe(0);
          else expect(b[i]).toBe(a[i]);
        }
      }
      // 其他陣列（Potential）原值不動
      const pot = (h: ReturnType<typeof parseHead>) => readValues(h, h.sections.PointData.find((d) => d.a.Name === 'Potential')!, N);
      expect(Array.from((await pot(h1)) as ArrayLike<number>)).toEqual(Array.from((await pot(h0)) as ArrayLike<number>));
      const v254 = Array.from((await readValues(h1, h1.sections.PointData.find((d) => d.a.Name === 'material_254')!, N)) as ArrayLike<number>);
      expect(v254.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([9]);
      // 壓縮的輸入，輸出也壓縮
      expect(new TextDecoder().decode(out.subarray(0, 300)).includes('vtkZLibDataCompressor')).toBe(mode.endsWith('-z'));
    });
});

// ---- plan v15 C1：只重壓碰到的 block（patchBlocks）、parts、hint；多 block、UInt64 header、big-endian ----

type Hs = 4 | 8;
interface BigOpts {
  mode: Mode;
  hsize?: Hs;
  le?: boolean;
  blockSize?: number;
  /** 值加一點雜訊，block 才壓不小（測零複製用）。 */
  noise?: boolean;
}
const BX = 16;
const BY = 8;
const BZ = 8;
const BN = BX * BY * BZ; // 1024 點 → Float32 4096 B；blockSize 64 → 64 塊
/** 三個 Float32 比例陣列（輪流為主）＋ FieldData 代碼／名稱／顏色，可選 header 大小、位元組序、blockSize。 */
async function makeBig(o: BigOpts) {
  const hsize: Hs = o.hsize ?? 4;
  const le = o.le ?? true;
  const blockSize = o.blockSize ?? 64;
  const compressed = o.mode.endsWith('-z');
  const ints = (...v: number[]) => {
    const out = new Uint8Array(v.length * hsize);
    const dv = new DataView(out.buffer);
    v.forEach((x, i) => (hsize === 8 ? dv.setBigUint64(i * 8, BigInt(x), le) : dv.setUint32(i * 4, x, le)));
    return out;
  };
  const f32 = (vals: number[]) => {
    const out = new Uint8Array(vals.length * 4);
    const dv = new DataView(out.buffer);
    vals.forEach((x, i) => dv.setFloat32(i * 4, x, le));
    return out;
  };
  const i32 = (vals: number[]) => {
    const out = new Uint8Array(vals.length * 4);
    const dv = new DataView(out.buffer);
    vals.forEach((x, i) => dv.setInt32(i * 4, x, le));
    return out;
  };
  const frac: number[][] = [[], [], []];
  for (let i = 0; i < BN; i++) {
    const main = i % 3;
    for (let k = 0; k < 3; k++) frac[k].push((k === main ? 0.8 : 0.1) + (o.noise ? (((i * 7919 + k * 104729) % 1000) / 1e6) : 0));
  }
  const arrs: Arr[] = [
    ...frac.map((v, k): Arr => ({ section: 'PointData', name: `material_${k + 1}`, type: 'Float32', bytes: f32(v), ascii: v.join(' ') })),
    { section: 'FieldData', name: 'MaterialCode', type: 'Int32', tuples: 3, bytes: i32([1, 2, 3]), ascii: '1 2 3' },
    { section: 'FieldData', name: 'MaterialName', type: 'String', tuples: 3, bytes: names, ascii: Array.from(names).join(' ') },
    { section: 'FieldData', name: 'MaterialColor', type: 'UInt8', comps: 3, tuples: 3, bytes: Uint8Array.from([200, 200, 190, 150, 210, 230, 140, 150, 170]), ascii: '200 200 190 150 210 230 140 150 170' },
  ];
  const block = async (b: Uint8Array) => {
    if (!compressed) return { head: ints(b.length), body: b };
    const nb = Math.ceil(b.length / blockSize);
    const parts: Uint8Array[] = [];
    for (let k = 0; k < nb; k++) parts.push(await deflate(b.subarray(k * blockSize, Math.min(b.length, (k + 1) * blockSize))));
    // VTK 慣例：最後一塊剛好滿時 lastSize 寫 0
    return { head: ints(nb, blockSize, b.length % blockSize, ...parts.map((p) => p.length)), body: cat(...parts) };
  };
  const text = (x: { head: Uint8Array; body: Uint8Array }) => (compressed ? b64(x.head) + b64(x.body) : b64(cat(x.head, x.body)));
  const app: Uint8Array[] = [];
  let off = 0;
  const tag = async (a: Arr) => {
    const at = `type="${a.type}" Name="${a.name}"${a.comps ? ` NumberOfComponents="${a.comps}"` : ''}${a.tuples ? ` NumberOfTuples="${a.tuples}"` : ''}`;
    if (o.mode === 'ascii') return `<DataArray ${at} format="ascii">\n          ${a.ascii}\n        </DataArray>`;
    const b = await block(a.bytes);
    if (o.mode === 'binary-z') return `<DataArray ${at} format="binary">\n          ${text(b)}\n        </DataArray>`;
    const raw = o.mode.startsWith('raw') ? cat(b.head, b.body) : enc.encode(text(b));
    const t = `<DataArray ${at} format="appended" offset="${off}"/>`;
    app.push(raw);
    off += raw.length;
    return t;
  };
  const sec = async (s: Arr['section']) => (await Promise.all(arrs.filter((a) => a.section === s).map(tag))).join('\n        ');
  const fd = await sec('FieldData');
  const pd = await sec('PointData');
  const ext = `0 ${BX - 1} 0 ${BY - 1} 0 ${BZ - 1}`;
  const head = `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="${le ? 'LittleEndian' : 'BigEndian'}" header_type="${hsize === 8 ? 'UInt64' : 'UInt32'}"${compressed ? ' compressor="vtkZLibDataCompressor"' : ''}>
  <ImageData WholeExtent="${ext}" Origin="0 0 0" Spacing="1 1 1">
    <FieldData>
        ${fd}
    </FieldData>
    <Piece Extent="${ext}">
      <PointData Scalars="material_1">
        ${pd}
      </PointData>
      <CellData>
      </CellData>
    </Piece>
  </ImageData>`;
  if (!app.length) return enc.encode(head + '\n</VTKFile>\n');
  const appTag = `\n  <AppendedData encoding="${o.mode.startsWith('raw') ? 'raw' : 'base64'}">\n   _`;
  return cat(enc.encode(head + appTag), ...app, enc.encode('\n  </AppendedData>\n</VTKFile>\n'));
}

/** appended raw 壓縮陣列每個 block 在檔案裡的位元組範圍。 */
function rawBlockRanges(bytes: Uint8Array, name: string) {
  const h = parseHead(bytes);
  const d = h.sections.PointData.find((x) => x.a.Name === name)!;
  const at = bytes.indexOf(0x5f, h.appAt) + 1 + Number(d.a.offset ?? 0);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + at);
  const rd = (k: number) => (h.hsize === 8 ? Number(dv.getBigUint64(k * 8, h.le)) : dv.getUint32(k * 4, h.le));
  const nb = rd(0);
  const ranges: [number, number][] = [];
  let o = at + (3 + nb) * h.hsize;
  for (let k = 0; k < nb; k++) {
    const s = rd(3 + k);
    ranges.push([o, o + s]);
    o += s;
  }
  return { nb, blockSize: rd(1), ranges };
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const MATS = [
  { id: 1, name: 'Si', color: '#c8c8be' },
  { id: 2, name: 'SiO2', color: '#96d2e6' },
  { id: 3, name: 'TiN', color: '#8c96aa' },
  { id: 254, name: 'VOID', color: '#1f1f1f' },
];
/** 改點（原值 i % 3 + 1）：5（3 → 2）、20（3 → 254，新材質）、300（1 → 2）。blockSize 64 時在 block 0、1、18。 */
const CHANGES: [number, number][] = [
  [5, 2],
  [20, 254],
  [300, 2],
];
/** 原陣列碰到的 block 數（元素 4 B）。 */
const touchedBlocks = (blockSize: number, idx: number[]) => new Set(idx.map((i) => Math.floor((i * 4) / blockSize))).size;

describe('encodeVtiLike 只重壓碰到的 block（plan v15 C1）', () => {
  const cases: BigOpts[] = [
    ...MODES.map((mode): BigOpts => ({ mode })),
    ...MODES.filter((m) => m !== 'ascii').map((mode): BigOpts => ({ mode, hsize: 8 })),
    { mode: 'raw-z', blockSize: 100 }, // 最後一塊不滿
    { mode: 'raw-z', blockSize: 50 }, // 不是元素大小的倍數 → 退回整陣列路徑
    { mode: 'raw-z', le: false },
    { mode: 'raw', le: false, hsize: 8 },
  ];
  for (const c of cases)
    it(`${c.mode} hsize=${c.hsize ?? 4} le=${c.le ?? true} blockSize=${c.blockSize ?? 64}：解回來的值 === 整陣列路徑、未碰到的 block 位元組 === 原檔`, async () => {
      const bytes = await makeBig(c);
      const { vol, info } = await decodeVti(bytes.slice().buffer);
      expect(Array.from(vol.data)).toEqual(Array.from({ length: BN }, (_, i) => (i % 3) + 1));
      // 沒改：逐位元組相同
      expect(same(await encodeVtiLike(bytes, info.fractions!, vol.data, vol.data, MATS), bytes)).toBe(true);

      const data = vol.data.slice();
      for (const [i, v] of CHANGES) data[i] = v;
      const stats = { blocks: 0, redone: 0 };
      const patched = await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, undefined, { stats });
      const whole = await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, undefined, { whole: true });
      const a = await decodeVti(patched.slice().buffer);
      const b = await decodeVti(whole.slice().buffer);
      expect(Array.from(a.vol.data)).toEqual(Array.from(data));
      expect(Array.from(b.vol.data)).toEqual(Array.from(data));
      expect(a.info).toEqual(b.info);
      expect(a.info.fieldData?.[3]).toEqual({ code: 254, name: 'VOID', color: '#1f1f1f' });
      // 每個比例陣列的值逐點相同（含新材質陣列）
      const ha = parseHead(patched);
      const hb = parseHead(whole);
      for (const name of ['material_1', 'material_2', 'material_3', 'material_254']) {
        const va = Array.from((await readValues(ha, ha.sections.PointData.find((d) => d.a.Name === name)!, BN)) as ArrayLike<number>);
        const vb = Array.from((await readValues(hb, hb.sections.PointData.find((d) => d.a.Name === name)!, BN)) as ArrayLike<number>);
        expect(va).toEqual(vb);
      }
      const binary = c.mode !== 'ascii';
      const unsupported = (c.blockSize ?? 64) % 4 !== 0;
      if (!binary || unsupported) expect(stats.blocks + stats.redone).toBe(0);
      else {
        // 3 個原陣列各碰 CHANGES 所在的 block ＋ 新材質陣列只碰變成 254 的那一點；未壓縮的虛擬 block 是 32 KB（4096 B → 1 塊）
        const bs = c.mode.endsWith('-z') ? (c.blockSize ?? 64) : 32768;
        const nb = Math.ceil(4096 / bs);
        expect(stats.blocks).toBe(4 * nb);
        expect(stats.redone).toBe(3 * touchedBlocks(bs, CHANGES.map(([i]) => i)) + touchedBlocks(bs, [20]));
      }
      // 未壓縮：整陣列路徑與 block 路徑位元組完全相同
      if (!c.mode.endsWith('-z')) expect(same(patched, whole)).toBe(true);
      // appended raw 壓縮：沒碰到的 block 的壓縮位元組就是原檔的那一段
      if (c.mode === 'raw-z' && !unsupported)
        for (let k = 0; k < 3; k++) {
          const r0 = rawBlockRanges(bytes, `material_${k + 1}`);
          const r1 = rawBlockRanges(patched, `material_${k + 1}`);
          expect(r1.nb).toBe(r0.nb);
          expect(r1.blockSize).toBe(r0.blockSize);
          const touched = new Set(CHANGES.map(([i]) => Math.floor((i * 4) / r0.blockSize)));
          for (let j = 0; j < r0.nb; j++) {
            const eq = same(bytes.subarray(...r0.ranges[j]), patched.subarray(...r1.ranges[j]));
            if (!touched.has(j)) expect(eq).toBe(true);
          }
        }
    });

  it('hint：只掃 box（diff 或比對）得到同樣的輸出；box 為 null ＝ 原檔', async () => {
    const bytes = await makeBig({ mode: 'raw-z' });
    const { vol, info } = await decodeVti(bytes.slice().buffer);
    const data = vol.data.slice();
    for (const [i, v] of CHANGES) data[i] = v;
    const diff = new Uint8Array(BN);
    for (const [i] of CHANGES) diff[i] = 1;
    const dims = { X: BX, Y: BY, Z: BZ };
    // 300 = z 2, y 2, x 12；5／20 在 z 0
    const box = { x0: 0, x1: 15, y0: 0, y1: 7, z0: 0, z1: 2 };
    const ref = await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS);
    expect(same(await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, { diff, box, dims }), ref)).toBe(true);
    expect(same(await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, { box, dims }), ref)).toBe(true);
    expect(same(await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, { diff, box: null, dims }), bytes)).toBe(true);
    // box 只蓋到一部分：外面的改點不算
    const partial = await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS, { diff, box: { ...box, z1: 0 }, dims });
    const d2 = vol.data.slice();
    d2[5] = 2;
    d2[20] = 254;
    expect(same(partial, await encodeVtiLike(bytes, info.fractions!, d2, vol.data, MATS))).toBe(true);
  });

  it('encodeVtiLikeParts 的 parts 接起來 === encodeVtiLike；沒碰到的 block 直接引用原檔（同一個 buffer）', async () => {
    const bytes = await makeBig({ mode: 'raw-z', blockSize: 1024, noise: true });
    const { vol, info } = await decodeVti(bytes.slice().buffer);
    const data = vol.data.slice();
    data[5] = 2;
    const parts = await encodeVtiLikeParts(bytes, info.fractions!, data, vol.data, MATS);
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) (joined.set(p, o), (o += p.length));
    expect(same(joined, await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS))).toBe(true);
    const shared = parts.filter((p) => p.buffer === bytes.buffer).reduce((n, p) => n + p.length, 0);
    // 3 個陣列各 4 塊只重做 1 塊：≥ 60% 的位元組是原檔的 view（沒複製）
    expect(shared / bytes.length).toBeGreaterThan(0.6);
  });

  it('big-endian：header 與值都照 byte_order 讀寫', async () => {
    const bytes = await makeBig({ mode: 'raw', le: false });
    const h = parseHead(bytes);
    const v = (await readValues(h, h.sections.PointData.find((d) => d.a.Name === 'material_1')!, BN)) as ArrayLike<number>;
    expect(Array.from(v).slice(0, 4).map((x) => +x.toFixed(2))).toEqual([0.8, 0.1, 0.1, 0.8]);
    const { vol, info } = await decodeVti(bytes.slice().buffer);
    const data = vol.data.slice();
    data[7] = 3;
    const out = await encodeVtiLike(bytes, info.fractions!, data, vol.data, MATS);
    const back = await decodeVti(out.slice().buffer);
    expect(Array.from(back.vol.data)).toEqual(Array.from(data));
    // 改點的位元組是 big-endian 的 1.0f
    const h1 = parseHead(out);
    const d3 = h1.sections.PointData.find((d) => d.a.Name === 'material_3')!;
    const at = out.indexOf(0x5f, h1.appAt) + 1 + Number(d3.a.offset) + 4 + 7 * 4;
    expect(Array.from(out.subarray(at, at + 4))).toEqual([0x3f, 0x80, 0, 0]);
  });

  it('b64Bytes === btoa（各種長度）', () => {
    for (let n = 0; n < 70; n++) {
      const u = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n * 7) & 255);
      expect(new TextDecoder().decode(b64Bytes(u))).toBe(btoa(String.fromCharCode(...u)));
    }
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 2654435761) & 255);
    let s = '';
    for (let i = 0; i < big.length; i += 8192) s += String.fromCharCode(...big.subarray(i, i + 8192));
    expect(new TextDecoder().decode(b64Bytes(big))).toBe(btoa(s));
    expect(b64(big)).toBe(btoa(s));
  });
});
