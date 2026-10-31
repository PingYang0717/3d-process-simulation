import type { ReactNode } from 'react';
import { Space } from 'antd';
import type { Axis } from '../../volume/volume';
import type { Editor } from './editor';
import { OpButtons } from './OpCard';

/**
 * 浮動工具列（plan v7 §5.4 → v10 §4.7）：選到結構時貼在主切面的選取外框旁。
 * 和 3D 編輯工具列是同一組按鈕、開同一張卡片（方向只開放切面上的四個）。
 */
export function FloatingToolbar({ ed, axis, roundPart }: { ed: Editor; axis: Axis; roundPart?: ReactNode }) {
  return (
    <Space.Compact size="small" className="float-tb-inner">
      <OpButtons ed={ed} plane={axis} roundPart={roundPart} />
    </Space.Compact>
  );
}
