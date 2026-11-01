// 只儲存不壓縮的 zip（store only），不加套件。
// plan v15 C2：ZipWriter 一個 entry 一個 entry 寫出去（sink），central directory 留在記憶體；
// 任一 entry 大小／offset ≥ 4 GiB 或 entry 數 ≥ 65535 才寫 ZIP64 記錄，否則位元組和舊的 zipStore 完全相同。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32（IEEE）。prev＝接著上一段算：crc32(b, crc32(a)) === crc32(ab)，分段餵資料（parts）時用。 */
export function crc32(data: Uint8Array, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  const n = data.length;
  let i = 0;
  // 一次 4 個位元組展開，少一點迴圈成本（結果和逐位元組相同）
  for (const n4 = n - 3; i < n4; i += 4) {
    c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
    c = CRC_TABLE[(c ^ data[i + 1]) & 255] ^ (c >>> 8);
    c = CRC_TABLE[(c ^ data[i + 2]) & 255] ^ (c >>> 8);
    c = CRC_TABLE[(c ^ data[i + 3]) & 255] ^ (c >>> 8);
  }
  for (; i < n; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const u16 = (n: number) => [n & 255, (n >> 8) & 255];
const u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
/** 64 位元無號（JS number，≤ 2^53）。 */
const u64 = (n: number) => [...u32(n % 0x100000000), ...u32(Math.floor(n / 0x100000000))];
const LIMIT32 = 0xffffffff;
const LIMIT16 = 0xffff;
const enc = new TextEncoder();

/** 收 zip 位元組的地方（寫檔串流、Blob parts、或測試收集）。 */
export type ZipSink = (part: Uint8Array) => void | Promise<void>;

/**
 * 邊寫邊丟的 zip（store only，檔名 UTF-8，general purpose bit 11）。
 * - 同步 API：`entry(name, size, crc)` 回 local header，呼叫端自己把 header 與剛好 size 個位元組的資料依序送出；
 *   最後 `close()` 回 central directory ＋ end record。`zipStore` 與測試用這條。
 * - 非同步 API：`add(name, size, crc, parts)`／`finish()` 走建構時給的 sink。
 * 大小與 CRC 事先知道，所以不用 data descriptor；每個 entry 寫完就能丟掉資料。
 */
export class ZipWriter {
  private central: Uint8Array[] = [];
  private centralSize = 0;
  private offset = 0;
  private count = 0;
  private zip64 = false;
  private closed = false;

  constructor(private readonly sink: ZipSink = () => {}) {}

  /** 到目前為止寫出的位元組數（下一個 local header 的位置）。 */
  get bytesWritten() {
    return this.offset;
  }

  /** 登記一個 entry，回 local header；接著要送出剛好 size 個位元組的資料。 */
  entry(name: string, size: number, crc: number): Uint8Array {
    if (this.closed) throw new Error('zip 已經結束');
    const nm = enc.encode(name);
    const start = this.offset;
    const bigSize = size >= LIMIT32;
    const bigOff = start >= LIMIT32;
    const big = bigSize || bigOff;
    if (big) this.zip64 = true;
    // local header：ZIP64 時大小欄寫 0xFFFFFFFF，extra 0x0001 裡放真正的（原始、壓縮）兩個大小
    const localExtra = big ? [...u16(1), ...u16(16), ...u64(size), ...u64(size)] : [];
    const local = new Uint8Array([
      ...[0x50, 0x4b, 3, 4],
      ...u16(big ? 45 : 20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(big ? LIMIT32 : size),
      ...u32(big ? LIMIT32 : size),
      ...u16(nm.length),
      ...u16(localExtra.length),
      ...nm,
      ...localExtra,
    ]);
    // central directory：只有超過的欄位才進 ZIP64 extra（順序：原始大小、壓縮大小、offset）
    const cExtraBody = [...(bigSize ? [...u64(size), ...u64(size)] : []), ...(bigOff ? u64(start) : [])];
    const cExtra = cExtraBody.length ? [...u16(1), ...u16(cExtraBody.length), ...cExtraBody] : [];
    const c = new Uint8Array([
      ...[0x50, 0x4b, 1, 2],
      ...u16(big ? 45 : 20),
      ...u16(big ? 45 : 20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(bigSize ? LIMIT32 : size),
      ...u32(bigSize ? LIMIT32 : size),
      ...u16(nm.length),
      ...u16(cExtra.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(bigOff ? LIMIT32 : start),
      ...nm,
      ...cExtra,
    ]);
    this.central.push(c);
    this.centralSize += c.length;
    this.offset += local.length + size;
    this.count++;
    return local;
  }

  /** 結束：central directory、（需要時）ZIP64 end record＋locator、end record。 */
  close(): Uint8Array[] {
    if (this.closed) throw new Error('zip 已經結束');
    this.closed = true;
    const cdStart = this.offset;
    const cdSize = this.centralSize;
    const out = [...this.central];
    const need64 = this.zip64 || this.count >= LIMIT16 || cdSize >= LIMIT32 || cdStart >= LIMIT32;
    if (need64) {
      out.push(
        new Uint8Array([
          ...[0x50, 0x4b, 6, 6],
          ...u64(44), // 這筆記錄剩下的長度
          ...u16(45),
          ...u16(45),
          ...u32(0),
          ...u32(0),
          ...u64(this.count),
          ...u64(this.count),
          ...u64(cdSize),
          ...u64(cdStart),
        ]),
        new Uint8Array([...[0x50, 0x4b, 6, 7], ...u32(0), ...u64(cdStart + cdSize), ...u32(1)]),
      );
    }
    out.push(
      new Uint8Array([
        ...[0x50, 0x4b, 5, 6],
        ...u16(0),
        ...u16(0),
        ...u16(Math.min(this.count, LIMIT16)),
        ...u16(Math.min(this.count, LIMIT16)),
        ...u32(Math.min(cdSize, LIMIT32)),
        ...u32(Math.min(cdStart, LIMIT32)),
        ...u16(0),
      ]),
    );
    this.central = [];
    return out;
  }

  /** 一個 entry：local header 與 parts 依序送進 sink。parts 的總長度必須剛好是 size。 */
  async add(name: string, size: number, crc: number, parts: Iterable<Uint8Array>): Promise<void> {
    await this.sink(this.entry(name, size, crc));
    let written = 0;
    for (const p of parts) {
      if (!p.length) continue;
      await this.sink(p);
      written += p.length;
    }
    if (written !== size) throw new Error(`zip entry ${name}：資料 ${written} 位元組，和登記的 ${size} 不同`);
  }

  /** 結束並把 central directory 與 end record 送進 sink。 */
  async finish(): Promise<void> {
    for (const p of this.close()) await this.sink(p);
  }
}

/** 一次給全部 entries、回一塊位元組（ZipWriter 的包裝；小檔案的位元組和以前完全相同）。 */
export function zipStore(entries: ZipEntry[]): Uint8Array {
  const w = new ZipWriter();
  const parts: Uint8Array[] = [];
  for (const e of entries) parts.push(w.entry(e.name, e.data.length, crc32(e.data)), e.data);
  parts.push(...w.close());
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
