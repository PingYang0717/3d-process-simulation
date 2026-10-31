// 六面小方塊（plan v10 §4.4）：方向不再是抽象下拉。等角小立方體看得到的三面（上、右、後）直接點，
// 看不到的三面（下、左、前）是旁邊的虛線小按鈕。滑過時 3D 的選取外框對應那一面亮橘色＋箭頭（onHover）。
import { Tooltip } from 'antd';
import type { Vec3 } from '../../volume/volume';
import { dirLabel } from './opWords';

const same = (a: Vec3 | null | undefined, b: Vec3) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const UP: Vec3 = [0, -1, 0];
const DOWN: Vec3 = [0, 1, 0];
const LEFT: Vec3 = [-1, 0, 0];
const RIGHT: Vec3 = [1, 0, 0];
const FRONT: Vec3 = [0, 0, -1];
const BACK: Vec3 = [0, 0, 1];
export const SIX: Vec3[] = [UP, DOWN, LEFT, RIGHT, FRONT, BACK];

// 等角投影：中心 (48, 46)，邊長 ~22
const C = { x: 48, y: 46 };
const A = 20;
const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(' ');
/** 看得到的三面：上（−y）、右（+x）、後（+z，預設視角朝向觀者那一面）。 */
const FACES: { d: Vec3; poly: [number, number][]; arrow: [number, number] }[] = [
  {
    d: UP,
    poly: [
      [C.x, C.y - A],
      [C.x + A * 0.95, C.y - A / 2],
      [C.x, C.y],
      [C.x - A * 0.95, C.y - A / 2],
    ],
    arrow: [C.x, C.y - A / 2],
  },
  {
    d: BACK,
    poly: [
      [C.x - A * 0.95, C.y - A / 2],
      [C.x, C.y],
      [C.x, C.y + A],
      [C.x - A * 0.95, C.y + A / 2],
    ],
    arrow: [C.x - A * 0.48, C.y + A / 4],
  },
  {
    d: RIGHT,
    poly: [
      [C.x, C.y],
      [C.x + A * 0.95, C.y - A / 2],
      [C.x + A * 0.95, C.y + A / 2],
      [C.x, C.y + A],
    ],
    arrow: [C.x + A * 0.48, C.y + A / 4],
  },
];
/** 看不到的三面：畫在對面的小按鈕。 */
const HIDDEN: { d: Vec3; at: [number, number]; text: string }[] = [
  { d: DOWN, at: [C.x, C.y + A + 16], text: '下' },
  { d: LEFT, at: [C.x - A - 18, C.y], text: '左' },
  { d: FRONT, at: [C.x + A + 18, C.y - A + 2], text: '前' },
];
const SHORT: Record<string, string> = { '0,-1,0': '上', '1,0,0': '右', '0,0,1': '後' };

export function FacePicker({
  value,
  onChange,
  onHover,
  allowed,
  size = 96,
  pair,
}: {
  value: Vec3 | null;
  onChange: (d: Vec3) => void;
  onHover?: (d: Vec3 | null) => void;
  /** 只開放這些方向（2D 剖面裡只有切面上的四個）；省略＝六個。 */
  allowed?: Vec3[];
  size?: number;
  /** 軸模式（plan v11 §4.5 cd）：value 和它的對面一起亮，點任一面選那一軸。 */
  pair?: boolean;
}) {
  const ok = (d: Vec3) => !allowed || allowed.some((a) => same(a, d));
  const opposite = value ? ([-value[0], -value[1], -value[2]] as Vec3) : null;
  const hover = (d: Vec3 | null) => onHover?.(d);
  return (
    <svg
      className="face-picker"
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="radiogroup"
      aria-label="方向"
      onPointerLeave={() => hover(null)}
    >
      {FACES.map(({ d, poly, arrow }) => {
        const on = same(value, d) || (!!pair && same(opposite, d));
        const can = ok(d);
        return (
          <Tooltip key={d.join()} title={dirLabel(d)} mouseEnterDelay={0.3}>
            <g
              role="radio"
              aria-checked={on}
              aria-disabled={!can}
              aria-label={dirLabel(d)}
              tabIndex={can ? 0 : -1}
              className={'fp-face' + (on ? ' on' : '') + (can ? '' : ' off')}
              onPointerEnter={() => can && hover(d)}
              onClick={() => can && onChange(d)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && can && (e.preventDefault(), onChange(d))}
            >
              <polygon points={pts(poly)} />
              <text x={arrow[0]} y={arrow[1] + 4} textAnchor="middle">
                {SHORT[d.join()]}
              </text>
            </g>
          </Tooltip>
        );
      })}
      {HIDDEN.map(({ d, at, text }) => {
        const on = same(value, d) || (!!pair && same(opposite, d));
        const can = ok(d);
        return (
          <Tooltip key={d.join()} title={`${dirLabel(d)}（看不到的那一面）`} mouseEnterDelay={0.3}>
            <g
              role="radio"
              aria-checked={on}
              aria-disabled={!can}
              aria-label={dirLabel(d)}
              tabIndex={can ? 0 : -1}
              className={'fp-hidden' + (on ? ' on' : '') + (can ? '' : ' off')}
              onPointerEnter={() => can && hover(d)}
              onClick={() => can && onChange(d)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && can && (e.preventDefault(), onChange(d))}
            >
              <rect x={at[0] - 9} y={at[1] - 9} width={18} height={18} rx={4} />
              <text x={at[0]} y={at[1] + 4} textAnchor="middle">
                {text}
              </text>
            </g>
          </Tooltip>
        );
      })}
    </svg>
  );
}
