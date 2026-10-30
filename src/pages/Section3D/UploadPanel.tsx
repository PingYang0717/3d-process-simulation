import { useState } from 'react';
import { App, Button, Flex, Segmented, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { decodeNpy } from '../../volume/volume';
import { decodeVti } from '../../volume/vti';
import type { Editor } from './editor';

const { Text } = Typography;

/** 上傳 .vti（或 .npy），或用內建範例；大範例用來看 4,000 萬級的速度。 */
export function UploadPanel({ ed, onDone }: { ed: Editor; onDone: () => void }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [unit, setUnit] = useState<'nm' | 'um'>('nm');
  const load = async (file: File) => {
    setBusy(`讀取 ${file.name}…`);
    try {
      const buf = await file.arrayBuffer();
      if (/\.vti$/i.test(file.name)) {
        const { vol, info } = await decodeVti(buf);
        await ed.loadVolume(vol, {
          name: file.name,
          format: 'vti',
          spacing: info.spacing,
          origin: info.origin,
          arrayName: info.arrayName,
          arrays: info.arrays,
          unit,
        });
        message.success(
          `已載入 ${file.name}：${vol.X}×${vol.Y}×${vol.Z} voxels，${info.source}「${info.arrayName}」${info.dtype}${info.compressed ? '，zlib' : ''}`,
        );
      } else {
        const vol = decodeNpy(buf);
        await ed.loadVolume(vol, { name: file.name, format: 'npy' });
        message.success(`已載入 ${file.name}，shape (${vol.Z}, ${vol.Y}, ${vol.X})`);
      }
      onDone();
    } catch (e) {
      message.error((e as Error)?.message ?? '這個檔案讀不出來');
    } finally {
      setBusy(null);
    }
  };
  const demo = async (scale: number) => {
    setBusy('產生範例…');
    try {
      await ed.demo(scale);
      onDone();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Flex vertical gap={16}>
      <Upload.Dragger
        accept=".vti,.npy"
        showUploadList={false}
        disabled={!!busy}
        beforeUpload={(f) => {
          load(f);
          return false;
        }}
        style={{ padding: '20px 0' }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">{busy ?? '把 .vti（VTK ImageData）拖到這裡，或點一下選檔案'}</p>
        <p className="ant-upload-hint">
          材質編號放 CellData（UInt8／Int32 都可，浮點會依值重新編號）；ascii、base64、appended、zlib 壓縮都支援。也接受 .npy。
          載入後材質只有編號（「材質 n」），名稱與顏色在左欄自己改；0 當空、254 當空洞。
        </p>
      </Upload.Dragger>
      <Flex gap={16} align="center" wrap="wrap">
        <label className="field" style={{ flex: 'none', width: 220 }}>
          <span>.vti 的 Spacing 單位</span>
          <Segmented
            block
            value={unit}
            onChange={(v) => setUnit(v as 'nm' | 'um')}
            options={[
              { label: 'nm', value: 'nm' },
              { label: 'µm', value: 'um' },
            ]}
          />
        </label>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Spacing 會換成「1 voxel = ? nm」顯示用；匯出時原封不動寫回。
        </Text>
      </Flex>
      <Flex gap={8} align="center" wrap="wrap">
        <Text type="secondary">手邊還沒有檔案？</Text>
        <Button disabled={!!busy} onClick={() => demo(1)}>
          用範例試試看（197 萬 voxels）
        </Button>
        <Button disabled={!!busy} onClick={() => demo(2)}>
          大範例 ×2（1,570 萬）
        </Button>
        <Button disabled={!!busy} onClick={() => demo(3)}>
          大範例 ×3（5,300 萬）
        </Button>
      </Flex>
      <Text type="secondary" style={{ fontSize: 12 }}>
        範例：3 根 fin × 3 根 poly，Poly-Si 3 裡有 bamboo defect。大範例用來看 4,000 萬級的速度。
      </Text>
    </Flex>
  );
}
