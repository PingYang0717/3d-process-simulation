// 3D 的箭頭（plan v10 §4.5、v17 §5.2）：純函式，不碰 three.js／DOM，可單獨測試。
// 面把手 ×6：貼在最後選的結構每一面實際的表面上、離十字最近的那一格（plan v19 §3.2；以前是外框每一面中央），
// 沿法線拖 n 格 → 推拉那一面（或往那邊平移）。
import type { BBox, Vec3 } from '../../volume/volume';

/** 把手在螢幕上的大小（像素，不隨縮放變）與點得到的半徑。 */
export const HANDLE_PX = 18;
export const HANDLE_HIT_PX = 14;
/**
 * 正對著看：法線 1 格投影到螢幕的長度 < 面內 1 格長度 × 這個比例（約偏離視線 15° 以內），改用垂直位移估算。
 * 以前是固定 4 px：縮到整個模型都看得到時 1 格本來就不到 4 px，幾乎每一面都被當成正對著看，
 * 沿箭頭往左拖反而不動、要上下拖——和箭頭對不上。
 */
export const HEAD_ON_RATIO = 0.25;
/** (vx, vy)＝法線 1 格投影，pxPerVoxel＝面內 1 格投影。 */
export const isHeadOn = (vx: number, vy: number, pxPerVoxel: number) => Math.hypot(vx, vy) < Math.max(0.05, HEAD_ON_RATIO * pxPerVoxel);
/** 1 格在螢幕上至少算這麼多像素，縮得很小時不會一抖就好幾格。 */
export const MIN_PX = 2.5;

export interface FaceHandle {
  kind: 'face';
  dir: Vec3;
  /** 面中央（體素座標，格子角＝整數）。 */
  pos: Vec3;
}
export type Handle3D = FaceHandle;

