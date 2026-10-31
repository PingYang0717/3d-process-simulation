import { useState } from 'react';
import { Alert, App, Button, Checkbox, Flex, InputNumber, Segmented, Steps, Table, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { type Material, decodeNpy } from '../../volume/volume';
import { type VtiInspect, decodeVti, inspectVti } from '../../volume/vti';
import type { Editor } from './editor';

const { Text } = Typography;

const STEPS = ['讀取', '解碼', '分析結構'];

/** 上傳 .vti（或 .npy），或用內建範例；大範例用來看 4,000 萬級的速度。 */
export function UploadPanel({ ed, onDone }: { ed: Editor; onDone: () => void }) {
  const { message } = App.useApp();
  /** 進行中的階段（0 讀取、1 解碼、2 分析結構）與說明；null = 閒置。 */
  const [progress, setProgress] = useState<{ step: number; text: string } | null>(null);
  const busy = progress?.text ?? null;
  const setBusy = (text: string | null, step = 0) => setProgress(text === null ? null : { step, text });
  const [unit, setUnit] = useState<'nm' | 'um'>('nm');
  /** 偵測到比例陣列或 FieldData：先列出來給使用者確認（plan v11 §4.0 上傳面板），再載入。 */
  const [pending, setPending] = useState<{ file: File; buf: ArrayBuffer; ins: VtiInspect; pick: Record<string, number | null> } | null>(null);
  const loadVti = async (file: File, buf: ArrayBuffer, fractions?: { name: string; id: number }[]) => {
    setBusy('解碼 .vti…', 1);
    const { vol, info } = await decodeVti(buf, fractions ? { fractions } : {});
    setBusy(`分析 ${(vol.data.length / 1e6).toFixed(1)} M voxels 的結構…`, 2);
    // FieldData 的材質表：代碼對得上的用它的名字與顏色，其他仍是「材質 n」
    const mats: Material[] | undefined = info.fieldData
      ?.filter((f) => f.code > 0 && f.code <= 254)
      .map((f) => ({ id: f.code, name: f.name ?? `材質 ${f.code}`, color: f.color ?? '#808080' }));
    await ed.loadVolume(
      vol,
      {
        name: file.name,
        format: 'vti',
        spacing: info.spacing,
        origin: info.origin,
        arrayName: info.arrayName,
        arrays: info.arrays,
        unit,
        ...(info.fractions ? { raw: buf, fractions: info.fractions } : {}),
        materialSource: mats?.length ? 'FieldData' : 'auto',
        input: { source: info.source, ...(info.fractions ? { fractionArrays: info.fractions.map((f) => f.name) } : {}), fieldData: !!info.fieldData, dtype: info.dtype, compressed: info.compressed },
      },
      mats?.length ? mats : undefined,
    );
    message.success(
      info.fractions
        ? `已載入 ${file.name}：${vol.X}×${vol.Y}×${vol.Z} 點，${info.fractions.length} 個比例陣列取最大者${info.fieldData ? `，FieldData 材質表 ${info.fieldData.length} 筆` : ''}`
        : `已載入 ${file.name}：${vol.X}×${vol.Y}×${vol.Z} voxels，${info.source}「${info.arrayName}」${info.dtype}${info.compressed ? '，zlib' : ''}`,
    );
  };
  const load = async (file: File) => {
    setBusy(`讀取 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`);
    try {
      const buf = await file.arrayBuffer();
      if (/\.vti$/i.test(file.name)) {
        const ins = await inspectVti(buf);
        if (ins.fractions.length || ins.fieldData) {
          setPending({ file, buf, ins, pick: Object.fromEntries(ins.arrays.map((a) => [a.name, a.matched])) });
          return;
        }
        await loadVti(file, buf);
      } else {
        setBusy('解碼 .npy…', 1);
        const vol = decodeNpy(buf);
        setBusy(`分析 ${(vol.data.length / 1e6).toFixed(1)} M voxels 的結構…`, 2);
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
  const confirm = async () => {
    if (!pending) return;
    const fractions = Object.entries(pending.pick)
      .filter((e): e is [string, number] => e[1] !== null && e[1] > 0)
      .map(([name, id]) => ({ name, id }));
    const p = pending;
    setPending(null);
    try {
      await loadVti(p.file, p.buf, fractions);
      onDone();
    } catch (e) {
      message.error((e as Error)?.message ?? '這個檔案讀不出來');
    } finally {
      setBusy(null);
    }
  };
  const demo = async (scale: number) => {
    setBusy(scale > 1 ? `產生大範例 ×${scale} 並分析結構（要幾秒）…` : '產生範例…', 2);
    try {
      await ed.demo(scale);
      onDone();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Flex vertical gap={16}>
      {progress && (
        <div className="load-progress" role="status" aria-live="polite">
          <Steps size="small" current={progress.step} items={STEPS.map((title) => ({ title }))} />
          <Text strong style={{ fontSize: 13 }}>
            {progress.text}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            第 {progress.step + 1} 步，共 {STEPS.length} 步；4,000 萬 voxel 約需十幾秒。
          </Text>
        </div>
      )}
      {pending && (
        <div className="load-confirm" role="dialog" aria-label="確認偵測結果">
          <Text strong>
            {pending.file.name}：{pending.ins.source} {pending.ins.fractions.length ? `比例陣列 ${pending.ins.fractions.length} 個（${pending.ins.fractions.map((f) => f.name).join('、')}）→ 每點取最大者` : '沒有比例陣列'}
            {pending.ins.fieldData ? `；FieldData 材質表 ${pending.ins.fieldData.length} 筆（${pending.ins.fieldData.map((f) => f.name ?? f.code).join('、')}）` : ''}；點數 {pending.ins.dims.join('×')}
          </Text>
          {pending.ins.fieldWarn && <Alert type="warning" showIcon message={pending.ins.fieldWarn} />}
          <Table
            size="small"
            pagination={false}
            rowKey="name"
            dataSource={pending.ins.arrays}
            rowClassName={(r) => (r.matched === null && r.comps === 1 ? 'row-warn' : '')}
            columns={[
              {
                title: '比例陣列',
                key: 'use',
                width: 70,
                render: (_: unknown, r) => (
                  <Checkbox
                    disabled={r.comps !== 1}
                    checked={pending.pick[r.name] !== null}
                    onChange={(e) => setPending({ ...pending, pick: { ...pending.pick, [r.name]: e.target.checked ? r.matched ?? nextFree(pending.pick) : null } })}
                  />
                ),
              },
              { title: '陣列', dataIndex: 'name', key: 'name', render: (n: string, r) => <span style={{ color: r.matched === null && r.comps === 1 ? 'var(--c-warn, #d4880f)' : undefined }}>{n}</span> },
              { title: '型別', dataIndex: 'dtype', key: 'dtype', width: 76 },
              {
                title: '材質編號',
                key: 'id',
                width: 96,
                render: (_: unknown, r) =>
                  pending.pick[r.name] === null ? (
                    '—'
                  ) : (
                    <InputNumber size="small" min={1} max={254} value={pending.pick[r.name]} onChange={(v) => v !== null && setPending({ ...pending, pick: { ...pending.pick, [r.name]: v } })} />
                  ),
              },
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            名稱不像 material_k 的陣列標橘色；勾選並填編號就會一起當比例陣列。匯出時照原格式寫回（未改點每個陣列原值不動，改點新材質 1、其他 0）。
          </Text>
          <Flex gap={8} justify="end">
            <Button onClick={() => setPending(null)}>取消</Button>
            <Button type="primary" onClick={confirm}>
              載入
            </Button>
          </Flex>
        </div>
      )}
      <Upload.Dragger
        accept=".vti,.npy"
        showUploadList={false}
        disabled={!!busy || !!pending}
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
          PointData 每個材質一個比例陣列（material_1、material_2…）時每點取最大者，FieldData 的材質表當名稱與顏色；
          或材質編號放 CellData（UInt8／Int32 都可，浮點會依值重新編號）。ascii、base64、appended、zlib 都支援。也接受 .npy。
          沒有材質表時材質只有編號（「材質 n」），名稱與顏色在左欄自己改；0 當空、254 當空洞。
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

/** 手動勾選時給的編號：還沒用過的最小編號。 */
function nextFree(pick: Record<string, number | null>) {
  const used = new Set(Object.values(pick).filter((v): v is number => v !== null));
  let k = 1;
  while (used.has(k)) k++;
  return k;
}
