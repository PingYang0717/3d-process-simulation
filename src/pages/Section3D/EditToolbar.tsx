// 編輯工具列（plan v10 §4.7）：選到結構才出現，在 3D／主切面上方。
// [瀏覽 | 3D 把手 | 2D 剖面 | 筆刷] 頁籤 ＋ 五顆操作按鈕（長／縮 · 方頭／圓頭 · 移動 · 材質 · 對應）。
// 未進聚焦時按鈕一樣在（按了直接開卡片，預覽照畫），只是 3D 上沒有把手。
import { Button, Divider, Flex, InputNumber, Popover, Segmented, Slider, Tooltip, Typography } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import type { Editor } from './editor';
import { OpButtons } from './OpCard';

const { Text } = Typography;

export type EditTab = 'browse' | 'handles' | '2d' | 'brush';
export const tabOf = (ed: Editor): EditTab => (!ed.focus ? 'browse' : ed.focus.view === '2d' ? '2d' : ed.focus.tool === 'brush' ? 'brush' : 'handles');

/** 筆刷設定：局部長／縮、局部方頭；半徑、圓／方。 */
function BrushSettings({ ed }: { ed: Editor }) {
  const br = ed.brush;
  const r = br.radius ?? 6;
  return (
    <Flex vertical gap={12} style={{ width: 280 }}>
      <Segmented
        block
        value={br.mode}
        onChange={(v) => ed.setBrush({ ...br, mode: v as 'push' | 'level' })}
        options={[
          { label: '局部長／縮', value: 'push' },
          { label: '局部方頭', value: 'level' },
        ]}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        {br.mode === 'push'
          ? '按住已選結構的面往外拉＝長、往回推＝縮，只改圈內，拖的時候就看得到結果。'
          : '點已選結構的一個面，圈內每一排都補到（或削到）跟它一樣高。整根要方頭請用「方頭／圓頭」。'}
      </Text>
      <Flex align="center" gap={10}>
        <span style={{ fontSize: 12, width: 40 }}>半徑</span>
        <Slider min={0} max={60} value={r} onChange={(v) => ed.setBrush({ ...br, radius: v })} style={{ flex: 1, margin: '0 4px' }} />
        <InputNumber size="small" min={0} max={500} value={r} onChange={(v) => v !== null && ed.setBrush({ ...br, radius: Math.round(v) })} suffix="vx" style={{ width: 88 }} />
      </Flex>
      <Flex align="center" gap={10}>
        <span style={{ fontSize: 12, width: 40 }}>形狀</span>
        <Segmented
          size="small"
          value={br.shape}
          onChange={(v) => ed.setBrush({ ...br, shape: v as 'round' | 'square' })}
          options={[
            { label: '圓', value: 'round' },
            { label: '方', value: 'square' },
          ]}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {br.shape === 'square' ? `${2 * r + 1}×${2 * r + 1} 格` : `直徑 ${2 * r + 1} 格`}（{((2 * r + 1) * ed.nmPerVoxel).toFixed(1)} nm）
        </Text>
      </Flex>
    </Flex>
  );
}

export function EditToolbar({ ed, onTab }: { ed: Editor; onTab: (t: EditTab) => void }) {
  const tab = tabOf(ed);
  const name = ed.selComps.length === 1 ? ed.selComps[0].label : `${ed.selComps.length} 個結構`;
  return (
    <div className="edit-toolbar" role="toolbar" aria-label="編輯工具列">
      <Tooltip title="E：瀏覽 → 3D 把手 → 2D 剖面 → 瀏覽；Esc 回到瀏覽（選取留著）">
        <Segmented
          size="small"
          value={tab}
          onChange={(v) => onTab(v as EditTab)}
          options={[
            { label: '瀏覽', value: 'browse' },
            { label: '3D 把手', value: 'handles' },
            { label: '2D 剖面', value: '2d' },
            { label: '筆刷', value: 'brush' },
          ]}
        />
      </Tooltip>
      {tab === 'brush' && (
        <Popover content={<BrushSettings ed={ed} />} trigger="click" placement="bottomLeft">
          <Button size="small" icon={<SettingOutlined />}>
            {ed.brush.mode === 'push' ? '局部長／縮' : '局部方頭'} {ed.brush.shape === 'square' ? '方' : '圓'}
            {ed.brush.radius ?? 6}
          </Button>
        </Popover>
      )}
      <Divider type="vertical" />
      <OpButtons ed={ed} plane={tab === '2d' ? ed.editAxis : undefined} />
      <span className="grow" />
      <Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 260 }}>
        {tab === 'browse'
          ? `已選 ${name}：按 E 進入聚焦編輯`
          : tab === 'handles'
            ? '拖箭頭＝整面長縮 · 拖角＝圓頭 · 其他地方拖＝轉視角'
            : tab === 'brush'
              ? '在已選結構的面上拖＝筆刷；其他地方拖＝轉視角'
              : '拖節點、邊、整塊；E 回瀏覽'}
      </Text>
    </div>
  );
}