const SIX: Vec3[] = [
  [0, -1, 0],
  [0, 1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
];
const lo = (b: BBox): Vec3 => [b.x0, b.y0, b.z0];
const hi = (b: BBox): Vec3 => [b.x1 + 1, b.y1 + 1, b.z1 + 1];

/** 六個面把手：外框每一面中央。 */
export function faceHandles(b: BBox): FaceHandle[] {
  const l = lo(b);
  const h = hi(b);
  return SIX.map((dir) => {
    const pos: Vec3 = [(l[0] + h[0]) / 2, (l[1] + h[1]) / 2, (l[2] + h[2]) / 2];
    const a = dir[0] ? 0 : dir[1] ? 1 : 2;
    pos[a] = dir[a] > 0 ? h[a] : l[a];
    return { kind: 'face', dir, pos };
  });
}

/**
 * 六個面把手貼在結構實際的表面上（plan v19 §3.2）：每一面挑「那個方向最外側的格子」裡，面內離 anchor 最近的那一格，
 * 箭頭放在那一格朝外的面中央。anchor＝十字（點 3D／切面時是點到的那一格，從清單選是結構中央），
 * 所以箭頭會出現在剛剛點的地方附近，不會跑到很長的結構另一頭、或懸在外框中央的空氣裡。
 * labels[i] === ci 的格子屬於這個結構；b＝它的外框。由 anchor 往外一圈一圈找，找到後再看到不可能更近為止。
 */
export function surfaceHandles(labels: ArrayLike<number>, X: number, Y: number, ci: number, b: BBox, anchor: Vec3): FaceHandle[] {
  const l = [b.x0, b.y0, b.z0];
  const h = [b.x1, b.y1, b.z1];
  const st = [1, X, X * Y];
  const boxed = faceHandles(b);
  return SIX.map((dir, k) => {
    const a = dir[0] ? 0 : dir[1] ? 1 : 2;
    const sg = dir[a];
    const u = a === 0 ? 1 : 0;
    const w = a === 2 ? 1 : 2;
    const outer = (pu: number, pw: number) => {
      const base = pu * st[u] + pw * st[w];
      for (let t = sg > 0 ? h[a] : l[a]; sg > 0 ? t >= l[a] : t <= h[a]; t -= sg) if (labels[base + t * st[a]] === ci) return t;
      return -1;
    };
    const cu = Math.max(l[u], Math.min(h[u], Math.floor(anchor[u])));
    const cw = Math.max(l[w], Math.min(h[w], Math.floor(anchor[w])));
    const R = Math.max(cu - l[u], h[u] - cu, cw - l[w], h[w] - cw);
    let bd = Infinity;
    let best: Vec3 | null = null;
    const tryRow = (pu: number, pw: number) => {
      if (pu < l[u] || pu > h[u] || pw < l[w] || pw > h[w]) return;
      const d = (pu - cu) ** 2 + (pw - cw) ** 2;
      if (d >= bd) return;
      const t = outer(pu, pw);
      if (t < 0) return;
      bd = d;
      const pos: Vec3 = [0, 0, 0];
      pos[u] = pu + 0.5;
      pos[w] = pw + 0.5;
      pos[a] = sg > 0 ? t + 1 : t;
      best = pos;
    };
    for (let r = 0; r <= R && r * r < bd; r++) {
      if (r === 0) {
        tryRow(cu, cw);
        continue;
      }
      for (let d = -r; d <= r; d++) {
        tryRow(cu + d, cw - r);
        tryRow(cu + d, cw + r);
        if (d > -r && d < r) {
          tryRow(cu - r, cw + d);
          tryRow(cu + r, cw + d);
        }
      }
    }
    return best ? { kind: 'face' as const, dir, pos: best } : boxed[k];
  });
}

/** 面朝不朝相機：toEye＝從面中央指向相機（體素座標）。背對相機的面把手不畫、點不到。 */
export const facesCamera = (dir: Vec3, toEye: Vec3) => dir[0] * toEye[0] + dir[1] * toEye[1] + dir[2] * toEye[2] > 1e-6;

/**
 * 拖面把手：螢幕位移 (dx, dy) → 格數。(vx, vy)＝法線 1 格投影到螢幕的位移；正對著看（isHeadOn）時
 * 改用垂直位移 ÷ 每格像素（往上拖＝長）。夾在 ±max。
 */
export function faceSteps(dx: number, dy: number, vx: number, vy: number, pxPerVoxel: number, max: number) {
  const len = Math.hypot(vx, vy);
  const n = isHeadOn(vx, vy, pxPerVoxel) ? Math.round(-dy / Math.max(MIN_PX, pxPerVoxel)) : Math.round((dx * vx + dy * vy) / len / Math.max(MIN_PX, len));
  return Math.max(-max, Math.min(max, n));
}

/** 螢幕上最近的把手（距離 ≤ HANDLE_HIT_PX）；screen＝每個把手投影到螢幕的位置（null＝不畫）。 */
export function pickHandle<T>(items: { h: T; screen: [number, number] | null }[], x: number, y: number): T | null {
  let best: T | null = null;
  let bd = HANDLE_HIT_PX;
  for (const { h, screen } of items) {
    if (!screen) continue;
    const d = Math.hypot(screen[0] - x, screen[1] - y);
    if (d <= bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

const SCREEN_WORDS = ['往右', '往右下', '往下', '往左下', '往左', '往左上', '往上', '往右上'];
/** 螢幕上的方向（y 往下為正）→ 八方位的白話。 */
export const screenWord = (x: number, y: number) => SCREEN_WORDS[((Math.round(Math.atan2(y, x) / (Math.PI / 4)) % 8) + 8) % 8];

/**
 * 面把手的拖法用螢幕上的方向說（不用體素軸的「往前／往後」，那和視角無關、對不上畫面）：
 * (vx, vy)＝法線 1 格投影到螢幕；順著箭頭＝長、反方向＝縮。正對著看時和 faceSteps 一樣改用上下。
 */
export function faceDragWords(vx: number, vy: number, pxPerVoxel: number): { grow: string; shrink: string } {
  if (isHeadOn(vx, vy, pxPerVoxel)) return { grow: '往上', shrink: '往下' };
  return { grow: screenWord(vx, vy), shrink: screenWord(-vx, -vy) };
}

/** 面的名字（軸＋正負，例如「z− 面」）：和畫面視角無關的唯一稱呼。 */
export const faceAxisName = (d: Vec3) => {
  const a = d[0] ? 0 : d[1] ? 1 : 2;
  return `${'xyz'[a]}${d[a] > 0 ? '+' : '−'} 面`;
};
