// 可拖拉的分隔線（編輯頁左右欄、實驗頁設計欄寬度、結構預覽高度共用）：
// 滑鼠／觸控拖、鍵盤方向鍵（Shift 一次 48 px）、role=separator 報告目前值。
export function Resizer({ onDrag, label, value, min, max, horizontal }: { onDrag: (d: number) => void; label: string; value: number; min: number; max: number; horizontal?: boolean }) {
  const keys = horizontal ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
  return (
    <div
      className={'resizer' + (horizontal ? ' h' : '')}
      role="separator"
      aria-orientation={horizontal ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title={label + '：拖拉或用方向鍵'}
      onKeyDown={(e) => {
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        onDrag((e.key === keys[1] ? 1 : -1) * (e.shiftKey ? 48 : 16));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let p = horizontal ? e.clientY : e.clientX;
        const move = (ev: PointerEvent) => {
          const q = horizontal ? ev.clientY : ev.clientX;
          onDrag(q - p);
          p = q;
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}
