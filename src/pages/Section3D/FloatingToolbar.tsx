import { Space } from 'antd';
import type { Axis } from '../../volume/volume';
import type { Editor } from './editor';
import { CARD_USES, OpButtons } from './OpCard';
import { memoEd } from '../../ui/memoEd';

/**
 * 浮動工具列（plan v7 §5.4 → v10 §4.7）：選到結構時貼在主切面的選取外框旁。
 * 和 3D 編輯工具列是同一組按鈕、開同一張卡片（方向只開放切面上的四個）。
 */
function FloatingToolbarImpl({ ed, axis }: { ed: Editor; axis: Axis }) {
  return (
    <Space.Compact size="small" className="float-tb-inner">
      <OpButtons ed={ed} plane={axis} />
    </Space.Compact>
  );
}

export const FloatingToolbar = memoEd(FloatingToolbarImpl, CARD_USES, 'FloatingToolbar');
