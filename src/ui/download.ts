import { zipStore } from '../volume/zip';

interface Downloads {
  save: (r: { filename: string; data: Blob | Uint8Array }) => Promise<unknown>;
}
/** File System Access API（Chromium）：lib.dom 沒有 showSaveFilePicker 的宣告，自己補最小的。 */
interface SavePickerOptions {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}
declare global {
  interface Window {
    claude?: { use?: (name: string) => Promise<Downloads | null> };
    showSaveFilePicker?: (opts?: SavePickerOptions) => Promise<FileSystemFileHandle>;
  }
}

/** 可以下載的資料：一塊位元組、好幾段（直接餵 Blob，不必先接成一塊）、或 Blob。 */
export type DownloadData = Uint8Array | Uint8Array[] | Blob;

const toBlob = (data: DownloadData, type: string) => (data instanceof Blob ? data : new Blob(Array.isArray(data) ? data : [data], { type }));
const toBytes = async (data: DownloadData) => {
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (!Array.isArray(data)) return data;
  const out = new Uint8Array(data.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of data) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
/** 使用者取消：呼叫端用 e.code === 'declined' 認出來、不報錯。 */
const declined = () => Object.assign(new Error('declined'), { code: 'declined' });

/**
 * 讓瀏覽器存檔。放在 claude.ai artifact 檢視器裡時沒有直接下載的權限，改走它的 downloads 能力；
 * 它只接受固定幾種副檔名（.zip 可以、.vti／.npy 不行），被拒絕時就把單一檔案包成 .zip 再存。
 */
export async function download(data: DownloadData, filename: string, type = 'application/octet-stream') {
  const viewer = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (!viewer) {
    const url = URL.createObjectURL(toBlob(data, type));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return filename;
  }
  try {
    await viewer.save({ filename, data: Array.isArray(data) ? toBlob(data, type) : data });
    return filename;
  } catch (e) {
    if ((e as { code?: string })?.code !== 'rejected_extension') throw e;
    const zipped = `${filename}.zip`;
    await viewer.save({ filename: zipped, data: zipStore([{ name: filename, data: await toBytes(data) }]) });
    return zipped;
  }
}

/** 邊產生邊寫的存檔目標（plan v15 C2）：write 幾次、close 一次；close 回實際存的檔名。 */
export interface SaveSink {
  write(part: Uint8Array): Promise<void>;
  /** 結束並存檔；回檔名。 */
  close(): Promise<string>;
  /** 放棄（出錯時）：串流寫檔的話把半成品刪掉。 */
  abort(): Promise<void>;
  /** 'stream'＝直接寫磁碟（showSaveFilePicker）；'blob'＝先收 parts 最後 download。 */
  kind: 'stream' | 'blob';
}

/**
 * 開一個存檔目標。Chromium 有 showSaveFilePicker 時先問使用者要存哪（**要在使用者手勢裡呼叫**，之後再慢慢寫），
 * 寫進 FileSystemWritableFileStream，主執行緒不必留整個檔；取消丟 code='declined'。其他瀏覽器、artifact 檢視器、
 * 或 picker 被關掉（localStorage noSavePicker=1，e2e 用）時收 parts，close 時 new Blob(parts) 走 download()。
 */
export async function openSaveSink(filename: string, type = 'application/octet-stream', opts: { picker?: boolean } = {}): Promise<SaveSink> {
  const blobSink = (): SaveSink => {
    const parts: Uint8Array[] = [];
    return {
      kind: 'blob',
      write: async (p) => void parts.push(p),
      close: () => download(parts, filename, type),
      abort: async () => void parts.splice(0),
    };
  };
  const pickerOff = opts.picker === false || (typeof localStorage !== 'undefined' && localStorage.getItem('noSavePicker') === '1');
  const inViewer = !!window.claude?.use;
  if (pickerOff || inViewer || typeof window.showSaveFilePicker !== 'function') return blobSink();
  let handle: FileSystemFileHandle;
  try {
    const ext = filename.match(/\.[^.]+$/)?.[0];
    handle = await window.showSaveFilePicker({ suggestedName: filename, ...(ext ? { types: [{ description: ext.slice(1).toUpperCase(), accept: { [type]: [ext] } }] } : {}) });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw declined();
    // 沒有使用者手勢、不支援這種 type 之類的：退回 Blob
    return blobSink();
  }
  const w = await handle.createWritable();
  return {
    kind: 'stream',
    write: (p) => w.write(p),
    close: async () => {
      await w.close();
      return handle.name || filename;
    },
    abort: () => w.abort(),
  };
}
