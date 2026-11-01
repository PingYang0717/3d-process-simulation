// plan v15 C2：ZipWriter 邊寫邊丟、ZIP64；小 zip 的位元組和舊的 zipStore 完全相同（黃金值）。
import { describe, expect, it } from 'vitest';
import { ZipWriter, crc32, zipStore } from './zip';

// tsconfig 沒有 @types/node：Node 內建模組用動態 import（名稱不是字面值，tsc 不去解析）
const nodeMod = <T>(name: string) => import(/* @vite-ignore */ name) as Promise<T>;
type Spawn = { spawnSync: (cmd: string, args: string[], opts: { encoding: 'utf8'; maxBuffer?: number }) => { status: number | null; stdout: string; stderr: string } };
type Fs = { mkdtempSync: (p: string) => string; writeFileSync: (p: string, d: Uint8Array) => void };

const enc = new TextEncoder();
const cat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const GOLDEN_ENTRIES = [
  { name: 'a.npy', data: new Uint8Array([1, 2, 3]) },
  { name: 'dir/中文 名稱.vti', data: enc.encode('hello vti') },
  { name: 'manifest.json', data: enc.encode('{"a":1}') },
];
/** 改成 ZipWriter 之前（commit 83d2256）的 zipStore 對同樣三個檔的輸出。 */
const GOLDEN =
  'UEsDBBQAAAgAAAAAAAAdgLxVAwAAAAMAAAAFAAAAYS5ucHkBAgNQSwMEFAAACAAAAAAAADNOiD4JAAAACQAAABUAAABkaXIv5Lit5paHIOWQjeeosS52dGloZWxsbyB2dGlQSwMEFAAACAAAAAAAAK+sG1YHAAAABwAAAA0AAABtYW5pZmVzdC5qc29ueyJhIjoxfVBLAQIUABQAAAgAAAAAAAAdgLxVAwAAAAMAAAAFAAAAAAAAAAAAAAAAAAAAAABhLm5weVBLAQIUABQAAAgAAAAAAAAzTog+CQAAAAkAAAAVAAAAAAAAAAAAAAAAACYAAABkaXIv5Lit5paHIOWQjeeosS52dGlQSwECFAAUAAAIAAAAAAAAr6wbVgcAAAAHAAAADQAAAAAAAAAAAAAAAABiAAAAbWFuaWZlc3QuanNvblBLBQYAAAAAAwADALEAAACUAAAAAAA=';
const goldenBytes = Uint8Array.from(atob(GOLDEN), (c) => c.charCodeAt(0));

/** 最小的 zip 目錄解析：end record（或 ZIP64 end record）→ central directory 的每一筆。 */
function readZip(z: Uint8Array) {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const end = z.length - 22;
  expect(dv.getUint32(end, true)).toBe(0x06054b50);
  let count = dv.getUint16(end + 10, true);
  let cdSize = dv.getUint32(end + 12, true);
  let cdOffset = dv.getUint32(end + 16, true);
  let zip64: { count: number; cdSize: number; cdOffset: number } | null = null;
  const loc = end - 20;
  if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
    const at = Number(dv.getBigUint64(loc + 8, true));
    expect(dv.getUint32(at, true)).toBe(0x06064b50);
    zip64 = { count: Number(dv.getBigUint64(at + 32, true)), cdSize: Number(dv.getBigUint64(at + 40, true)), cdOffset: Number(dv.getBigUint64(at + 48, true)) };
    expect(dv.getUint16(at + 12, true)).toBe(45);
    expect(dv.getUint16(at + 14, true)).toBe(45);
    expect(Number(dv.getBigUint64(at + 24, true))).toBe(zip64.count);
    expect(Number(dv.getBigUint64(loc + 8, true))).toBe(zip64.cdOffset + zip64.cdSize);
    count = zip64.count;
    cdSize = zip64.cdSize;
    cdOffset = zip64.cdOffset;
  }
  const entries: { name: string; size: number; crc: number; offset: number; version: number; extra: Uint8Array }[] = [];
  let at = cdOffset;
  for (let k = 0; k < count; k++) {
    expect(dv.getUint32(at, true)).toBe(0x02014b50);
    const version = dv.getUint16(at + 6, true);
    const crc = dv.getUint32(at + 16, true);
    let size = dv.getUint32(at + 24, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    let offset = dv.getUint32(at + 42, true);
    const name = new TextDecoder().decode(z.subarray(at + 46, at + 46 + nameLen));
    const extra = z.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen);
    if (extraLen) {
      const ev = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
      expect(ev.getUint16(0, true)).toBe(1);
      let p = 4;
      if (size === 0xffffffff) {
        size = Number(ev.getBigUint64(p, true));
        expect(Number(ev.getBigUint64(p + 8, true))).toBe(size);
        p += 16;
      }
      if (offset === 0xffffffff) {
        offset = Number(ev.getBigUint64(p, true));
        p += 8;
      }
      expect(ev.getUint16(2, true)).toBe(p - 4);
    }
    entries.push({ name, size, crc, offset, version, extra });
    at += 46 + nameLen + extraLen;
  }
  expect(at - cdOffset).toBe(cdSize);
  return { entries, zip64 };
}

