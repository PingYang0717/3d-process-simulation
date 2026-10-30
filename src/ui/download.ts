import { zipStore } from '../volume/zip';

interface Downloads {
  save: (r: { filename: string; data: Blob | Uint8Array }) => Promise<unknown>;
}
declare global {
  interface Window {
    claude?: { use?: (name: string) => Promise<Downloads | null> };
  }
}

/**
 * 讓瀏覽器存檔。放在 claude.ai artifact 檢視器裡時沒有直接下載的權限，改走它的 downloads 能力；
 * 它只接受固定幾種副檔名（.zip 可以、.vti／.npy 不行），被拒絕時就把單一檔案包成 .zip 再存。
 */
export async function download(data: Uint8Array | Blob, filename: string, type = 'application/octet-stream') {
  const viewer = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (!viewer) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return filename;
  }
  try {
    await viewer.save({ filename, data });
    return filename;
  } catch (e) {
    if ((e as { code?: string })?.code !== 'rejected_extension') throw e;
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
    const zipped = `${filename}.zip`;
    await viewer.save({ filename: zipped, data: zipStore([{ name: filename, data: bytes }]) });
    return zipped;
  }
}
