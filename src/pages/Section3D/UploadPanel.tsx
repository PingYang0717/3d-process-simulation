import { useState } from 'react';
import { App, Button, Flex, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { decodeNpy, demoVolume } from '../../volume/volume';
import type { Editor } from './editor';

const { Text } = Typography;

export function UploadPanel({ ed, onDone }: { ed: Editor; onDone: () => void }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const load = async (file: File) => {
    setBusy(true);
    try {
      const vol = decodeNpy(await file.arrayBuffer());
      ed.loadVolume(vol, file.name);
      message.success(`已載入 ${file.name}，shape (${vol.Z}, ${vol.Y}, ${vol.X})`);
      onDone();
    } catch (e) {
      message.error((e as Error)?.message ?? '這個檔案讀不出來');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Flex vertical gap={16}>
      <Upload.Dragger
        accept=".npy"
        showUploadList={false}
        disabled={busy}
        beforeUpload={(f) => {
          load(f);
          return false;
        }}
        style={{ padding: '20px 0' }}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">把 np.save 存出來的 .npy 拖到這裡，或點一下選檔案</p>
        <p className="ant-upload-hint">dtype uint8（材質編號，0 = Air），shape (Z, Y, X)。匯出時 shape、dtype 都不變。</p>
      </Upload.Dragger>
      <Flex gap={12} align="center">
        <Text type="secondary">手邊還沒有陣列？</Text>
        <Button
          onClick={() => {
            ed.loadVolume(demoVolume());
            onDone();
          }}
        >
          用範例試試看（3 根 fin × 3 根 poly，Poly-Si 3 裡有 bamboo defect）
        </Button>
      </Flex>
    </Flex>
  );
}
