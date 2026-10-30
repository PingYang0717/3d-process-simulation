import { describe, expect, it } from 'vitest';
import {
  type Vec3,
  type Volume,
  MATERIALS,
  VOID,
  demoVolume,
  diffMask,
  greedyMesh,
  initialLabeled,
  materialsFor,
  voxelFromHit,
} from './volume';
import { decodeVti, encodeVti } from './vti';
import { type EditState, type Op, applyOp, matNameOf } from './ops';

const small = (): Volume => {
  const X = 5;
  const Y = 4;
  const Z = 3;
  const data = new Uint8Array(X * Y * Z);
  for (let i = 0; i < data.length; i++) data[i] = [0, 1, 2, 7, 254][i % 5];
  return { X, Y, Z, data };
};
const buf = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const b64 = (b: Uint8Array) => {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s);
};
const deflate = async (b: Uint8Array) => {
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(b);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
};
const u32 = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
const u64 = (...v: number[]) => new Uint8Array(new BigUint64Array(v.map(BigInt)).buffer);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** 依 VTK 的寫法組一個 .vti（測讀取用）。 */
function vtiText(v: Volume, opts: { array: string; type?: string; header?: 'UInt32' | 'UInt64'; zlib?: boolean; app?: string }) {
  const ext = `0 ${v.X} 0 ${v.Y} 0 ${v.Z}`;
  return `<?xml version="1.0"?>
<VTKFile type="ImageData" version="1.0" byte_order="LittleEndian" header_type="${opts.header ?? 'UInt32'}"${opts.zlib ? ' compressor="vtkZLibDataCompressor"' : ''}>
  <ImageData WholeExtent="${ext}" Origin="1 2 3" Spacing="0.5 0.5 0.25">
    <Piece Extent="${ext}">
      <PointData>
      </PointData>
      <CellData Scalars="RegionId">
        <DataArray type="Float32" Name="Temperature" format="ascii">0</DataArray>
        ${opts.array}
      </CellData>
    </Piece>
  </ImageData>
${opts.app ?? ''}</VTKFile>
`;
}

/** zlib 區塊：header [nblocks, blockSize, lastSize, sizes...] ＋ 壓縮資料。 */
const zlibBlocks = async (raw: Uint8Array, blockSize: number, hdr: (...v: number[]) => Uint8Array) => {
  const blocks: Uint8Array[] = [];
  for (let o = 0; o < raw.length; o += blockSize) blocks.push(await deflate(raw.subarray(o, o + blockSize)));
  const last = raw.length % blockSize;
  return { head: hdr(blocks.length, blockSize, last, ...blocks.map((b) => b.length)), body: cat(...blocks) };
};

