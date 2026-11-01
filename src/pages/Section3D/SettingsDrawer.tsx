import type { ReactNode } from 'react';
import { Button, Drawer, Flex, InputNumber, Select, Switch, Typography } from 'antd';
import { MatLabel } from '../../ui/Swatch';
import { Section } from '../../ui/Stat';
import type { Editor } from './editor';
import { usePersisted } from '../../ui/persist';
import { QUALITY_EVENT, type Quality, isQuality } from './views';

const { Text } = Typography;

function Row({ label, sub, children }: { label: string; sub?: string; children: ReactNode }) {
  return (
    <Flex justify="space-between" align="center" gap={12} className="set-row">
      <Flex vertical>
        <span>{label}</span>
        {sub && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {sub}
          </Text>
        )}
      </Flex>
      {children}
    </Flex>
  );
}

/** 不常動的東西（plan v10 §4.7）：襯層跟著推、回填、自動放大、多選對應、大操作先確認、nm 比例、重新載入。畫面怎麼顯示在 3D 上方「顯示」。 */
export function SettingsDrawer({
  ed,
  open,
  onClose,
  onLoad,
}: {
  ed: Editor;
  open: boolean;
  onClose: () => void;
  onLoad: () => void;
}) {
  // 畫質（plan v15 B6）：靜止時的 pixelRatio 上限；存 localStorage（se3d.v1.quality），改了立刻通知 3D（usePersisted 的寫入是 idle 時才落地）
  const [quality, setQuality] = usePersisted<Quality>('quality', 'standard', isQuality);
  const changeQuality = (q: Quality) => {
    setQuality(q);
    window.dispatchEvent(new CustomEvent(QUALITY_EVENT, { detail: q }));
  };
  return (
    <Drawer title="設定" open={open} onClose={onClose} width={380}>
      <Flex vertical gap={24}>
        <Section title="編輯方式">
          <Row label="推面時，外層薄層一起推" sub="HfO₂／TiN 這類襯層跟著位移，不會被蓋掉">
            <Switch checked={ed.follow} onChange={ed.setFollow} />
          </Row>
          <Row label="推面碰到厚的別的材質" sub="擋住：不穿過 fin／STI（預設）；蓋過去：v10 以前的行為。卡片上可以單張勾「允許穿過」">
            <Select
              value={ed.pushPolicy}
              onChange={ed.setPushPolicy}
              style={{ width: 150 }}
              options={[
                { value: 'block' as const, label: '擋住' },
                { value: 'overwrite' as const, label: '蓋過去' },
              ]}
            />
          </Row>
          <Row label="搬走／縮短後空出來的地方填" sub="「原本的內容」讓往上再往下、長高再縮短都能回到原點">
            <Select
              value={ed.backfill}
              onChange={ed.setBackfill}
              style={{ width: 150 }}
              options={[{ value: 'orig' as const, label: '原本的內容' }, ...ed.materials.map((m) => ({ value: m.id, label: <MatLabel mat={m} /> }))]}
            />
          </Row>
        </Section>
        <Section title="顯示">
          <Row label="套用後閃一下改到的範圍" sub="改後模式不標色；套用一步後在改到的外框畫橘色虛線，1.5 秒淡出（不碰網格）">
            <Switch checked={ed.stepFlash} onChange={ed.setStepFlash} />
          </Row>
          <Row label="畫質" sub="3D 靜止時每 CSS px 畫幾個點：標準 1.5（和 2 肉眼難辨、填色成本約一半）、高 2；轉視角、拖把手時都是 1">
            <Select
              value={quality}
              onChange={changeQuality}
              style={{ width: 150 }}
              options={[
                { value: 'standard' as const, label: '標準（1.5）' },
                { value: 'high' as const, label: '高（2）' },
              ]}
            />
          </Row>
        </Section>
        <Section title="Split 與記憶體">
          <Row
            label="同時保留在記憶體的 split"
            sub={`其他的只留改到的那一小塊（parked），要看或要改時再載入；0＝依模型大小自動（現在 ${ed.liveLimit} 個）。原始與目前的永遠在記憶體`}
          >
            <InputNumber min={0} max={64} value={ed.liveK} onChange={(v) => v !== null && ed.setLiveK(Math.round(v))} style={{ width: 90 }} />
          </Row>
          <Row label="復原記憶體上限" sub="每個 split 的復原堆疊最多佔這麼多（另外最多 50 步）；超過就從最早的一步開始釋放">
            <Select
              value={ed.histBytes}
              onChange={ed.setHistBytes}
              style={{ width: 110 }}
              options={[
                { value: 64, label: '64 MB' },
                { value: 256, label: '256 MB' },
                { value: 1024, label: '1 GB' },
              ]}
            />
          </Row>
        </Section>
        <Section title="2D 剖面">
          <Row label="選到結構時自動放大到它" sub="2D 剖面的主切面">
            <Switch checked={ed.autoZoom} onChange={ed.setAutoZoom} />
          </Row>
          <Row label="多選時對應到長得一樣的結構" sub="在一根 fin 上拖，其他長得一樣的 fin 一起改（同材質、長寬比與面積相近）">
            <Switch checked={ed.mirror} onChange={ed.setMirror} />
          </Row>
          <Row label="大操作先確認（進階）" sub="一步會動到的範圍超過這麼多格就先問">
            <InputNumber
              min={10}
              step={50}
              value={Math.round(ed.bigOp / 1e4)}
              onChange={(v) => v && v > 0 && ed.setBigOp(v * 1e4)}
              suffix="萬格"
              style={{ width: 130 }}
            />
          </Row>
        </Section>
        <Section title="進階">
          <Row label="自由形變" sub="2D 節點可任意拖、Shift＝單點、Alt＝自由衰減；容易畫出非物理的形狀，預設關（只有矩形角與推邊）">
            <Switch checked={ed.freeform} onChange={ed.setFreeform} />
          </Row>
          <Row label="筆刷" sub="編輯工具列多一個「筆刷」頁籤（局部長縮、局部方頭）；局部缺陷建議用「缺陷」">
            <Switch checked={ed.brushOn} onChange={ed.setBrushOn} />
          </Row>
        </Section>
        <Section title="單位">
          <Row label="1 voxel = ? nm" sub="只影響顯示的 nm 與 nm → voxel 換算">
            <InputNumber
              min={0.001}
              step={0.05}
              value={ed.nmPerVoxel}
              onChange={(v) => v && v > 0 && ed.setNmPerVoxel(v)}
              suffix="nm"
              style={{ width: 130 }}
            />
          </Row>
        </Section>
        <Button
          onClick={() => {
            onClose();
            onLoad();
          }}
        >
          重新載入 .vti／.npy…
        </Button>
      </Flex>
    </Drawer>
  );
}
