import { Flex } from 'antd';
import { type Material, isVoid } from '../volume/volume';

export function Swatch({ fill, isVoid: v, size = 12 }: { fill: string; isVoid?: boolean; size?: number }) {
  return (
    <span
      className={'swatch' + (v ? ' void' : '')}
      style={{ width: size, height: size, background: v ? undefined : fill }}
      aria-hidden="true"
    />
  );
}

export function MatLabel({ mat }: { mat: Material }) {
  return (
    <Flex align="center" gap={8}>
      <Swatch fill={mat.color} isVoid={isVoid(mat.id)} />
      {mat.name}
    </Flex>
  );
}