describe('.vti', () => {
  it('匯出再讀回：逐體素相同，Spacing／Origin 不變', async () => {
    const v = demoVolume();
    const { vol, info } = await decodeVti(buf(encodeVti(v, [0.5, 0.5, 0.5], [1, 2, 3], 'RegionId')));
    expect([vol.X, vol.Y, vol.Z]).toEqual([160, 96, 128]);
    expect(diffMask(vol, v).count).toBe(0);
    expect(info.spacing).toEqual([0.5, 0.5, 0.5]);
    expect(info.origin).toEqual([1, 2, 3]);
    expect(info.arrayName).toBe('RegionId');
  });

  it('ascii、挑名稱像 region 的陣列', async () => {
    const v = small();
    const text = vtiText(v, { array: `<DataArray type="Int32" Name="RegionId" format="ascii">${[...v.data].join(' ')}</DataArray>` });
    const { vol, info } = await decodeVti(buf(new TextEncoder().encode(text)));
    expect(info.arrayName).toBe('RegionId');
    expect(info.spacing).toEqual([0.5, 0.5, 0.25]);
    expect(diffMask(vol, v).count).toBe(0);
  });

  it('inline base64（UInt32 header，header 與資料同一串）', async () => {
    const v = small();
    const data = b64(cat(u32(v.data.length), v.data));
    const text = vtiText(v, { array: `<DataArray type="UInt8" Name="material" format="binary">\n  ${data}\n</DataArray>` });
    expect(diffMask((await decodeVti(buf(new TextEncoder().encode(text)))).vol, v).count).toBe(0);
  });

  it('inline base64 ＋ zlib（header 與資料各自 base64）', async () => {
    const v = small();
    const i32 = new Uint8Array(new Int32Array(v.data).buffer);
    const { head, body } = await zlibBlocks(i32, 64, u32);
    const text = vtiText(v, {
      zlib: true,
      array: `<DataArray type="Int32" Name="material" format="binary">${b64(head)}${b64(body)}</DataArray>`,
    });
    const { vol, info } = await decodeVti(buf(new TextEncoder().encode(text)));
    expect(info.compressed).toBe(true);
    expect(diffMask(vol, v).count).toBe(0);
  });

  it('appended base64 ＋ zlib（UInt64 header），offset 指到第二個陣列', async () => {
    const v = small();
    const other = b64(cat(u64(4), new Uint8Array(4)));
    const { head, body } = await zlibBlocks(v.data, 16, u64);
    const mine = b64(head) + b64(body);
    const text = vtiText(v, {
      header: 'UInt64',
      zlib: true,
      array: `<DataArray type="UInt8" Name="material" format="appended" offset="${other.length}"/>`,
      app: `  <AppendedData encoding="base64">\n   _${other}${mine}\n  </AppendedData>\n`,
    });
    expect(diffMask((await decodeVti(buf(new TextEncoder().encode(text)))).vol, v).count).toBe(0);
  });

  it('appended raw ＋ zlib', async () => {
    const v = small();
    const { head, body } = await zlibBlocks(v.data, 25, u32);
    const pre = new TextEncoder().encode(
      vtiText(v, { zlib: true, array: '<DataArray type="UInt8" Name="material" format="appended" offset="0"/>' }).replace(
        '</VTKFile>\n',
        '  <AppendedData encoding="raw">\n   _',
      ),
    );
    const post = new TextEncoder().encode('\n  </AppendedData>\n</VTKFile>\n');
    expect(diffMask((await decodeVti(buf(cat(pre, head, body, post)))).vol, v).count).toBe(0);
  });

  it('浮點值依值重新編號，0 仍當空', async () => {
    const v = { X: 2, Y: 1, Z: 2, data: new Uint8Array(4) };
    const text = vtiText(v, { array: '<DataArray type="Float32" Name="material" format="ascii">0 1.5 2.5 1.5</DataArray>' });
    const { vol, valueMap } = await decodeVti(buf(new TextEncoder().encode(text)));
    expect([...vol.data]).toEqual([0, 1, 2, 1]);
    expect(valueMap.get(2.5)).toBe(2);
  });

  it('不是 ImageData 會擋下', async () => {
    await expect(decodeVti(buf(new TextEncoder().encode('<VTKFile type="PolyData"></VTKFile>')))).rejects.toThrow('ImageData');
  });
});

describe('材質', () => {
  it('載入檔案一律「材質 n」，0 與 254 一定在', () => {
    const mats = materialsFor([3, 1, 3]);
    expect(mats.map((m) => m.id)).toEqual([0, 1, 3, VOID]);
    expect(mats.map((m) => m.name)).toEqual(['0（空／Air）', '材質 1', '材質 3', 'VOID（空洞）']);
    expect(mats[1].color).not.toBe(mats[2].color);
  });

  it('大範例 ×2：每軸放大兩倍，材質一樣', () => {
    const v = demoVolume(2);
    expect([v.X, v.Y, v.Z]).toEqual([320, 192, 256]);
    expect(new Set(v.data)).toEqual(new Set(demoVolume().data));
  }, 30_000);
});

