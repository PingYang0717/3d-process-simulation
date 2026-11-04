// 六面小方塊（plan v10 §4.4）：方向不再是抽象下拉。等角小立方體看得到的三面（上、右、前）直接點，
// 看不到的三面（下、左、後）是旁邊的虛線小按鈕。滑過時 3D 的選取外框對應那一面亮橘色＋箭頭（onHover）。
// 命名和 3D 畫面一致（審查問題 3）：預設視角與「正視」的相機都在 +z 看向 −z，所以 +z＝朝向你＝「前」。
import { Tooltip } from 'antd';
import type { Vec3 } from '../../volume/volume';
import { dirLabel, faceName } from './opWords';

const same = (a: Vec3 | null | undefined, b: Vec3) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

const UP: Vec3 = [0, -1, 0];
const DOWN: Vec3 = [0, 1, 0];
const LEFT: Vec3 = [-1, 0, 0];
const RIGHT: Vec3 = [1, 0, 0];
/** 前＝+z（朝向觀者）。 */
const FRONT: Vec3 = [0, 0, 1];
/** 後＝−z（離觀者遠的那一面）。 */
const BACK: Vec3 = [0, 0, -1];
export const SIX: Vec3[] = [UP, DOWN, LEFT, RIGHT, FRONT, BACK];

// 等角投影：中心 (48, 46)，邊長 ~22
const C = { x: 48, y: 46 };
const A = 20;
const pts = (p: [number, number][]) => p.map(([x, y]) => `${x},${y}`).join(' ');
/** 看得到的三面：上（−y）、右（+x）、前（+z，預設視角朝向觀者那一面）。 */
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
    d: FRONT,
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
  { d: BACK, at: [C.x + A + 18, C.y - A + 2], text: '後' },
];
const SHORT: Record<string, string> = { '0,-1,0': '上', '1,0,0': '右', '0,0,1': '前' };

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

// ---- 句子裡的小圖示（審查問題 3：文字說「頂面沿法線往外長」看不出是哪一面、往哪邊） ----

/** 等角投影的三個軸在螢幕上的方向（單位邊長）：+x 往右上、+z（前）往左上、−y（上）往上。 */
const EX = [0.95, -0.5];
const EZ = [-0.95, -0.5];
const EY = [0, 1];
/** 體素方向 → 螢幕向量（含鏡射）。 */
const proj = (d: Vec3, mx: number, my: number): [number, number] => [(d[0] * EX[0] + d[2] * EZ[0]) * mx, (d[0] * EX[1] + d[1] * EY[1] + d[2] * EZ[1]) * my];

/**
 * 小方塊圖示：那一面塗橘＋箭頭（往外長、往內縮、補平）。放在卡片的說明句子前面，和 FacePicker、3D 的亮面同一個顏色。
 * 看不到的三面用鏡射：左＝把右面鏡射到左邊、下＝把頂面鏡射到底下、後＝鏡射後畫成虛線（表示在背面）。
 */
export function FaceGlyph({ dir, kind = 'out', size = 26 }: { dir: Vec3; kind?: 'out' | 'in' | 'flat' | 'none'; size?: number }) {
  const a = dir[0] ? 0 : dir[1] ? 1 : 2;
  const mx = a === 0 && dir[0] < 0 ? -1 : a === 2 && dir[2] < 0 ? -1 : 1;
  const my = a === 1 && dir[1] > 0 ? -1 : 1;
  const hidden = a === 2 && dir[2] < 0;
  // 鏡射後哪一塊多邊形代表這一面：左＝右面的位置、下＝頂面的位置、後＝前面的位置（鏡射後在右邊）
  const key = a === 1 ? '0,-1,0' : a === 0 ? '1,0,0' : '0,0,1';
  const c: [number, number] = [26, 24];
  const S = 11;
  const P = (p: [number, number]): [number, number] => [c[0] + (p[0] - C.x) * (S / A) * mx, c[1] + (p[1] - C.y) * (S / A) * my];
  const n = proj(dir, mx, my);
  const face = FACES.find((f) => f.d.join() === key)!;
  const fc = P(face.arrow);
  const unit = Math.hypot(n[0], n[1]) || 1;
  const nx = n[0] / unit;
  const ny = n[1] / unit;
  const L = 9;
  const tip: [number, number] = kind === 'in' ? [fc[0], fc[1]] : [fc[0] + nx * L, fc[1] + ny * L];
  const tail: [number, number] = kind === 'in' ? [fc[0] + nx * L, fc[1] + ny * L] : [fc[0], fc[1]];
  const dx = tip[0] - tail[0];
  const dy = tip[1] - tail[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const head = `M${tip[0] - ux * 4 - uy * 3},${tip[1] - uy * 4 + ux * 3} L${tip[0]},${tip[1]} L${tip[0] - ux * 4 + uy * 3},${tip[1] - uy * 4 - ux * 3}`;
  // 補平：在那一面外側畫一條平行的粗線
  const px = -ny;
  const py = nx;
  const flat = `M${fc[0] + nx * 5 - px * 7},${fc[1] + ny * 5 - py * 7} L${fc[0] + nx * 5 + px * 7},${fc[1] + ny * 5 + py * 7}`;
  return (
    <svg className="face-glyph" width={size} height={size} viewBox="0 0 52 52" aria-label={faceName(dir)} role="img">
      {FACES.map((f) => (
        <polygon key={f.d.join()} className={f.d.join() === key ? (hidden ? 'hid' : 'on') : ''} points={pts(f.poly.map(P))} />
      ))}
      {kind === 'flat' ? (
        <path d={flat} />
      ) : kind === 'none' ? null : (
        <>
          <line x1={tail[0]} y1={tail[1]} x2={tip[0]} y2={tip[1]} />
          <path d={head} />
        </>
      )}
    </svg>
  );
}
