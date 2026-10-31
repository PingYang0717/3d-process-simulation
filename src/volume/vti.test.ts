// plan v9 P16：decodeVti 只解標頭、ascii 逐字元掃描、UInt8 快路徑；結果和舊版相同。
import { describe, expect, it } from 'vitest';
import { decodeVti, encodeVti, parseAscii } from './vti';
import { decodeVtiOld } from './ref/vtiOld';

const X = 6;
const Y = 5;
const Z = 4;
const N = X * Y * Z;
const ext = `0 ${X} 0 ${Y} 0 ${Z}`;
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
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
const xml = (array: string, extra = '', compressor = '') => `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="UInt32"${compressor ? ` compressor="${compressor}"` : ''}>
  <ImageData WholeExtent="${ext}" Origin="1 2 3" Spacing="0.5 0.5 0.5">
    <Piece Extent="${ext}">
      <CellData Scalars="material">
        ${array}
      </CellData>
    </Piece>
  </ImageData>${extra}
</VTKFile>
`;
const values = Uint8Array.from({ length: N }, (_, i) => (i * 7) % 5);

async function same(buf: Uint8Array) {
  const a = await decodeVti(buf.slice().buffer);
  const b = await decodeVtiOld(buf.slice().buffer);
  expect([a.vol.X, a.vol.Y, a.vol.Z]).toEqual([b.vol.X, b.vol.Y, b.vol.Z]);
  expect(Array.from(a.vol.data)).toEqual(Array.from(b.vol.data));
  expect(a.info).toEqual(b.info);
  expect([...a.valueMap]).toEqual([...b.valueMap]);
  return a;
}

describe('decodeVti（plan v9 P16）', () => {
  it('appended raw（encodeVti 輸出，UInt8 快路徑）', async () => {
    const a = await same(encodeVti({ X, Y, Z, data: values }, [0.5, 0.5, 0.5], [1, 2, 3]));
    expect(Array.from(a.vol.data)).toEqual(Array.from(values));
  });
  it('appended base64、inline base64（UInt16）', async () => {
    const data = new Uint8Array(new Uint16Array(Array.from(values, (v) => v * 3)).buffer);
    const blob = b64(cat(u32(data.length), data));
    await same(enc.encode(xml(`<DataArray type="UInt16" Name="material" format="appended" offset="0"/>`, `\n  <AppendedData encoding="base64">\n   _${blob}\n  </AppendedData>`)));
    await same(enc.encode(xml(`<DataArray type="UInt16" Name="material" format="binary">${blob}</DataArray>`)));
  });
  it('zlib 壓縮（appended raw、inline base64）', async () => {
    const z = await deflate(values);
    const head = u32(1, N, N, z.length);
    const head0 = xml(`<DataArray type="UInt8" Name="material" format="appended" offset="0"/>`, `\n  <AppendedData encoding="raw">\n   _`, 'vtkZLibDataCompressor').replace('\n</VTKFile>\n', '');
    const bytes = cat(enc.encode(head0), head, z, enc.encode('\n  </AppendedData>\n</VTKFile>\n'));
    const a = await same(bytes);
    expect(Array.from(a.vol.data)).toEqual(Array.from(values));
    await same(enc.encode(xml(`<DataArray type="UInt8" Name="material" format="binary">${b64(head)}${b64(z)}</DataArray>`, '', 'vtkZLibDataCompressor')));
  });
  it('ascii：整數、負數與小數（重新編號）、科學記號、多種空白', async () => {
    await same(enc.encode(xml(`<DataArray type="Int32" Name="region" format="ascii">\n ${Array.from(values).join('  \t')} \n</DataArray>`)));
    const floats = Array.from(values, (v, i) => (i % 3 ? v * 0.5 : -v)).map((v, i) => (i % 4 === 0 ? v.toExponential() : String(v)));
    await same(enc.encode(xml(`<DataArray type="Float32" Name="mat" format="ascii">${floats.join('\n')}</DataArray>`)));
  });
  it('parseAscii === split(/\\s+/).map(Number)', () => {
    const s = ' 1 -2 +3 4.5 -0 1e3 nan 007 99999999999999999 \n\t12';
    const ref = s.trim().split(/\s+/).map(Number);
    expect(Array.from(parseAscii(s, ref.length))).toEqual(ref);
  });
});