/** local header 的欄位。 */
function readLocal(z: Uint8Array, at: number) {
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  expect(dv.getUint32(at, true)).toBe(0x04034b50);
  const version = dv.getUint16(at + 4, true);
  const crc = dv.getUint32(at + 14, true);
  const size32 = dv.getUint32(at + 22, true);
  const nameLen = dv.getUint16(at + 26, true);
  const extraLen = dv.getUint16(at + 28, true);
  const name = new TextDecoder().decode(z.subarray(at + 30, at + 30 + nameLen));
  let size = size32;
  if (extraLen) {
    const e = at + 30 + nameLen;
    expect(dv.getUint16(e, true)).toBe(1);
    expect(dv.getUint16(e + 2, true)).toBe(16);
    size = Number(dv.getBigUint64(e + 4, true));
    expect(Number(dv.getBigUint64(e + 12, true))).toBe(size);
  }
  return { version, crc, size32, size, name, dataAt: at + 30 + nameLen + extraLen };
}

/** Python zipfile 讀回檔名並 testzip（CRC 全對）；沒有 python3 就跳過。 */
async function pythonCheck(z: Uint8Array, names: string[]) {
  const { spawnSync } = await nodeMod<Spawn>('node:child_process');
  const { mkdtempSync, writeFileSync } = await nodeMod<Fs>('node:fs');
  const { tmpdir } = await nodeMod<{ tmpdir: () => string }>('node:os');
  const { join } = await nodeMod<{ join: (...p: string[]) => string }>('node:path');
  if (spawnSync('python3', ['-I', '-c', 'import zipfile'], { encoding: 'utf8' }).status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'zipw-'));
  const file = join(dir, 't.zip');
  writeFileSync(file, z);
  const py = `import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
print(json.dumps({"bad": bad, "names": z.namelist()}))`;
  const r = spawnSync('python3', ['-I', '-c', py, file], { encoding: 'utf8', maxBuffer: 64 << 20 });
  expect(r.status, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout) as { bad: string | null; names: string[] };
  expect(out.bad).toBeNull();
  expect(out.names).toEqual(names);
}

async function viaWriter(entries: { name: string; data: Uint8Array }[]) {
  const parts: Uint8Array[] = [];
  const w = new ZipWriter((p) => void parts.push(p));
  for (const e of entries) await w.add(e.name, e.data.length, crc32(e.data), [e.data]);
  await w.finish();
  return cat(parts);
}

