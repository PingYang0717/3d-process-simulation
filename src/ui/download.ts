import { zipStore } from '../volume/zip';

interface Downloads {
  save: (r: { filename: string; data: Blob | Uint8Array }) => Promise<unknown>;
}
declare global {
  interface Window {
    claude?: { use?: (name: string) => Promise<Downloads | null> };
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
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
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
