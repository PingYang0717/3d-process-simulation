
export function Swatch({ fill, isVoid: v, size = 12 }: { fill: string; isVoid?: boolean; size?: number }) {
  return (
    <span
      className={'swatch' + (v ? ' void' : '')}
      style={{ width: size, height: size, background: v ? undefined : fill }}
      aria-hidden="true"
    />
  );
}