describe('greedy mesh 與命中', () => {
  /** 逐體素數暴露面（舊做法），面積要和合併後一樣。 */
  const exposedFaces = (v: Volume) => {
    let n = 0;
    const get = (x: number, y: number, z: number) =>
      x < 0 || y < 0 || z < 0 || x >= v.X || y >= v.Y || z >= v.Z ? 0 : v.data[(z * v.Y + y) * v.X + x];
    for (let z = 0; z < v.Z; z++)
      for (let y = 0; y < v.Y; y++)
        for (let x = 0; x < v.X; x++) {
          const m = get(x, y, z);
          if (!m) continue;
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ])
            if (get(x + dx, y + dy, z + dz) !== m) n++;
        }
    return n;
  };
  const area = (pos: Float32Array) => {
    let a = 0;
    for (let t = 0; t < pos.length; t += 9) {
      const u = [pos[t + 3] - pos[t], pos[t + 4] - pos[t + 1], pos[t + 5] - pos[t + 2]];
      const w = [pos[t + 6] - pos[t], pos[t + 7] - pos[t + 1], pos[t + 8] - pos[t + 2]];
      const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      a += Math.hypot(c[0], c[1], c[2]) / 2;
    }
    return a;
  };

  it('一個方塊 = 6 個矩形', () => {
    const v = { X: 4, Y: 3, Z: 2, data: new Uint8Array(24).fill(5) };
    const m = greedyMesh(v.X, v.Y, v.Z, new Uint16Array(v.data), () => [1, 0, 0]);
    expect(m.quads).toBe(6);
    expect(area(m.positions)).toBeCloseTo(2 * (4 * 3 + 3 * 2 + 4 * 2));
  });

  it('範例：面積和逐體素暴露面相同，矩形數少很多', () => {
    const v = demoVolume();
    const m = greedyMesh(v.X, v.Y, v.Z, new Uint16Array(v.data), () => [1, 1, 1]);
    const faces = exposedFaces(v);
    expect(Math.round(area(m.positions))).toBe(faces);
    expect(m.quads).toBeLessThan(faces / 50);
  }, 30_000);

  it('法線朝外：每個三角形的繞向與 normal 一致', () => {
    const v = small();
    const m = greedyMesh(v.X, v.Y, v.Z, new Uint16Array(v.data), () => [1, 1, 1]);
    for (let t = 0; t < m.positions.length; t += 9) {
      const p = m.positions;
      const u = [p[t + 3] - p[t], p[t + 4] - p[t + 1], p[t + 5] - p[t + 2]];
      const w = [p[t + 6] - p[t], p[t + 7] - p[t + 1], p[t + 8] - p[t + 2]];
      const c = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      expect(c[0] * m.normals[t] + c[1] * m.normals[t + 1] + c[2] * m.normals[t + 2]).toBeGreaterThan(0);
    }
  });

  it('命中點＋法線反推體素', () => {
    const v = { X: 4, Y: 4, Z: 4, data: new Uint8Array(64) };
    // 體素 (1, 2, 3) 朝 +x 的面在 x = 2
    expect(voxelFromHit(v, [2, 2.4, 3.7], [1, 0, 0])).toBe((3 * 4 + 2) * 4 + 1);
    // 同一個點從另一側看是 (2, 2, 3)
    expect(voxelFromHit(v, [2, 2.4, 3.7], [-1, 0, 0])).toBe((3 * 4 + 2) * 4 + 2);
    expect(voxelFromHit(v, [0, 1, 1], [1, 0, 0])).toBe(-1);
  });
});

describe('局部凸起', () => {
  it('Alt＋拖：只有半徑內的列往上長', () => {
    const vol = demoVolume();
    const matName = matNameOf(MATERIALS);
    const base: EditState = { vol, L: initialLabeled(vol, matName) };
    let seq = 1000;
    const ctx = { orig: vol, matName, newKey: () => `c${seq++}` };
    const poly = base.L.comps.find((c) => c.mat === 6)!;
    const center: Vec3 = [80, poly.bbox.y0, 26];
    const op: Op = {
      kind: 'push',
      keys: [poly.key],
      zRange: [0, vol.Z - 1],
      dir: [0, -1, 0],
      n: 2,
      follow: false,
      backfill: 'orig',
      local: { center, radius: 3 },
    };
    const { mask, count } = diffMask(applyOp(base, op, ctx).vol, vol);
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const x = i % vol.X;
      const z = Math.floor(i / (vol.X * vol.Y));
      expect((x - center[0]) ** 2 + (z - center[2]) ** 2).toBeLessThanOrEqual(9);
    }
  });
});
