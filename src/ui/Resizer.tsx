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
        // pointermove 只累積位移，一幀一次 onDrag（plan v15 B2：欄寬進整頁 state，不要每個原始事件都整頁 render）
        let acc = 0;
        let raf = 0;
        const flush = () => {
          raf = 0;
          if (!acc) return;
          const d = acc;
          acc = 0;
          onDrag(d);
        };
        const move = (ev: PointerEvent) => {
          const q = horizontal ? ev.clientY : ev.clientX;
          acc += q - p;
          p = q;
          if (!raf) raf = requestAnimationFrame(flush);
        };
        const up = () => {
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          if (raf) cancelAnimationFrame(raf);
          flush();
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      }}
    />
  );
}
