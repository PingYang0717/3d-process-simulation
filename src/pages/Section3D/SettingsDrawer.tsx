import type { ReactNode } from 'react';
import { Button, Drawer, Flex, InputNumber, Select, Switch, Typography } from 'antd';
import { MatLabel } from '../../ui/Swatch';
import { Section } from '../../ui/Stat';
import type { Editor } from './editor';

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
  return (
    <Drawer title="設定" open={open} onClose={onClose} width={380}>
      <Flex vertical gap={24}>
        <Section title="編輯方式">
          <Row label="推面時，外層薄層一起推" sub="HfO₂／TiN 這類襯層跟著位移，不會被蓋掉">
            <Switch checked={ed.follow} onChange={ed.setFollow} />
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
