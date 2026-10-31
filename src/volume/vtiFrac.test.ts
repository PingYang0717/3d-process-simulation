// plan v11 §4.0：PointData 多材質比例（argmax）＋FieldData 材質表；與輸入同格式匯出（encodeVtiLike）。
import { describe, expect, it } from 'vitest';
import { b64, decodeVti, encodeVtiLike, inspectVti, parseHead, readValues } from './vti';

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