describe('zip（plan v15 C2）', () => {
  it('crc32：標準值、分段接著算 === 一次算', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    const data = Uint8Array.from({ length: 10_007 }, (_, i) => (i * 131) & 255);
    const whole = crc32(data);
    for (const cut of [0, 1, 2, 3, 4, 5, 4096, 10_006, 10_007]) expect(crc32(data.subarray(cut), crc32(data.subarray(0, cut)))).toBe(whole);
  });

  it('zipStore 三個小檔 === 舊版黃金值；ZipWriter（async sink）也相同', async () => {
    const z = zipStore(GOLDEN_ENTRIES);
    expect(Array.from(z)).toEqual(Array.from(goldenBytes));
    expect(Array.from(await viaWriter(GOLDEN_ENTRIES))).toEqual(Array.from(goldenBytes));
    const { entries, zip64 } = readZip(z);
    expect(zip64).toBeNull();
    expect(entries.map((e) => e.name)).toEqual(GOLDEN_ENTRIES.map((e) => e.name));
    expect(entries.every((e) => e.version === 20 && !e.extra.length)).toBe(true);
    await pythonCheck(
      z,
      GOLDEN_ENTRIES.map((e) => e.name),
    );
  });

  it('資料分好幾段餵、sink 非同步：和一次給相同；長度不對會丟錯', async () => {
    const data = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 255);
    const parts: Uint8Array[] = [];
    const w = new ZipWriter(async (p) => {
      await new Promise((r) => setTimeout(r, 0));
      parts.push(p);
    });
    const pieces = [data.subarray(0, 1), data.subarray(1, 40_000), new Uint8Array(0), data.subarray(40_000)];
    await w.add('big.bin', data.length, crc32(data), pieces);
    await w.add('empty', 0, crc32(new Uint8Array(0)), []);
    await w.finish();
    const z = cat(parts);
    expect(Array.from(z)).toEqual(
      Array.from(
        zipStore([
          { name: 'big.bin', data },
          { name: 'empty', data: new Uint8Array(0) },
        ]),
      ),
    );
    await pythonCheck(z, ['big.bin', 'empty']);
    const w2 = new ZipWriter(() => {});
    await expect(w2.add('x', 5, 0, [new Uint8Array(3)])).rejects.toThrow(/5/);
  });

  it('ZIP64：5 GiB 的假 entry（只寫 header）→ local／central 0xFFFFFFFF＋extra、EOCD64＋locator、EOCD 欄位 clamp', () => {
    const w = new ZipWriter();
    const BIG = 5 * 2 ** 30;
    const h1 = w.entry('big.bin', BIG, 0x12345678);
    const h2 = w.entry('after.txt', 3, crc32(new Uint8Array([1, 2, 3])));
    const tail = w.close();
    // 檔案的樣子：[h1][5 GiB 資料][h2][3 B][central…]——資料不真的放，自己算位置
    const l1 = readLocal(h1, 0);
    expect(l1.version).toBe(45);
    expect(l1.size32).toBe(0xffffffff);
    expect(l1.size).toBe(BIG);
    expect(l1.crc).toBe(0x12345678);
    const l2 = readLocal(h2, 0);
    expect(l2.version).toBe(45); // offset ≥ 4 GiB 也算 ZIP64
    expect(l2.size32).toBe(0xffffffff);
    expect(l2.size).toBe(3);
    const cdOffset = h1.length + BIG + h2.length + 3;
    // 把 central directory 與 end record 放在一個假的位移上解析：用一個只含尾巴的陣列，再自己換算
    const tailBytes = cat(tail);
    const dv = new DataView(tailBytes.buffer);
    const end = tailBytes.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(2);
    expect(dv.getUint32(end + 16, true)).toBe(0xffffffff); // cd offset 超過 → clamp
    const loc = end - 20;
    expect(dv.getUint32(loc, true)).toBe(0x07064b50);
    const eocd64At = Number(dv.getBigUint64(loc + 8, true));
    const cdSize = tailBytes.length - 22 - 20 - 56;
    expect(eocd64At).toBe(cdOffset + cdSize);
    expect(dv.getUint32(0 + cdSize, true)).toBe(0x06064b50);
    expect(Number(dv.getBigUint64(cdSize + 4, true))).toBe(44);
    expect(Number(dv.getBigUint64(cdSize + 24, true))).toBe(2);
    expect(Number(dv.getBigUint64(cdSize + 32, true))).toBe(2);
    expect(Number(dv.getBigUint64(cdSize + 40, true))).toBe(cdSize);
    expect(Number(dv.getBigUint64(cdSize + 48, true))).toBe(cdOffset);
    // central entries
    expect(dv.getUint32(0, true)).toBe(0x02014b50);
    expect(dv.getUint16(6, true)).toBe(45);
    expect(dv.getUint32(20, true)).toBe(0xffffffff);
    expect(dv.getUint32(24, true)).toBe(0xffffffff);
    expect(dv.getUint32(42, true)).toBe(0); // 第一個 entry 的 offset 0
    const n1 = dv.getUint16(28, true);
    const x1 = dv.getUint16(30, true);
    expect(x1).toBe(4 + 16); // 兩個大小
    expect(dv.getUint16(46 + n1, true)).toBe(1);
    expect(Number(dv.getBigUint64(46 + n1 + 4, true))).toBe(BIG);
    const c2 = 46 + n1 + x1;
    expect(dv.getUint32(c2, true)).toBe(0x02014b50);
    expect(dv.getUint32(c2 + 24, true)).toBe(3); // 大小沒超過：照寫
    expect(dv.getUint32(c2 + 42, true)).toBe(0xffffffff); // offset 超過
    const n2 = dv.getUint16(c2 + 28, true);
    expect(dv.getUint16(c2 + 30, true)).toBe(4 + 8); // 只有 offset
    expect(Number(dv.getBigUint64(c2 + 46 + n2 + 4, true))).toBe(h1.length + BIG);
  });

  it('65,536 個空檔：EOCD 筆數 0xFFFF、ZIP64 end record 寫真正的筆數，central directory 每一筆都對', async () => {
    const parts: Uint8Array[] = [];
    const w = new ZipWriter((p) => void parts.push(p));
    const n = 65_536;
    const names: string[] = [];
    for (let k = 0; k < n; k++) {
      const name = `f${k}`;
      names.push(name);
      await w.add(name, 0, 0, []);
    }
    await w.finish();
    const z = cat(parts);
    const dv = new DataView(z.buffer);
    expect(dv.getUint16(z.length - 22 + 10, true)).toBe(0xffff);
    const { entries, zip64 } = readZip(z);
    expect(zip64?.count).toBe(n);
    expect(entries.length).toBe(n);
    expect(entries.map((e) => e.name)).toEqual(names);
    expect(entries.every((e) => e.version === 20 && e.size === 0 && !e.extra.length)).toBe(true);
    expect(readLocal(z, entries[n - 1].offset).name).toBe(`f${n - 1}`);
    await pythonCheck(z, names);
    // 65,534 個就不用 ZIP64
    const w2 = new ZipWriter();
    const small: Uint8Array[] = [];
    for (let k = 0; k < 65_534; k++) small.push(w2.entry(`g${k}`, 0, 0));
    small.push(...w2.close());
    expect(readZip(cat(small)).zip64).toBeNull();
  });
});
