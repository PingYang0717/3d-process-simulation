import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ColorManagement,
  DirectionalLight,
  HemisphereLight,
  LinearSRGBColorSpace,
  DoubleSide,
  FrontSide,
  EdgesGeometry,
  LineBasicMaterial,
  LineDashedMaterial,
  LineLoop,
  LineSegments,
  MOUSE,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { acceleratedRaycast } from 'three-mesh-bvh';
import { Group, type Intersection, type Material as ThreeMaterial } from 'three';
import { beginPickEvent, bvhStats, lazyRaycast, pickAlong, pickOrdered, scheduleIdleBVH } from './pick';
import type { ChunkItem } from '../../volume/worker';
import {
  type Axis,
  type BBox,
  type Material,
  type MeshData,
  type Vec3,
  type Volume,
  DIFF_BIT,
  VOID,
  directionName,
  hexToRgb,
  idx,
  voxelFromHit,
} from '../../volume/volume';
import { call, sidOf } from '../../volume/client';
import type { EditState, Local, Op } from '../../volume/ops';
import type { Preview } from '../../volume/preview';
import { HOLE_EPS, previewMesh } from '../../volume/previewMesh';
import { hiddenTable, palette } from './tables';
import { DIFF_EDGE_HEX, SEL_RGB, drawSlice } from './drawSlice';
import { SlicePreviewLayer } from './SlicePreviewLayer';
import { type Brush, type Sculpt, type SelectMode, selectModeOf } from './editor';
import { type Handle3D, HANDLE_PX, cornerHandles, cornerRadius, faceHandles, faceSteps, facesCamera, pickHandle } from './handles3d';
import type { CornerId } from '../../slice/round';
import { ArrowHelper, OctahedronGeometry } from 'three';

export type { Sculpt } from './editor';
import { type Scope, axisIndex, axisLen } from '../../volume/scope';

/** 選取層沿法線外推的量：固定值，相機再遠也不會和主網格共面閃爍。 */
const INFLATE = 0.03;
/** 筆刷圈、法線箭頭、拖拉預覽共用的顏色（和十字的淡橘區分）。 */
const BRUSH_COLOR = 0xfa541c;
/** 把手：面把手橘、角把手紫，滑過／拖拉中亮黃。 */
const HANDLE_COLOR = 0xfa541c;
const CORNER_COLOR = 0x722ed1;
const HANDLE_HOT = 0xfaad14;
/** 按下後要先拖過這麼多像素才算拖拉，否則一律當點選（避免手抖就改到體素）。 */
const DRAG_DEAD_ZONE = 8;
/** 法線在螢幕上短於這麼多像素＝正對著面看，改用垂直位移估算格數。 */
const HEAD_ON_PX = 4;
/** 同一個位置再點一次（時間、距離內）＝沿射線選下一個結構。 */
const RECLICK_MS = 1500;
const RECLICK_PX = 6;
/**
 * 光照（plan v12 §5.1）：改後＝材質原色。頂點色是調色盤的 sRGB 值，直接輸出（不做色彩管理、不做 sRGB 編碼），
 * 所以畫面上的顏色＝調色盤 × 光照係數 k；k 最高 0.62＋0.30 ≤ 1.0（最亮的面也不超過調色盤色、不飽和），
 * 均勻縮放不改色相與飽和度。three 的 Lambert BRDF 除以 π，所以強度乘 π。
 */
ColorManagement.enabled = false;
export const LIGHT = { sky: 0.62, ground: 0.5, key: 0.3 } as const;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export type ViewPreset = 'front' | 'top' | 'side' | 'iso' | 'home' | 'fit';
/** 剖面：沿 axis 在 at 剖開；side = 1 留座標 ≤ at 的那一半，-1 留 ≥ at。 */
export interface Clip {
  axis: Axis;
  at: number;
  side: 1 | -1;
}
export type ViewMode = 'now' | 'orig' | 'diff';

export interface View3DHandle {
  setView: (preset: ViewPreset) => void;
  /** 立刻把 mask 裡體素的面改成這個顏色（換材質的即時預覽；正式網格之後覆蓋）。 */
  recolor: (mask: Uint8Array, rgb: Vec3) => void;
  /** 選取框閃兩下：剛套用了一步。 */
  flash: () => void;
  /** 卡片的六面小方塊滑過時：選取外框的那一面亮橘色＋往外的箭頭（plan v10 §4.4）；null＝收掉。 */
  highlightFace: (dir: Vec3 | null) => void;
  /** 對準這個體素（有動畫，距離不變）。 */
  lookAt: (p: Vec3) => void;
  /** 對準一個外框（「對準差異」：split 的 diff 外框，plan v12 §5.4）。 */
  focusBox: (b: BBox) => void;
  /** 改後模式套用一步：在改到的外框畫橘色虛線，1.5 秒淡出（plan v12 §5.1 D1；不碰網格）。 */
  stepBox: (b: BBox) => void;
}

/** 右鍵選單用：點到的體素，以及沿射線往裡面還有哪些結構（key）。 */
export interface MenuHit {
  voxel: number | null;
  along: string[];
  /** 點到的面的外法線（剖面貼圖上是 null）。 */
  n: Vec3 | null;
}

interface Ctx {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  /** 主網格的材質與座標轉換（幾何是空的）；真正畫的是 parts（每個 chunk 一個 Mesh，§8.4）。 */
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  parts: Map<number, Mesh<BufferGeometry, MeshLambertMaterial>>;
  partGroup: Group;
  /** 目前畫的是哪個版本、哪種畫法（下一次只要改到的 chunk）。 */
  shown: { sid: number; key: string } | null;
  /**
   * 主網格的 chunk 快取（plan v9 §4.6）：`${sid}|${畫法}` → chunk 網格，最近用的 PARTS_CACHE 組。
   * 增量更新時沒動到的 chunk 的 Mesh 在多組之間共用；釋放前確認沒有任何一組或目前畫的還在用（disposeOrphans）。
   */
  partsCache: Map<string, Map<number, Mesh<BufferGeometry, MeshLambertMaterial>>>;
  /** 釘住不擠出的那一組（原始的網格）。 */
  pinned?: string;
  /** 差異模式（plan v12 §5.2）：改到的實色層與深藍邊，只有 diff 外框碰到的 chunk。「沒改」＝主網格換半透明灰材質。 */
  diffFill: Layer<Mesh>;
  diffEdges: Layer<LineSegments>;
  /** 選取層、空洞層、空洞的紅邊：和主網格同一套 chunk（§4.6）。 */
  selFill: Layer<Mesh>;
  voidMesh: Layer<Mesh>;
  voidEdges: Layer<LineSegments>;
  selBox: LineSegments<BufferGeometry, LineBasicMaterial>;
  hoverBox: LineSegments<BufferGeometry, LineBasicMaterial>;
  /** 即時預覽：裁切範圍重算的網格；主網格在同一個範圍裡的片段由 shader 挖掉（hole）。 */
  previewMesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  hole: { min: { value: Vector3 }; max: { value: Vector3 } };
  ghost: LineSegments<BufferGeometry, LineDashedMaterial>;
  ghostFill: Mesh<BoxGeometry, MeshBasicMaterial>;
  ring: LineLoop<BufferGeometry, LineBasicMaterial>;
  arrow: LineSegments<BufferGeometry, LineBasicMaterial>;
  cross: LineSegments;
  cap: Mesh<PlaneGeometry, MeshBasicMaterial>;
  capEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
}

/**
 * 拖拉中的面：p = 按下的體素、dir = 面的外法線（體素座標）、(vx, vy) = 法線 1 格投影到螢幕的位移。
 * armed = 已經拖過死區；headOn = 正對著面看（法線投影太短），改用垂直位移 ÷ pxPerVoxel。
 */
interface Drag {
  p: number;
  dir: Vec3;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  n: number;
  maxN: number;
  armed: boolean;
  headOn: boolean;
  pxPerVoxel: number;
  hitVoxel: Vec3;
  mode: Brush['mode'];
}

/** 鏡頭移動：300ms 緩動到目標位置（減少動態偏好時直接跳）。 */
interface CamAnim {
  p0: Vector3;
  p1: Vector3;
  t0: Vector3;
  t1: Vector3;
  start: number;
  ms: number;
}

const toGeometry = (m: MeshData) => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('color', new BufferAttribute(m.colors, 3));
  g.computeBoundingSphere();
  return g;
};
const boxEdges = (b: BBox) => new EdgesGeometry(new BoxGeometry(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1));
const axisOf = (d: Vec3) => (d[0] ? 0 : d[1] ? 1 : 2);
const AXIS_RGB: Record<Axis, string> = { x: '#e5484d', y: '#30a46c', z: '#3e63dd' };
/** 挖洞的邊界多留一點點，剛好落在範圍邊界平面上的面也挖掉（預覽網格會重畫它們）。 */

/**
 * 主網格與選取層的材質：加一個 uniform 盒子，落在盒子裡的片段 discard。
 * 即時預覽把裁切範圍挖空、再疊上重算的小網格，不必等 Worker 重算整個網格。
 */
const withHole = <M extends MeshLambertMaterial>(m: M, hole: Ctx['hole']) => {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.holeMin = hole.min;
    shader.uniforms.holeMax = hole.max;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHolePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHolePos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHolePos;\nuniform vec3 holeMin;\nuniform vec3 holeMax;')
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\nif (all(greaterThan(vHolePos, holeMin)) && all(lessThan(vHolePos, holeMax))) discard;',
      );
  };
  m.customProgramCacheKey = () => 'hole';
  return m;
};

/** 一層 chunk 網格（選取層、空洞層、紅邊）：group 在體素座標裡，parts 是 chunk 編號 → 物件。 */
interface Layer<T extends Mesh | LineSegments> {
  group: Group;
  parts: Map<number, T>;
  shown: { sid: number; key: string } | null;
  material: ThreeMaterial;
  order: number;
}
/** 差異模式「沒改」的半透明灰（主網格原地換材質，plan v12 §5.2）。 */
const GHOST_HEX = 0xb8bcc7;
const GHOST_OPACITY = 0.38;
/** 描邊（EdgesGeometry，O(n log n)）的 quad 數上限：超過就不描（差異模式紅邊、空洞紅邊）。 */
const EDGE_QUADS_MAX = 60000;
/** 主網格快取幾組（切 B、切 split、復原時不必再跟 Worker 要）。 */
const PARTS_CACHE = 3;

/**
 * 畫質（plan v15 B6）：antialias 開著（MSAA 4）時每 CSS px 的 sample 數 = pixelRatio² × 4，dpr 2 就是 16。
 * 靜止時 1.5（9 sample，和 2 的差異肉眼難辨）、互動中（轉視角、拖把手、拖筆刷）1.0（4 sample）；「高」＝2。
 * 設定抽屜之後接 localStorage `se3d.v1.quality`（JSON 字串 "high"｜"standard"），這裡先只讀。
 */
export const PIXEL_RATIO = { standard: 1.5, high: 2, interact: 1 } as const;
export const QUALITY_KEY = 'se3d.v1.quality';
/** 靜止時的 pixelRatio：設定的上限和裝置 dpr 取小。 */
export const idlePixelRatio = (dpr = window.devicePixelRatio || 1) => {
  let q: unknown = null;
  try {
    q = JSON.parse(localStorage.getItem(QUALITY_KEY) ?? 'null');
  } catch {
    /* 沒存過或格式不對：標準 */
  }
  return Math.min(q === 'high' ? PIXEL_RATIO.high : PIXEL_RATIO.standard, dpr);
};

const newPart = (c: Ctx, m: MeshData) => {
  const part = new Mesh(toGeometry(m), c.mesh.material);
  part.raycast = lazyRaycast;
  return part;
};
/** 從 base（增量）或空的（全量）做出新的一組 chunk：quads = 0 的拿掉。不釋放任何東西（base 可能還在快取裡）。 */
const nextParts = (c: Ctx, base: Map<number, Mesh<BufferGeometry, MeshLambertMaterial>> | null, items: ChunkItem[]) => {
  const map = new Map(base ?? []);
  for (const { k, m } of items) {
    if (m.quads) map.set(k, newPart(c, m));
    else map.delete(k);
  }
  return map;
};
/** 釋放這些組裡沒有任何快取或目前畫的還在用的 geometry。 */
const disposeOrphans = (c: Ctx, maps: Map<number, Mesh>[]) => {
  const alive = new Set<Mesh>(c.parts.values());
  for (const m of c.partsCache.values()) for (const p of m.values()) alive.add(p);
  for (const m of maps) for (const p of m.values()) if (!alive.has(p)) p.geometry.dispose();
};
/**
 * 換上一組主網格 chunk；cache＝存進快取（差異模式那一組不存）。
 * changed＝這一步換掉的 chunk 編號（增量更新時）：閒置補建 BVH 先建它們（下一次滑過最可能碰到的就是這些，plan v15 B4）。
 */
const showParts = (c: Ctx, map: Map<number, Mesh<BufferGeometry, MeshLambertMaterial>>, shown: { sid: number; key: string } | null, cache: boolean, pin = false, changed: Set<number> | null = null) => {
  const prev = c.parts;
  c.partGroup.clear();
  for (const p of map.values()) c.partGroup.add(p);
  c.parts = map;
  c.shown = shown;
  const evicted: Map<number, Mesh>[] = [prev];
  if (cache && shown) {
    const ck = `${shown.sid}|${shown.key}`;
    c.partsCache.delete(ck);
    c.partsCache.set(ck, map);
    // 原始那一組釘住（plan v12 §5.3：restore 回來的 split 都從原始增量）
    if (pin) c.pinned = ck;
    while (c.partsCache.size > PARTS_CACHE + (c.pinned && c.partsCache.has(c.pinned) ? 1 : 0)) {
      const k = [...c.partsCache.keys()].find((x) => x !== c.pinned)!;
      evicted.push(c.partsCache.get(k)!);
      c.partsCache.delete(k);
    }
  }
  disposeOrphans(c, evicted);
  // 單一 idle 排程：新的一組來了只換待建清單；這一步改到的 chunk 排前面
  const first = changed ? new Set([...changed].map((k) => map.get(k)).filter((m): m is Mesh<BufferGeometry, MeshLambertMaterial> => !!m)) : null;
  scheduleIdleBVH(map.values(), first?.size ? (m) => first.has(m as Mesh<BufferGeometry, MeshLambertMaterial>) : null);
};

/** 圖層換 chunk：full = 全部換掉；否則只換 items 裡的（quads = 0 的拿掉）。換掉的立刻釋放（圖層不快取）。 */
const setLayer = <T extends Mesh | LineSegments>(layer: Layer<T>, items: { k: number; geometry: BufferGeometry | null }[], full: boolean, make: (g: BufferGeometry) => T) => {
  const drop = (k: number) => {
    const p = layer.parts.get(k);
    if (!p) return;
    layer.group.remove(p);
    p.geometry.dispose();
    layer.parts.delete(k);
  };
  if (full) for (const k of [...layer.parts.keys()]) drop(k);
  for (const { k, geometry } of items) {
    drop(k);
    if (!geometry) continue;
    const o = make(geometry);
    o.renderOrder = layer.order;
    o.frustumCulled = false;
    layer.group.add(o);
    layer.parts.set(k, o);
  }
};
const clearLayer = (layer: Layer<Mesh | LineSegments>) => {
  setLayer(layer, [], true, () => null as never);
  layer.shown = null;
};

/** 收掉即時預覽：預覽網格藏起來、主網格不再挖洞。 */
const hidePreview = (c: Ctx) => {
  c.previewMesh.visible = false;
  c.hole.min.value.set(1, 1, 1);
  c.hole.max.value.set(0, 0, 0);
};

export { drawSlice } from './drawSlice';

/**
 * 3D：Worker 做 greedy mesh（同材質同朝向的面合併成大矩形），改後模式不染色（plan v10 §4.3）；
 * 選取半透明網格（沿法線外推 0.03 避免共面）＋bbox 線框、橘色十字、剖面（三軸、剖口貼真正的切面圖）。
 * 聚焦編輯（plan v10 §4.5）：拖把手＝整面長縮或圓角；筆刷工具＝局部長／縮、局部方頭（點一下＝補到那一面）。瀏覽時拖拉只轉視角。
 * 整面長縮、整塊移動都在右欄輸入。差異模式：沒改的半透明灰、改過的實色＋深藍邊、拿掉的紅。
 * 體素 y 向下，所以網格 scale y = −1 再平移，讓畫面上方 = y 索引小。
 */
export function View3D({
  state,
  materials,
  hidden,
  selMask,
  selComps,
  scope,
  selBBox,
  cursor,
  clip,
  diffMask,
  mode,
  brush,
  tool = null,
  dimOthers = false,
  cornerAxis,
  faceOp,
  roundOp,
  onCommit,
  onCornerClick,
  onFocusSel,
  nmPerVoxel,
  orig,
  preview,
  onPreview,
  toOp,
  onPick,
  onMenu,
  onSculpt,
  onHover,
  floatRef,
  handle,
  xray = false,
  translucent = false,
  busy,
}: {
  /** 要畫的狀態；網格在 Worker 裡用它常駐的那一份算，不必把陣列送過去。 */
  state: EditState;
  materials: Material[];
  hidden: Set<number>;
  /** 選取 ∩ z 範圍（主執行緒的那份，判斷滑鼠是不是在已選結構上）。 */
  selMask: Uint8Array | null;
  /** 選取結構的編號（L.comps 的 index），Worker 依它畫選取層。 */
  selComps: number[] | null;
  /** 範圍：選取層只畫 scope 裡的部分。 */
  scope: Scope;
  selBBox: BBox | null;
  cursor: Vec3;
  clip: Clip | null;
  /** 差異 mask（只有差異模式傳；剖面貼圖描邊用）。改後模式不標任何顏色（plan v10 §4.3）。 */
  diffMask: Uint8Array | null;
  mode: ViewMode;
  brush: Brush;
  /**
   * 聚焦編輯的工具（plan v10 §4.5）：null＝瀏覽，3D 上怎麼拖都只轉視角；handles＝面把手與角把手；brush＝筆刷。
   * 只有按在把手上（或筆刷模式按在已選結構上）才是編輯，其他地方一律轉視角。
   */
  tool?: 'handles' | 'brush' | null;
  /** 聚焦：其他結構半透明、選取實色。 */
  dimOthers?: boolean;
  /** 角把手所在剖面的法線軸（結構最長軸的法線）。 */
  cornerAxis?: Axis;
  /** 面把手拖 n 格 → Op（和卡片同一個產生函式）。 */
  faceOp?: (dir: Vec3, n: number) => Op | null;
  /** 角把手拖到半徑 r → 圓頭 Op。 */
  roundOp?: (id: CornerId, r: number) => Op | null;
  onCommit?: (op: Op) => void;
  /** 角把手點一下：開圓頭卡片（x, y＝畫布座標）。 */
  onCornerClick?: (id: CornerId, x: number, y: number) => void;
  /** 雙擊已選的結構：進入聚焦編輯。 */
  onFocusSel?: () => void;
  nmPerVoxel: number;
  /** 原始陣列（預覽裡改過的體素混紅用）。 */
  orig: Volume | null;
  /** 即時預覽（主執行緒裁切重算的結果，base = 它根據的陣列）；null = 沒有。網格在這裡畫，正式網格到了就收掉。 */
  /** base = 預覽根據的狀態版本號（sidOf）。 */
  preview: (Preview & { base: number; mesh?: MeshData }) | null;
  /** 拖拉中每改一格就要一次預覽；null = 收掉。回傳 false 表示範圍太大沒算（改畫橘色塊）。 */
  onPreview: (op: Op | null) => boolean;
  /** 筆刷的一筆 → 完整 Op（補上選取、z 範圍、襯層設定）。 */
  toOp: (s: Sculpt) => Op | null;
  onPick: (voxel: number | null, mode: SelectMode) => void;
  onMenu: (hit: MenuHit, x: number, y: number) => void;
  onSculpt: (s: Sculpt) => void;
  onHover: (text: string | null) => void;
  floatRef: RefObject<HTMLDivElement>;
  handle: MutableRefObject<View3DHandle | null>;
  xray?: boolean;
  translucent?: boolean;
  busy: boolean;
}) {
  const vol = state.vol;
  const hostRef = useRef<HTMLDivElement>(null);
  const gizmoRef = useRef<SVGSVGElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  /** 按下的處理（capture 階段的原生事件呼叫；每次 render 換成最新的閉包）。 */
  const downHandler = useRef<((e: PointerEvent) => void) | null>(null);
  const origRef = useRef(orig);
  origRef.current = orig;
  const bboxRef = useRef(selBBox);
  bboxRef.current = selBBox;
  const selRef = useRef(selMask);
  selRef.current = selMask;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const dragRef = useRef<Drag | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  /** 畫面上的把手（plan v10 §4.5）：每個把手一個物件，每一幀依相機距離縮放成固定螢幕大小。 */
  const handlesRef = useRef<{ h: Handle3D; obj: ArrowHelper | Mesh }[]>([]);
  const handleGroupRef = useRef<Group | null>(null);
  const hoverHandle = useRef<Handle3D | null>(null);
  /** 拖把手中：按下的位置、法線（或角平分線）1 格投影到螢幕、目前的格數／半徑。 */
  const hdRef = useRef<{ h: Handle3D; sx: number; sy: number; vx: number; vy: number; ppv: number; max: number; v: number; armed: boolean } | null>(null);
  /** 把手拖拉：pointermove 只記 v，requestAnimationFrame 每幀最多算一次 Op 與預覽（plan v14 P1，和 2D 的 SliceEditor 一樣）。 */
  const hdRaf = useRef(0);
  const hdSent = useRef<number | null>(null);
  /** 互動中降 pixelRatio（plan v15 B6；掛載時建立）：拖把手、拖筆刷過了死區就 true，放開／Esc false。 */
  const lowResRef = useRef<(on: boolean) => void>(() => {});
  const cancelHdRaf = () => {
    if (hdRaf.current) cancelAnimationFrame(hdRaf.current);
    hdRaf.current = 0;
  };
  useEffect(() => () => cancelAnimationFrame(hdRaf.current), []);
  /** 每一幀更新把手大小與可見（掛載時的 tick 呼叫）。 */
  const handleTick = useRef<() => void>(() => {});
  /** 射線命中（掛載時的滾輪、旋轉中心用最新一次 render 的 hit）。 */
  const hitRef = useRef<(x: number, y: number) => { world: Vector3 } | null>(() => null);
  /** 鏡頭操作（掛載時建立）：旋轉前定中心、雙擊對準。 */
  const camRef = useRef<{ pivotAt: (x: number, y: number) => void; lookAtPoint: (p: Vector3) => void } | null>(null);
  /** 左鍵或右鍵按下的位置（判斷是點還是拖）。 */
  const downRef = useRef<{ x: number; y: number; button: number } | null>(null);
  /** 背景點一下要延後清選取：雙擊背景（回全貌）不該順便清掉。 */
  const bgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 上一次點選：同一個位置再點＝沿射線選下一個。 */
  const lastClick = useRef<{ x: number; y: number; at: number; along: string[]; i: number } | null>(null);
  const [dragTip, setDragTip] = useState<{ text: string; x: number; y: number } | null>(null);
  /** hover 到的結構名稱，貼在游標旁。 */
  const [hoverTag, setHoverTag] = useState<{ text: string; x: number; y: number } | null>(null);
  const [meshing, setMeshing] = useState(false);
  /** 還要畫幾格（0 = 靜止不畫）；kick() 之後至少再畫兩格。 */
  const dirty = useRef(3);
  const kick = () => {
    dirty.current = Math.max(dirty.current, 2);
  };
  // 會改場景的 props 變了才多畫兩格（plan v9 P7：滑鼠在別處移動、父元件重 render 不必重畫 3D）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(kick, [state, materials, hidden, selMask, selComps, scope, selBBox, cursor, clip, diffMask, mode, brush, preview, xray, translucent, busy, meshing]);
  const meshingRef = useRef(false);
  meshingRef.current = meshing;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 開發模式：e2e（scripts/e2e/perf.cjs）讀 renderer.info（geometry 數、draw call）
    if (import.meta.env.DEV) {
      (window as unknown as { __renderer?: WebGLRenderer }).__renderer = renderer;
      // e2e（perf.cjs）：事件裡同步建了幾棵 BVH（plan v15 B4：每事件有 8 ms 預算，其餘 idle 補）
      Object.defineProperty(window, '__bvhBuilds', { get: () => bvhStats.sync, configurable: true });
      Object.defineProperty(window, '__bvhStats', { get: () => ({ ...bvhStats }), configurable: true });
    }
    // 畫質（plan v15 B6）：靜止 ≤ 1.5（設定「高」＝2）、互動中 1.0；setPixelRatio 內部會 setSize，不必再叫
    const prIdle = idlePixelRatio();
    renderer.setPixelRatio(prIdle);
    const lowRes = (on: boolean) => {
      const pr = on ? Math.min(PIXEL_RATIO.interact, prIdle) : prIdle;
      if (renderer.getPixelRatio() === pr) return;
      renderer.setPixelRatio(pr);
      kick();
    };
    lowResRef.current = lowRes;
    renderer.localClippingEnabled = true;
    renderer.outputColorSpace = LinearSRGBColorSpace;
    host.appendChild(renderer.domElement);
    const scene = new Scene();
    scene.background = new Color('#f5f6f8');
    const size = Math.max(vol.X, vol.Y, vol.Z);
    const camera = new PerspectiveCamera(40, 1, Math.max(0.5, size * 0.002), size * 40);
    camera.up.set(0, 1, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    // 中鍵也能轉視角（把手模式裡左鍵按在把手上是編輯，其他地方一律轉視角）
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN };
    // 滾輪自己接（plan v10 §4.1）：OrbitControls 的 zoomToCursor＋screenSpacePanning 每滾一下都把 target
    // 重設到「相機正前方、距離＝新半徑」的點，滾幾下旋轉中心就飄到模型外，之後怎麼拖都拉不回來
    controls.enableZoom = false;
    controls.minDistance = size * 0.08;
    controls.maxDistance = size * 8;
    // 極點留一點：正上方也能繼續拖
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    // 開發模式：e2e（scripts/e2e/m10.cjs）讀旋轉中心
    if (import.meta.env.DEV) (window as unknown as { __controls?: OrbitControls }).__controls = controls;
    const center = new Vector3(vol.X / 2, vol.Y / 2, vol.Z / 2);
    const ISO = new Vector3(0.55, 0.38, 0.74).normalize();
    let anim: CamAnim | null = null;
    /** 看向 target、沿 dir 退到剛好看得到半徑 radius 的距離；回傳相機位置。 */
    const placeFor = (dir: Vector3, target: Vector3, radius: number) => {
      const vf = (camera.fov * Math.PI) / 180;
      const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
      const d = (radius / Math.sin(Math.min(vf, hf) / 2)) * 1.08;
      return target.clone().addScaledVector(dir, d);
    };
    const moveTo = (pos: Vector3, target: Vector3, instant = false) => {
      if (instant || reducedMotion()) {
        anim = null;
        camera.position.copy(pos);
        controls.target.copy(target);
        controls.update();
        return;
      }
      anim = { p0: camera.position.clone(), p1: pos, t0: controls.target.clone(), t1: target, start: performance.now(), ms: 300 };
    };
    const fullRadius = () => 0.5 * Math.hypot(vol.X, vol.Y, vol.Z);
    const probe = new Raycaster();
    /** 從 pos 看 target 會不會先被別的面擋住（對準選取用）。 */
    const occluded = (pos: Vector3, target: Vector3, radius: number) => {
      const ps = ctxRef.current?.parts;
      if (!ps?.size) return false;
      const dir = target.clone().sub(pos);
      const dist = dir.length();
      probe.set(pos, dir.normalize());
      beginPickEvent();
      const h = pickOrdered(probe, ps.values(), true)[0];
      return !!h && h.distance < dist - radius;
    };
    const setView = (preset: ViewPreset, box?: BBox) => {
      const b = box ?? bboxRef.current;
      const target = center.clone();
      let radius = fullRadius();
      if (preset === 'fit' && b) {
        target.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
        radius = Math.max(4, 0.5 * Math.hypot(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1));
      }
      const cur = camera.position.clone().sub(controls.target).normalize();
      let dir =
        preset === 'front'
          ? new Vector3(0, 0, 1)
          : preset === 'top'
            ? new Vector3(0, 1, 0.035).normalize()
            : preset === 'side'
              ? new Vector3(-1, 0, 0)
              : preset === 'fit'
                ? cur
                : ISO;
      let pos = placeFor(dir, target, radius);
      // 對準選取時沿目前方向看會被擋住，就換成等角方向
      if (preset === 'fit' && occluded(pos, target, radius)) {
        dir = ISO;
        pos = placeFor(dir, target, radius);
      }
      moveTo(pos, target, preset === 'home' && !ctxRef.current);
    };
    setView('home');
    /** 視線方向上、和 h 同深度的點（旋轉中心放這裡：視線方向不變，畫面不跳）。 */
    const depthPoint = (pos: Vector3, h: Vector3) => {
      const v = camera.getWorldDirection(new Vector3());
      return pos.clone().addScaledVector(v, Math.max(1e-3, h.clone().sub(pos).dot(v)));
    };
    /** 距離下限：有選取時跟著選取的大小（可以貼近小結構），沒有時整個模型的 8%。 */
    const minDist = () => {
      const b = bboxRef.current;
      return b ? Math.max(1, 0.3 * Math.hypot(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1)) : size * 0.08;
    };
    /** 滾輪：朝游標下的實際表面縮放，旋轉中心落在那個面上；沒打到東西就朝現在的中心縮放、中心不動。 */
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      anim = null;
      const s = Math.exp(-e.deltaY * 0.0015);
      const pos = camera.position;
      const maxD = controls.maxDistance;
      const minD = Math.min(minDist(), maxD);
      const h = hitRef.current(e.clientX, e.clientY);
      if (h) {
        const H = h.world.clone();
        const v = camera.getWorldDirection(new Vector3());
        const d0 = H.clone().sub(pos).dot(v);
        if (d0 > 1e-3) {
          let f = 1 - 1 / s;
          // 深度 d0·(1−f) 夾在 [minD, maxD]
          f = Math.min(f, 1 - minD / d0);
          f = Math.max(f, 1 - maxD / d0);
          if (f > 0 || s < 1) {
            pos.addScaledVector(H.clone().sub(pos), f);
            controls.target.copy(depthPoint(pos, H));
          }
          controls.update();
          scheduleRecenter();
          return;
        }
      }
      const off = pos.clone().sub(controls.target);
      const d = Math.max(minD, Math.min(maxD, off.length() / s));
      pos.copy(controls.target).addScaledVector(off.normalize(), d);
      controls.update();
      scheduleRecenter();
    };
    /** 旋轉開始：中心放到游標下（只改深度，不改視線方向）。 */
    const pivotAt = (clientX: number, clientY: number) => {
      const h = hitRef.current(clientX, clientY);
      if (!h) return;
      anim = null;
      controls.target.copy(depthPoint(camera.position, h.world));
      controls.update();
    };
    /** 雙擊模型：對準那個點（有動畫，距離不變）。 */
    const lookAtPoint = (p: Vector3) => {
      const dist = camera.position.distanceTo(controls.target);
      const v = camera.getWorldDirection(new Vector3());
      moveTo(p.clone().addScaledVector(v, -dist), p.clone());
    };
    /**
     * 自動回正：旋轉中心跑到模型（放大 25%）外、相機退得太遠、或整個模型都在畫面外 → 300 ms 把中心拉回模型中心
     * （相機位置不動，只轉頭）。滾輪連續滾的時候等停下來再判斷。
     */
    let recenterTimer: ReturnType<typeof setTimeout> | null = null;
    const recenter = () => {
      recenterTimer = null;
      if (anim) return;
      const t = controls.target;
      const m = 0.25;
      const out = (x: number, n: number) => x < -n * m || x > n * (1 + m);
      const far = camera.position.distanceTo(center) > fullRadius() * 3;
      let anyIn = false;
      const p = new Vector3();
      for (const x of [0, vol.X]) for (const y of [0, vol.Y]) for (const z of [0, vol.Z]) {
        p.set(x, y, z).project(camera);
        if (p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) anyIn = true;
      }
      if (out(t.x, vol.X) || out(t.y, vol.Y) || out(t.z, vol.Z) || far || !anyIn) moveTo(camera.position.clone(), center.clone());
    };
    const scheduleRecenter = () => {
      if (recenterTimer) clearTimeout(recenterTimer);
      recenterTimer = setTimeout(recenter, 250);
    };
    controls.addEventListener('end', scheduleRecenter);
    scene.add(new HemisphereLight(new Color(LIGHT.sky, LIGHT.sky, LIGHT.sky), new Color(LIGHT.ground, LIGHT.ground, LIGHT.ground), Math.PI));
    const key = new DirectionalLight(0xffffff, LIGHT.key * Math.PI);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const frame = new LineSegments(new EdgesGeometry(new BoxGeometry(vol.X, vol.Y, vol.Z)), new LineBasicMaterial({ color: 0xc9cdd1 }));
    frame.position.copy(center);
    scene.add(frame);
    // 體素座標的物件：翻 y
    const voxelSpace = <T extends Mesh | LineSegments | LineLoop>(o: T, order = 0) => {
      o.scale.set(1, -1, 1);
      o.position.y = vol.Y;
      o.renderOrder = order;
      o.frustumCulled = false;
      scene.add(o);
      return o;
    };
    // 沒有預覽時盒子是空的（min > max），什麼都不挖
    const hole: Ctx['hole'] = { min: { value: new Vector3(1, 1, 1) }, max: { value: new Vector3(0, 0, 0) } };
    const mainParams = { vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } as const;
    const mesh = voxelSpace(new Mesh(new BufferGeometry(), withHole(new MeshLambertMaterial(mainParams), hole)));
    // 點選與滑過提示走 BVH（three-mesh-bvh），不必每次掃過全部三角形
    mesh.raycast = acceleratedRaycast;
    const parts = new Map<number, Mesh<BufferGeometry, MeshLambertMaterial>>();
    const partsCache: Ctx['partsCache'] = new Map();
    const partGroup = new Group();
    partGroup.scale.set(1, -1, 1);
    partGroup.position.y = vol.Y;
    scene.add(partGroup);
    const previewMesh = voxelSpace(new Mesh(new BufferGeometry(), new MeshLambertMaterial(mainParams)));
    previewMesh.visible = false;
    const layerOf = <T extends Mesh | LineSegments>(material: ThreeMaterial, order: number): Layer<T> => {
      const group = new Group();
      group.scale.set(1, -1, 1);
      group.position.y = vol.Y;
      group.visible = false;
      scene.add(group);
      return { group, parts: new Map(), shown: null, material, order };
    };
    const selFill = layerOf<Mesh>(withHole(new MeshLambertMaterial({ color: 0x1677ff, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide }), hole), 2);
    const voidMesh = layerOf<Mesh>(new MeshBasicMaterial({ color: 0x262626, transparent: true, opacity: 0.8, depthTest: false, side: DoubleSide }), 3);
    // 差異模式：改過的部分實色（材質色／拿掉的紅）＋深藍邊（紅留給「被拿掉的」）
    const diffFill = layerOf<Mesh>(withHole(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), hole), 1);
    const diffEdges = layerOf<LineSegments>(new LineBasicMaterial({ color: DIFF_EDGE_HEX }), 2);
    const voidEdges = layerOf<LineSegments>(new LineBasicMaterial({ color: 0xff7875, depthTest: false, transparent: true, opacity: 0.75 }), 4);
    const ring = voxelSpace(new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: BRUSH_COLOR, depthTest: false, linewidth: 2 })), 5);
    // 法線箭頭：往外＝長、往內＝縮，按下前就知道會往哪推
    const arrow = voxelSpace(new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: BRUSH_COLOR, depthTest: false })), 5);
    ring.visible = arrow.visible = false;
    const selBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x1677ff }));
    selBox.visible = false;
    scene.add(selBox);
    // 滑過未選取的結構：細灰框
    const hoverBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x595959, transparent: true, opacity: 0.8 }));
    hoverBox.visible = false;
    scene.add(hoverBox);
    const stepLine = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ color: BRUSH_COLOR, dashSize: 2, gapSize: 1.5, transparent: true, opacity: 1, depthTest: false }));
    stepLine.visible = false;
    stepLine.renderOrder = 6;
    scene.add(stepLine);
    let stepTimer: ReturnType<typeof setInterval> | null = null;
    const stepBox = (b: BBox) => {
      if (stepTimer) clearInterval(stepTimer);
      stepLine.geometry.dispose();
      stepLine.geometry = boxEdges(b);
      stepLine.computeLineDistances();
      stepLine.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
      stepLine.visible = true;
      const m = stepLine.material;
      m.opacity = 1;
      const t0 = performance.now();
      const fade = reducedMotion() ? 0 : 500;
      stepTimer = setInterval(() => {
        const t = performance.now() - t0;
        // 1 秒全亮、最後 0.5 秒淡出（減少動態：1.5 秒後直接收掉）
        m.opacity = t < 1500 - fade ? 1 : Math.max(0, (1500 - t) / Math.max(1, fade));
        if (t >= 1500) {
          stepLine.visible = false;
          if (stepTimer) clearInterval(stepTimer);
          stepTimer = null;
        }
        kick();
      }, 50);
      kick();
    };
    const ghost = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ color: BRUSH_COLOR, dashSize: 3, gapSize: 2, depthTest: false }));
    ghost.visible = false;
    ghost.renderOrder = 6;
    scene.add(ghost);
    const ghostFill = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: BRUSH_COLOR, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: DoubleSide }));
    ghostFill.visible = false;
    ghostFill.renderOrder = 6;
    scene.add(ghostFill);
    // 十字：淡一點，別和筆刷圈搶
    const cross = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xd46b08, transparent: true, opacity: 0.5 }));
    scene.add(cross);
    const cap = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ side: DoubleSide }));
    cap.visible = false;
    cap.frustumCulled = false;
    scene.add(cap);
    const capEdges = new LineSegments(new EdgesGeometry(cap.geometry), new LineBasicMaterial({ color: 0xd46b08 }));
    capEdges.visible = false;
    scene.add(capEdges);
    // 卡片滑過六面小方塊：選取外框的那一面＋箭頭（永遠畫在最上面）
    const faceHi = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ color: BRUSH_COLOR, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, side: DoubleSide }));
    faceHi.renderOrder = 7;
    faceHi.visible = false;
    faceHi.raycast = () => {};
    scene.add(faceHi);
    const faceArrow = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: BRUSH_COLOR, depthTest: false }));
    faceArrow.renderOrder = 7;
    faceArrow.visible = false;
    scene.add(faceArrow);
    /** 世界座標（翻 y）。 */
    const W = (x: number, y: number, z: number) => new Vector3(x, vol.Y - y, z);
    const highlightFace = (dir: Vec3 | null) => {
      const b = bboxRef.current;
      kick();
      if (!dir || !b) {
        faceHi.visible = faceArrow.visible = false;
        return;
      }
      const a = axisOf(dir);
      const lo = [b.x0, b.y0, b.z0];
      const hi = [b.x1 + 1, b.y1 + 1, b.z1 + 1];
      const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      c[a] = dir[a] > 0 ? hi[a] : lo[a];
      const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
      faceHi.rotation.set(0, 0, 0);
      if (a === 2) faceHi.scale.set(size[0], size[1], 1);
      else if (a === 1) {
        faceHi.rotation.x = -Math.PI / 2;
        faceHi.scale.set(size[0], size[2], 1);
      } else {
        faceHi.rotation.y = -Math.PI / 2;
        faceHi.scale.set(size[2], size[1], 1);
      }
      const p0 = W(c[0], c[1], c[2]);
      faceHi.position.copy(p0);
      faceHi.visible = true;
      const len = Math.max(4, 0.35 * Math.hypot(size[0], size[1], size[2]));
      const v = new Vector3(dir[0], -dir[1], dir[2]);
      const tip = p0.clone().addScaledVector(v, len);
      const side = new Vector3(a === 0 ? 0 : 1, a === 0 ? 1 : 0, 0).multiplyScalar(len * 0.18);
      const back = tip.clone().addScaledVector(v, -len * 0.25);
      faceArrow.geometry.dispose();
      faceArrow.geometry = new BufferGeometry().setFromPoints([p0, tip, tip, back.clone().add(side), tip, back.clone().sub(side)]);
      faceArrow.visible = true;
    };
    const handleGroup = new Group();
    scene.add(handleGroup);
    handleGroupRef.current = handleGroup;
    ctxRef.current = { renderer, scene, camera, controls, mesh, parts, partGroup, shown: null, partsCache, diffFill, diffEdges, selFill, voidMesh, voidEdges, selBox, hoverBox, previewMesh, hole, ghost, ghostFill, ring, arrow, cross, cap, capEdges };
    // 按下要在 OrbitControls（掛在 canvas 上）之前決定是不是筆刷：capture 階段先跑，筆刷就先把 controls 關掉，
    // OrbitControls 連這一下都不會記到。之前是 React 的 onPointerDown 事後才關，OrbitControls 已經記了一個指標、
    // 又因為指標被我們捕捉而收不到放開，之後滾輪縮放就一直沒反應（視角像被鎖住）。
    // 會拾取的事件（plan v15 B4）：capture 階段先重設這一事件的 BVH 建置預算（比 onDown 先註冊所以先跑），順便多畫兩格
    //（滑鼠在別處移動、父元件重 render 不必重畫 3D，plan v9 P7）
    const onEvent = () => {
      beginPickEvent();
      kick();
    };
    const kickEvents = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'dblclick'] as const;
    kickEvents.forEach((ev) => host.addEventListener(ev, onEvent, { capture: true, passive: true }));
    const onDown = (e: PointerEvent) => downHandler.current?.(e);
    host.addEventListener('pointerdown', onDown, { capture: true });
    let flashTimer: ReturnType<typeof setTimeout>[] = [];
    const flash = () => {
      flashTimer.forEach(clearTimeout);
      flashTimer = [];
      const m = selBox.material;
      const on = () => (m.color.setHex(BRUSH_COLOR), kick());
      const off = () => (m.color.setHex(0x1677ff), kick());
      if (reducedMotion()) return;
      [0, 300, 600].forEach((t) => {
        flashTimer.push(setTimeout(on, t));
        flashTimer.push(setTimeout(off, t + 150));
      });
    };

    const recolor = (mask: Uint8Array, color: Vec3) => {
      const c = ctxRef.current;
      if (!c) return;
      // 直接改 GPU 上的顏色：共用這些 Mesh 的快取組就不對了，整個快取作廢（目前畫的留著）
      const old = [...c.partsCache.values()];
      c.partsCache.clear();
      disposeOrphans(c, old);
      for (const part of c.parts.values()) recolorGeometry(part.geometry, mask, color);
    };
    const recolorGeometry = (g: BufferGeometry, mask: Uint8Array, color: Vec3) => {
      const pos = g.attributes.position;
      const nor = g.attributes.normal;
      const col = g.attributes.color;
      if (!pos || !nor || !col) return;
      const p = pos.array as Float32Array;
      const n = nor.array as Float32Array;
      const c = col.array as Float32Array;
      const r = color[0] / 255;
      const gg = color[1] / 255;
      const b = color[2] / 255;
      for (let t = 0; t < p.length; t += 9) {
        const cx = (p[t] + p[t + 3] + p[t + 6]) / 3;
        const cy = (p[t + 1] + p[t + 4] + p[t + 7]) / 3;
        const cz = (p[t + 2] + p[t + 5] + p[t + 8]) / 3;
        const v = voxelFromHit(vol, [cx, cy, cz], [n[t], n[t + 1], n[t + 2]]);
        if (v < 0 || !mask[v]) continue;
        for (let k = 0; k < 9; k += 3) {
          c[t + k] = r;
          c[t + k + 1] = gg;
          c[t + k + 2] = b;
        }
      }
      col.needsUpdate = true;
      kick();
    };
    handle.current = {
      setView,
      recolor,
      flash,
      highlightFace,
      lookAt: (p) => lookAtPoint(new Vector3(p[0] + 0.5, vol.Y - p[1] - 0.5, p[2] + 0.5)),
      focusBox: (b) => setView('fit', b),
      stepBox,
    };
    camRef.current = { pivotAt, lookAtPoint };
    host.addEventListener('wheel', onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      kick();
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);
    // 選取標籤的寬度（plan v15 B5）：ResizeObserver 量一次存起來，render loop 不讀 DOM。
    // display:none 時量到 0，留著上一次的寬；文字變了（換選取、改名）會再量，順便多畫兩格讓位置跟上
    const tagW = { current: 0 };
    const tagEl = floatRef.current;
    const tagRo = tagEl
      ? new ResizeObserver((entries) => {
          for (const e of entries) {
            const w = e.borderBoxSize?.[0]?.inlineSize ?? (e.target as HTMLElement).offsetWidth;
            if (w) tagW.current = w;
          }
          kick();
        })
      : null;
    if (tagEl) tagRo!.observe(tagEl);

    // 小標籤與座標軸小圖在 render loop 裡投影定位，不走 React 狀態
    const p = new Vector3();
    const q = camera.quaternion.clone();
    const axes: [Axis, Vector3][] = [
      ['x', new Vector3(1, 0, 0)],
      ['y', new Vector3(0, -1, 0)],
      ['z', new Vector3(0, 0, 1)],
    ];
    let raf = 0;
    // 只在有變化時才畫（鏡頭動、動畫、滑鼠事件、React 更新、Worker 結果到了）：
    // 靜止時不佔主執行緒，Worker 結果回來能馬上處理
    // 轉視角中（plan v15 B6）：start 之後第一次真的動了才降 pixelRatio（點一下不拖不會閃一格）；end 恢復（阻尼尾巴用全解析度）
    let orbiting = false;
    const onOrbitStart = () => {
      orbiting = true;
    };
    const onOrbitChange = () => {
      if (orbiting) lowRes(true);
      kick();
    };
    const onOrbitEnd = () => {
      orbiting = false;
      lowRes(false);
    };
    controls.addEventListener('start', onOrbitStart);
    controls.addEventListener('change', onOrbitChange);
    controls.addEventListener('end', onOrbitEnd);
    const tick = () => {
      if (anim) {
        const k = Math.min(1, (performance.now() - anim.start) / anim.ms);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        camera.position.lerpVectors(anim.p0, anim.p1, e);
        controls.target.lerpVectors(anim.t0, anim.t1, e);
        if (k >= 1) anim = null;
        kick();
      }
      // 阻尼還在動時 update 會回 true
      if (controls.update()) kick();
      if (dirty.current <= 0) {
        raf = requestAnimationFrame(tick);
        return;
      }
      dirty.current--;
      handleTick.current();
      renderer.render(scene, camera);
      const tag = floatRef.current;
      const b = bboxRef.current;
      if (tag) {
        if (!b) tag.style.display = 'none';
        else {
          const w = host.clientWidth;
          const h = host.clientHeight;
          let top = Infinity;
          let sx = 0;
          for (const x of [b.x0, b.x1 + 1])
            for (const y of [b.y0, b.y1 + 1])
              for (const z of [b.z0, b.z1 + 1]) {
                p.set(x, vol.Y - y, z).project(camera);
                const px = ((p.x + 1) / 2) * w;
                const py = ((1 - p.y) / 2) * h;
                sx += px;
                if (py < top) top = py;
              }
          const cx = sx / 8;
          // 寬度由 ResizeObserver 量（plan v15 B5）：這裡只寫 style，不讀 offsetWidth（讀會強制 layout，下一幀又 thrash）
          const tw = tagW.current || 300;
          // 剖面列在上緣時標籤別壓到它
          const minTop = clipRef.current ? 60 : 8;
          tag.style.display = '';
          tag.style.left = `${Math.max(8, Math.min(w - tw - 8, cx - tw / 2))}px`;
          tag.style.top = `${Math.max(minTop, Math.min(h - 48, top - 44))}px`;
        }
      }
      const gz = gizmoRef.current;
      if (gz) {
        q.copy(camera.quaternion).invert();
        const items = axes.map(([a, v]) => ({ a, v: v.clone().applyQuaternion(q) })).sort((m, n) => m.v.z - n.v.z);
        items.forEach(({ a, v }, k) => {
          const line = gz.querySelector<SVGLineElement>(`[data-axis-line="${a}"]`)!;
          const text = gz.querySelector<SVGTextElement>(`[data-axis-text="${a}"]`)!;
          const ex = 36 + v.x * 24;
          const ey = 36 - v.y * 24;
          line.setAttribute('x2', ex.toFixed(1));
          line.setAttribute('y2', ey.toFixed(1));
          line.style.opacity = String(0.55 + 0.45 * ((v.z + 1) / 2));
          text.setAttribute('x', (36 + v.x * 31).toFixed(1));
          text.setAttribute('y', (36 - v.y * 31 + 3.5).toFixed(1));
          line.setAttribute('data-order', String(k));
        });
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      controls.removeEventListener('start', onOrbitStart);
      controls.removeEventListener('change', onOrbitChange);
      controls.removeEventListener('end', onOrbitEnd);
      kickEvents.forEach((ev) => host.removeEventListener(ev, onEvent, { capture: true }));
      flashTimer.forEach(clearTimeout);
      if (stepTimer) clearInterval(stepTimer);
      ro.disconnect();
      tagRo?.disconnect();
      host.removeEventListener('pointerdown', onDown, { capture: true });
      host.removeEventListener('wheel', onWheel);
      controls.removeEventListener('end', scheduleRecenter);
      if (recenterTimer) clearTimeout(recenterTimer);
      camRef.current = null;
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments || o instanceof LineLoop) {
          o.geometry.dispose();
          (o.material as { dispose: () => void }).dispose();
        }
      });
      cap.material.map?.dispose();
      capRef.current = null;
      // 快取裡、不在場景上的 chunk
      for (const m of partsCache.values()) for (const p of m.values()) p.geometry.dispose();
      for (const l of [selFill, voidMesh, voidEdges, diffFill, diffEdges]) l.material.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [vol.X, vol.Y, vol.Z]);

  // 主網格（Worker greedy mesh，切 chunk）：一步之後只換改到的 chunk（§8.4）。
  // 差異模式（plan v12 §5.2）不再另外要整個模型的 ghost：主網格同一組 chunk、只換材質（下面的材質 effect），改到的實色層另外畫。
  // 只採用最新一次請求的結果
  const meshSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++meshSeq.current;
    setMeshing(true);
    const key = [[...hidden].sort().join(','), materials.map((m) => m.color).join('')].join('|');
    const sid = sidOf(state);
    const done = (n: number, full: boolean) => {
      // 量測用（scripts/e2e/perf.cjs）：最近一次換上正式網格的時間與換了幾個 chunk
      (window as unknown as { __meshAt?: { t: number; n: number; full: boolean } }).__meshAt = { t: performance.now(), n, full };
      // 正式網格到了，預覽收掉
      hidePreview(c);
    };
    let req: Promise<void>;
    // 快取裡有（看原始、切 split、復原）：直接換上，不必跟 Worker 要
    const hit = c.partsCache.get(`${sid}|${key}`);
    if (hit) {
      showParts(c, hit, { sid, key }, true, state.owner === 'base' || state.owner === undefined);
      done(0, false);
      req = Promise.resolve();
    } else {
      const pin = state.owner === 'base' || state.owner === undefined;
      const fetch = (base: number | undefined, alts: number[]): Promise<void> =>
        call('chunks', { sid, key, hidden: hiddenTable(hidden), diff: false, palette: palette(materials), base, alts }).then((r) => {
          if (seq !== meshSeq.current || !ctxRef.current) return;
          const from = r.full ? null : r.from === c.shown?.sid ? c.parts : (c.partsCache.get(`${r.from}|${key}`) ?? null);
          // 底那一組剛好不在了：退回全量
          if (!r.full && !from) return fetch(undefined, []);
          showParts(c, nextParts(c, from, r.items), { sid, key }, true, pin, r.full ? null : new Set(r.items.map((it) => it.k)));
          done(r.items.length, r.full);
        });
      // 快取裡同畫法的其他版本：Worker 可以從其中一個增量（restore 回來的 split 從原始那一組）
      const alts = [...c.partsCache.keys()].filter((k) => k.endsWith(`|${key}`) && k.indexOf('|') === k.length - key.length - 1).map((k) => Number(k.slice(0, k.indexOf('|'))));
      req = fetch(c.shown && c.shown.key === key ? c.shown.sid : undefined, alts);
    }
    req.then(() => (setMeshing(false), kick())).catch(() => setMeshing(false));
  }, [state, materials, hidden]);

  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    // 聚焦編輯：其他結構淡到 0.18（選取另外由選取層畫實色）；材質半透明是獨立的顯示選項
    // 差異模式（plan v12 §5.2）：主網格原地換成半透明灰（「沒改」），geometry 一個位元組都不動
    const dim = dimOthers && mode !== 'orig';
    const ghost = mode === 'diff';
    for (const mat of [c.mesh.material, c.previewMesh.material]) {
      const main = mat === c.mesh.material;
      const op = ghost && main ? GHOST_OPACITY : dim && main ? 0.18 : translucent ? 0.3 : 1;
      mat.transparent = op < 1;
      mat.opacity = op;
      mat.depthWrite = op === 1;
      mat.vertexColors = !(ghost && main);
      mat.color.setHex(ghost && main ? GHOST_HEX : 0xffffff);
      mat.needsUpdate = true;
    }
    const sm = c.selFill.material as MeshLambertMaterial;
    sm.vertexColors = dim;
    sm.color.set(dim ? 0xffffff : 0x1677ff);
    sm.transparent = !dim;
    sm.opacity = dim ? 1 : 0.22;
    sm.depthWrite = dim;
    sm.needsUpdate = true;
    kick();
  }, [translucent, dimOthers, mode]);

  // 差異層（plan v12 §5.2）：只對 diff 外框碰到的 chunk 做實色層與深藍邊；一步之後只重算改到的 chunk
  const diffSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++diffSeq.current;
    const F = c.diffFill;
    const E = c.diffEdges;
    if (mode !== 'diff') {
      F.group.visible = E.group.visible = false;
      return;
    }
    const sid = sidOf(state);
    const key = `diff|${[...hidden].sort().join(',')}|${materials.map((m) => m.color).join('')}`;
    const base = F.shown?.key === key ? F.shown.sid : undefined;
    if (base === undefined) F.group.visible = E.group.visible = false;
    const t0 = performance.now();
    call('layer', { sid, key, filter: { diff: true }, tint: [1, 0, 0], base, palette: palette(materials), hidden: hiddenTable(hidden) })
      .then((r) => {
        if (seq !== diffSeq.current || !ctxRef.current) return;
        setLayer(F, r.items.map((it) => ({ k: it.k, geometry: it.m.quads ? toGeometry(it.m) : null })), r.full, (g) => new Mesh(g, F.material));
        F.shown = { sid, key };
        // 深藍邊：每個改到的 chunk 一份；總 quads 太多就不描（EdgesGeometry 是 O(n log n)）
        let quads = 0;
        for (const p of F.parts.values()) quads += p.geometry.attributes.position.count / 6;
        if (quads > EDGE_QUADS_MAX) clearLayer(E);
        else {
          const ks = r.full || !E.shown ? [...F.parts.keys()] : r.items.map((it) => it.k);
          setLayer(E, ks.map((k) => ({ k, geometry: F.parts.has(k) ? new EdgesGeometry(F.parts.get(k)!.geometry, 1) : null })), r.full || !E.shown, (g) => new LineSegments(g, E.material));
          E.shown = F.shown;
        }
        F.group.visible = E.group.visible = true;
        // 量測用（m12.cjs）：按 D 到差異層換上的時間、改到的 chunk 數
        if (import.meta.env.DEV) (window as unknown as { __diffAt?: { ms: number; chunks: number; full: boolean } }).__diffAt = { ms: performance.now() - t0, chunks: F.parts.size, full: r.full };
        kick();
      })
      .catch(() => {}); // 過期的版本：等新的 state 再畫
  }, [state, hidden, materials, mode]);

  // 即時預覽：裁切範圍（外加一圈鄰居）在主執行緒 greedy mesh，主網格同一範圍挖掉；正式網格 swap 時收掉
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    if (!preview || preview.base !== sidOf(state) || mode === 'diff') {
      hidePreview(c);
      return;
    }
    const b = preview.box;
    // Worker 算好的網格（拖拉第 2 級，§4.5）直接用；否則主執行緒自己做（同一個純函式）
    const m =
      preview.mesh ??
      previewMesh(vol, b, preview.data, (id) => hidden.has(id), (code) => {
        const [r, g, bl] = rgb.get(code & 255) ?? [255, 0, 255];
        return code & DIFF_BIT ? [(r / 255) * 0.35 + 0.65, (g / 255) * 0.35 + 0.2, (bl / 255) * 0.35 + 0.2] : [r / 255, g / 255, bl / 255];
      }, null);
    c.previewMesh.geometry.dispose();
    c.previewMesh.geometry = toGeometry(m);
    c.previewMesh.visible = true;
    c.hole.min.value.set(b.x0 - HOLE_EPS, b.y0 - HOLE_EPS, b.z0 - HOLE_EPS);
    c.hole.max.value.set(b.x1 + 1 + HOLE_EPS, b.y1 + 1 + HOLE_EPS, b.z1 + 1 + HOLE_EPS);
  }, [preview]);

  // 空洞透視：VOID 永遠畫在最上面（深色面＋紅邊）
  const voidSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++voidSeq.current;
    const off = () => {
      c.voidMesh.group.visible = c.voidEdges.group.visible = false;
    };
    if (!xray || hidden.has(VOID)) return off();
    const sid = sidOf(state);
    const L = c.voidMesh;
    const base = L.shown?.key === 'void' ? L.shown.sid : undefined;
    call('layer', { sid, key: 'void', filter: { mat: VOID }, tint: [0.15, 0.15, 0.15], base })
      .then((r) => {
        if (seq !== voidSeq.current || !ctxRef.current) return;
        setLayer(L, r.items.map((it) => ({ k: it.k, geometry: it.m.quads ? toGeometry(it.m) : null })), r.full, (g) => new Mesh(g, L.material));
        L.shown = { sid, key: 'void' };
        // 紅邊：每個 chunk 一份；空洞太多時描邊太貴（EdgesGeometry 是 O(n log n)），就不描（plan v9 P18）
        let quads = 0;
        for (const p of L.parts.values()) quads += p.geometry.attributes.position.count / 6;
        const E = c.voidEdges;
        if (quads > EDGE_QUADS_MAX) clearLayer(E);
        else {
          const ks = r.full || !E.shown ? [...L.parts.keys()] : r.items.map((it) => it.k);
          setLayer(E, ks.map((k) => ({ k, geometry: L.parts.has(k) ? new EdgesGeometry(L.parts.get(k)!.geometry, 30) : null })), r.full || !E.shown, (g) => new LineSegments(g, E.material));
          E.shown = L.shown;
        }
        // 沒有空洞時網格是空的
        c.voidMesh.group.visible = c.voidEdges.group.visible = L.parts.size > 0;
        kick();
      })
      .catch(() => {}); // 過期的版本（Worker 已前進）：等新的 state 再畫
  }, [state, hidden, xray]);

  /** 選取的結構 key（不隨 relabel 換編號）：選取層的畫法 key。 */
  const selKeys = useMemo(() => (selComps ?? []).map((i) => state.L.comps[i]?.key).sort().join(','), [selComps, state]);
  // 選取：半透明網格（只含 affMask，沿法線外推）＋ bbox 線框；換選取時先藏舊的再等新的
  const selSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++selSeq.current;
    const L = c.selFill;
    if (!selComps?.length || !selBBox) {
      c.selBox.visible = false;
      L.group.visible = false;
      clearLayer(L);
      return;
    }
    const b = selBBox;
    c.selBox.geometry.dispose();
    c.selBox.geometry = boxEdges(b);
    c.selBox.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
    c.selBox.visible = true;
    const tint = SEL_RGB.map((v) => v / 255) as Vec3;
    // key＝選了哪些結構（key 不隨 relabel 換編號）＋範圍：同一個選取、每一步只重算改到的 chunk（§4.6）
    const solid = dimOthers && mode !== 'orig';
    const key = `${selKeys}|${scope.axis}:${scope.lo}-${scope.hi}${solid ? `|solid|${materials.map((m) => m.color).join('')}` : ''}`;
    const sid = sidOf(state);
    const base = L.shown?.key === key ? L.shown.sid : undefined;
    // 換選取時先藏舊的再等新的
    if (base === undefined) L.group.visible = false;
    call('layer', { sid, key, filter: { comps: selComps, scope, box: b }, tint, inflate: INFLATE, base, ...(solid ? { palette: palette(materials) } : {}) })
      .then((r) => {
        if (seq !== selSeq.current || !ctxRef.current) return;
        setLayer(L, r.items.map((it) => ({ k: it.k, geometry: it.m.quads ? toGeometry(it.m) : null })), r.full, (g) => new Mesh(g, L.material));
        L.shown = { sid, key };
        L.group.visible = true;
        kick();
      })
      .catch(() => {}); // 過期的版本：等新的 state 再畫
  }, [state, selComps, scope, selBBox, selKeys, dimOthers, mode, materials]);

  // 把手（plan v10 §4.5）：面把手＝選取外框六面中央的箭頭；角把手＝剖面四個角的小菱形（範圍中點那一片）。
  // 永遠畫在最上面、固定螢幕大小（每一幀在 handleTick 縮放）；背對相機的面把手不畫。
  useEffect(() => {
    const g = handleGroupRef.current;
    if (!g) return;
    // 量測用（perf.cjs，plan v15 B1）：這個 effect 跑了幾次＝把手拆掉重建了幾次；點切面換 cursor 不該增加
    if (import.meta.env.DEV) {
      const w = window as unknown as { __handleBuilds?: number };
      w.__handleBuilds = (w.__handleBuilds ?? 0) + 1;
    }
    for (const { obj } of handlesRef.current) {
      g.remove(obj);
      if (obj instanceof ArrowHelper) obj.dispose();
      else {
        obj.geometry.dispose();
        (obj.material as MeshBasicMaterial).dispose();
      }
    }
    handlesRef.current = [];
    hoverHandle.current = null;
    kick();
    if (tool !== 'handles' || !selBBox || mode === 'orig') return;
    const world = (p: Vec3) => new Vector3(p[0], vol.Y - p[1], p[2]);
    for (const f of faceHandles(selBBox)) {
      const a = new ArrowHelper(new Vector3(f.dir[0], -f.dir[1], f.dir[2]), world(f.pos), 1, HANDLE_COLOR);
      for (const m of [a.line.material, a.cone.material] as (LineBasicMaterial | MeshBasicMaterial)[]) {
        m.depthTest = false;
        m.transparent = true;
      }
      a.renderOrder = a.line.renderOrder = a.cone.renderOrder = 8;
      g.add(a);
      handlesRef.current.push({ h: f, obj: a });
    }
    if (cornerAxis) {
      const ai = axisIndex(cornerAxis);
      const lo = [selBBox.x0, selBBox.y0, selBBox.z0][ai];
      const hi = [selBBox.x1, selBBox.y1, selBBox.z1][ai];
      for (const c of cornerHandles(selBBox, cornerAxis, Math.round((lo + hi) / 2))) {
        const m = new Mesh(new OctahedronGeometry(0.5), new MeshBasicMaterial({ color: CORNER_COLOR, depthTest: false, transparent: true }));
        m.position.copy(world(c.pos));
        m.renderOrder = 8;
        g.add(m);
        handlesRef.current.push({ h: c, obj: m });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, selBBox, cornerAxis, mode, vol.Y]);
  handleTick.current = () => {
    const c = ctxRef.current;
    const host = hostRef.current;
    if (!c || !host || !handlesRef.current.length) return;
    const cam = c.camera;
    const k = (2 * Math.tan((cam.fov * Math.PI) / 360)) / Math.max(1, host.clientHeight);
    const active = hdRef.current?.h ?? hoverHandle.current;
    for (const { h, obj } of handlesRef.current) {
      const wpp = cam.position.distanceTo(obj.position) * k;
      const on = h === active;
      if (h.kind === 'face') {
        const toEye: Vec3 = [cam.position.x - obj.position.x, -(cam.position.y - obj.position.y), cam.position.z - obj.position.z];
        obj.visible = facesCamera(h.dir, toEye) || on;
        const len = HANDLE_PX * 2 * wpp * (on ? 1.25 : 1);
        (obj as ArrowHelper).setLength(len, len * 0.45, len * 0.3);
        (obj as ArrowHelper).setColor(on ? HANDLE_HOT : HANDLE_COLOR);
      } else {
        obj.scale.setScalar(HANDLE_PX * 0.9 * wpp * (on ? 1.3 : 1));
        ((obj as Mesh).material as MeshBasicMaterial).color.setHex(on ? HANDLE_HOT : CORNER_COLOR);
      }
    }
  };
  /** 游標下的把手（螢幕距離 ≤ 熱區）。 */
  const handleAt = (clientX: number, clientY: number) => {
    const c = ctxRef.current;
    const host = hostRef.current;
    if (!c || !host || toolRef.current !== 'handles' || !handlesRef.current.length) return null;
    const r = host.getBoundingClientRect();
    const v = new Vector3();
    return pickHandle(
      handlesRef.current.map(({ h, obj }) => {
        if (!obj.visible) return { h, screen: null };
        // 面把手抓箭頭中段（不是面中央，免得和面上的點選搶）
        if (h.kind === 'face') v.copy(obj.position).addScaledVector(new Vector3(h.dir[0], -h.dir[1], h.dir[2]), (obj as ArrowHelper).cone.position.y * 0.75);
        else v.copy(obj.position);
        v.project(c.camera);
        return { h, screen: v.z > 1 ? null : ([((v.x + 1) / 2) * r.width + r.left, ((1 - v.y) / 2) * r.height + r.top] as [number, number]) };
      }),
      clientX,
      clientY,
    );
  };
  // 開發模式：e2e（scripts/e2e/m10.cjs）拿把手的螢幕位置（和點把手用同一套投影）
  if (import.meta.env.DEV)
    (window as unknown as { __handles?: () => unknown[] }).__handles = () => {
      const c = ctxRef.current;
      const host = hostRef.current;
      if (!c || !host) return [];
      const r = host.getBoundingClientRect();
      return handlesRef.current.map(({ h, obj }) => {
        const v = obj.position.clone();
        if (h.kind === 'face') v.addScaledVector(new Vector3(h.dir[0], -h.dir[1], h.dir[2]), (obj as ArrowHelper).cone.position.y * 0.75);
        v.project(c.camera);
        return { ...h, visible: obj.visible, x: ((v.x + 1) / 2) * r.width + r.left, y: ((1 - v.y) / 2) * r.height + r.top };
      });
    };
  const handleTip = (h: Handle3D, v: number) => {
    if (h.kind === 'face') return v ? `${directionName(h.dir)}${v > 0 ? '長' : '縮'} ${Math.abs(v)} vx（${(Math.abs(v) * nmPerVoxel).toFixed(1)} nm）· 放開套用，Esc 取消` : `沿箭頭拖：${directionName(h.dir)}長／縮`;
    return v ? `圓角 r = ${v}（${(v * nmPerVoxel).toFixed(1)} nm）· 放開套用，Esc 取消` : '往內拖＝圓角半徑；點一下調參數';
  };
  const handleOpOf = (d: NonNullable<typeof hdRef.current>) =>
    !d.v ? null : d.h.kind === 'face' ? (faceOp?.(d.h.dir, d.v) ?? null) : (roundOp?.(d.h.id, d.v) ?? null);

  /** 剖面的世界座標平面；null = 不剖。 */
  const clipPlane = (cl: Clip | null) => {
    if (!cl) return null;
    const { axis, at, side } = cl;
    if (axis === 'z') return side > 0 ? new Plane(new Vector3(0, 0, -1), at + 1) : new Plane(new Vector3(0, 0, 1), -at);
    if (axis === 'x') return side > 0 ? new Plane(new Vector3(-1, 0, 0), at + 1) : new Plane(new Vector3(1, 0, 0), -at);
    return side > 0 ? new Plane(new Vector3(0, 1, 0), -(vol.Y - at - 1)) : new Plane(new Vector3(0, -1, 0), vol.Y - at);
  };

  // 剖面：剪掉一半、剖口貼切面圖（plan v9 P9）。
  // 幾何、位置只在剖面軸、位置、陣列大小變時重建；貼圖用同一張 canvas＋同一個 CanvasTexture，內容變了才重畫並 needsUpdate。
  const capRef = useRef<{ cv: HTMLCanvasElement; tex: CanvasTexture | null; last: unknown[] | null } | null>(null);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const plane = clipPlane(clip);
    const planes = plane ? [plane] : [];
    for (const o of [c.mesh, c.previewMesh]) o.material.clippingPlanes = planes;
    for (const l of [c.selFill, c.voidMesh, c.voidEdges, c.diffFill, c.diffEdges]) l.material.clippingPlanes = planes;
    // 背面只有剖開時看得到（從剖口看進去）：沒剖面時只畫正面，GPU 少一半 fragment（plan v9 P17）
    for (const m of [c.mesh.material, c.previewMesh.material]) {
      const side = clip ? DoubleSide : FrontSide;
      if (m.side !== side) {
        m.side = side;
        m.needsUpdate = true;
      }
    }
    if (!clip) {
      c.cap.visible = c.capEdges.visible = false;
      return;
    }
    const [W, H] = clip.axis === 'z' ? [vol.X, vol.Y] : clip.axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
    const g = c.cap.geometry as PlaneGeometry;
    if (g.parameters?.width !== W || g.parameters?.height !== H) {
      c.cap.geometry.dispose();
      c.cap.geometry = new PlaneGeometry(W, H);
      c.capEdges.geometry.dispose();
      c.capEdges.geometry = new EdgesGeometry(c.cap.geometry);
    }
    c.cap.rotation.set(0, 0, 0);
    // 留下的那一半的邊界平面座標，往外偏 0.01 蓋住剛好落在平面上的面
    const coord = clip.side > 0 ? clip.at + 1 + 0.01 : clip.at - 0.01;
    if (clip.axis === 'z') c.cap.position.set(vol.X / 2, vol.Y / 2, coord);
    else if (clip.axis === 'y') {
      c.cap.rotation.x = -Math.PI / 2;
      c.cap.position.set(vol.X / 2, vol.Y - coord, vol.Z / 2);
    } else {
      c.cap.rotation.y = -Math.PI / 2;
      c.cap.position.set(coord, vol.Y / 2, vol.Z / 2);
    }
    c.capEdges.position.copy(c.cap.position);
    c.capEdges.rotation.copy(c.cap.rotation);
    c.cap.visible = c.capEdges.visible = true;
  }, [clip, vol.X, vol.Y, vol.Z]);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c || !clip) return;
    const cap = (capRef.current ??= { cv: document.createElement('canvas'), tex: null, last: null });
    const p = preview && preview.base === sidOf(state) && mode === 'now' ? preview : null;
    // 預覽盒沒碰到這一片：當作沒有預覽（拖拉中預覽換了也不必重畫剖口）
    const lo = p ? (clip.axis === 'x' ? p.box.x0 : clip.axis === 'y' ? p.box.y0 : p.box.z0) : 0;
    const hi = p ? (clip.axis === 'x' ? p.box.x1 : clip.axis === 'y' ? p.box.y1 : p.box.z1) : -1;
    const patch = p && clip.at >= lo && clip.at <= hi ? p : null;
    const sel = mode === 'orig' ? null : selMask;
    const dm = mode === 'orig' ? null : diffMask;
    const args = [vol, clip.axis, clip.at, rgb, hidden, sel, dm, patch];
    if (cap.last && args.every((a, k) => a === cap.last![k])) return;
    cap.last = args;
    const [W, H] = clip.axis === 'z' ? [vol.X, vol.Y] : clip.axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
    const resized = cap.cv.width !== W || cap.cv.height !== H;
    drawSlice(cap.cv, vol, clip.axis, clip.at, rgb, hidden, sel, dm, patch);
    if (import.meta.env.DEV) (window as unknown as { __capDraw?: number }).__capDraw = ((window as unknown as { __capDraw?: number }).__capDraw ?? 0) + 1;
    if (!cap.tex || resized) {
      // 大小變了要換一個貼圖（WebGL 的貼圖大小建立後不變）
      cap.tex?.dispose();
      cap.tex = new CanvasTexture(cap.cv);
      // 開發模式計數（perf.cjs：剖面開著拖拉，每幀不重建貼圖物件）
      if (import.meta.env.DEV) (window as unknown as { __capTex?: number }).__capTex = ((window as unknown as { __capTex?: number }).__capTex ?? 0) + 1;
      cap.tex.magFilter = NearestFilter;
      cap.tex.minFilter = NearestFilter;
      cap.tex.generateMipmaps = false;
      c.cap.material.map = cap.tex;
      c.cap.material.needsUpdate = true;
    } else cap.tex.needsUpdate = true;
    kick();
  }, [clip, vol, rgb, hidden, selMask, diffMask, mode, preview, state]);

  // 十字
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const [x, y, z] = cursor;
    c.cross.geometry.dispose();
    c.cross.geometry = new BufferGeometry().setFromPoints([
      new Vector3(0, vol.Y - y - 0.5, z + 0.5),
      new Vector3(vol.X, vol.Y - y - 0.5, z + 0.5),
      new Vector3(x + 0.5, 0, z + 0.5),
      new Vector3(x + 0.5, vol.Y, z + 0.5),
      new Vector3(x + 0.5, vol.Y - y - 0.5, 0),
      new Vector3(x + 0.5, vol.Y - y - 0.5, vol.Z),
    ]);
  }, [cursor, vol.X, vol.Y, vol.Z]);

  /**
   * 射線命中 → 體素與它朝外的法線。面朝相機那一側是空的（不然射線會先打到它），
   * 所以取法線指向相機的那個方向反推；兩側相鄰的面重疊時也不會選錯。
   * 剖面貼圖也能點（onCap = true），但不能拖。
   */
  const rayAt = (clientX: number, clientY: number) => {
    const c = ctxRef.current!;
    const r = hostRef.current!.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, c.camera);
    return ray;
  };
  /** 一個三角形命中 → 它貼著的實心體素與外法線（面朝相機那一側是空的）。 */
  const voxelOf = (h: { point: Vector3; face?: { normal: Vector3 } | null }) => {
    const c = ctxRef.current!;
    if (!h.face) return null;
    const pt = c.mesh.worldToLocal(h.point.clone());
    const eye = c.mesh.worldToLocal(c.camera.position.clone()).sub(pt);
    const f = h.face.normal;
    const facing = f.x * eye.x + f.y * eye.y + f.z * eye.z >= 0 ? 1 : -1;
    const n: Vec3 = [f.x * facing, f.y * facing, f.z * facing];
    const point: Vec3 = [pt.x, pt.y, pt.z];
    const solid = (i: number) => i >= 0 && vol.data[i] !== 0 && !hidden.has(vol.data[i]);
    const a = voxelFromHit(vol, point, n);
    if (solid(a)) return { p: a, n, point, onCap: false, world: h.point };
    const back: Vec3 = [-n[0], -n[1], -n[2]];
    const b = voxelFromHit(vol, point, back);
    return solid(b) ? { p: b, n: back, point, onCap: false, world: h.point } : null;
  };
  const hit = (clientX: number, clientY: number) => {
    const c = ctxRef.current;
    if (!c || !c.parts.size) return null;
    const ray = rayAt(clientX, clientY);
    const cl = clipRef.current;
    const plane = clipPlane(cl);
    // 由近到遠（plan v15 B4）：沒剖開＝最近的一個就好；剖開時要濾掉剖面後面的命中，往後一個個找、找到就停
    let h: Intersection | undefined;
    if (!plane) h = pickOrdered(ray, c.parts.values(), true)[0];
    else {
      ray.firstHitOnly = false;
      for (const x of pickAlong(ray, c.parts.values()))
        if (plane.distanceToPoint(x.point) >= -1e-6) {
          h = x;
          break;
        }
    }
    const capHit = cl && c.cap.visible ? ray.intersectObject(c.cap, false)[0] : undefined;
    if (cl && capHit && (!h || capHit.distance < h.distance)) {
      const w = capHit.point;
      const x = Math.floor(w.x);
      const y = Math.floor(vol.Y - w.y);
      const z = Math.floor(w.z);
      const v: Vec3 = cl.axis === 'x' ? [cl.at, y, z] : cl.axis === 'y' ? [x, cl.at, z] : [x, y, cl.at];
      const p = idx(vol, Math.max(0, Math.min(vol.X - 1, v[0])), Math.max(0, Math.min(vol.Y - 1, v[1])), Math.max(0, Math.min(vol.Z - 1, v[2])));
      return vol.data[p] ? { p, n: [0, 0, 0] as Vec3, point: [w.x, vol.Y - w.y, w.z] as Vec3, onCap: true, world: w } : null;
    }
    return h ? voxelOf(h) : null;
  };
  hitRef.current = (x, y) => hit(x, y);
  /** 沿射線由近到遠經過的結構（key 與各自第一個體素），最多 8 個；被擋住的也能選。 */
  const hitsAlong = (clientX: number, clientY: number): { key: string; p: number }[] => {
    const c = ctxRef.current;
    if (!c || !c.parts.size) return [];
    const ray = rayAt(clientX, clientY);
    ray.firstHitOnly = false;
    const plane = clipPlane(clipRef.current);
    const L = state.L;
    const out: { key: string; p: number }[] = [];
    const seen = new Set<string>();
    // 由近到遠逐個吐出（plan v15 B4）：湊滿 8 個結構就 break，後面的 chunk 不必算
    for (const h of pickAlong(ray, c.parts.values())) {
      if (plane && plane.distanceToPoint(h.point) < -1e-6) continue;
      const v = voxelOf(h);
      if (!v) continue;
      const l = L.labels[v.p];
      if (l < 0) continue;
      const key = L.comps[l].key;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, p: v.p });
      if (out.length >= 8) break;
    }
    return out;
  };
  /**
   * 聚焦編輯時其他結構是半透明的：沿射線找第一個「已選」的體素（穿過前面淡掉的結構），右鍵與筆刷用它。
   * 不在聚焦編輯或沒選取時＝hit。
   */
  const hitSel = (clientX: number, clientY: number) => {
    const c = ctxRef.current;
    const sm = selRef.current;
    if (!c || !c.parts.size || !toolRef.current || !sm) return hit(clientX, clientY);
    const first = hit(clientX, clientY);
    if (first && (first.onCap || sm[first.p])) return first;
    const ray = rayAt(clientX, clientY);
    ray.firstHitOnly = false;
    const plane = clipPlane(clipRef.current);
    for (const h of pickAlong(ray, c.parts.values())) {
      if (plane && plane.distanceToPoint(h.point) < -1e-6) continue;
      const v = voxelOf(h);
      if (v && sm[v.p]) return v;
    }
    return first;
  };
  /** 這個體素屬於哪個結構（hover 標籤用）。 */
  const compAt = (p: number) => {
    const l = state.L.labels[p];
    return l >= 0 ? state.L.comps[l] : null;
  };

  /** 面上的兩個切線軸（體素座標）。 */
  const tangents = (dir: Vec3): [Vec3, Vec3] => {
    const a = axisOf(dir);
    return a === 0 ? [[0, 1, 0], [0, 0, 1]] : a === 1 ? [[1, 0, 0], [0, 0, 1]] : [[1, 0, 0], [0, 1, 0]];
  };

  /** 筆刷範圍的外框（平面座標，max 不含）：以 hit 體素為中心、半徑 r，夾在選取外框裡。 */
  const footprint = (v: Vec3, dir: Vec3, r: number) => {
    const b = bboxRef.current;
    const lo: Vec3 = [0, 0, 0];
    const hi: Vec3 = [vol.X, vol.Y, vol.Z];
    const a = axisOf(dir);
    for (let k = 0; k < 3; k++) {
      if (k === a) continue;
      const bl = b ? [b.x0, b.y0, b.z0][k] : 0;
      const bh = b ? [b.x1 + 1, b.y1 + 1, b.z1 + 1][k] : [vol.X, vol.Y, vol.Z][k];
      lo[k] = Math.max(bl, isFinite(r) ? v[k] - r : bl);
      hi[k] = Math.min(bh, isFinite(r) ? v[k] + r + 1 : bh);
    }
    return { lo, hi };
  };

  /** 筆刷圈：畫在 hit 面上；局部長／縮再加一支法線箭頭（往外＝長）。 */
  const showRing = (v: Vec3 | null, dir: Vec3 | null) => {
    const c = ctxRef.current;
    if (!c) return;
    const br = brushRef.current;
    if (!v || !dir || br.radius === null) {
      c.ring.visible = c.arrow.visible = false;
      return;
    }
    const a = axisOf(dir);
    const [tu, tv] = tangents(dir);
    const center: Vec3 = [v[0] + 0.5, v[1] + 0.5, v[2] + 0.5];
    center[a] += dir[a] * 0.55;
    const r = br.radius + 0.5;
    const pts: Vector3[] = [];
    const at = (du: number, dv: number, dn = 0) =>
      new Vector3(
        center[0] + tu[0] * du + tv[0] * dv + dir[0] * dn,
        center[1] + tu[1] * du + tv[1] * dv + dir[1] * dn,
        center[2] + tu[2] * du + tv[2] * dv + dir[2] * dn,
      );
    const push = (du: number, dv: number) => pts.push(at(du, dv));
    if (br.shape === 'square') {
      push(-r, -r);
      push(r, -r);
      push(r, r);
      push(-r, r);
    } else for (let k = 0; k < 48; k++) push(r * Math.cos((k / 48) * Math.PI * 2), r * Math.sin((k / 48) * Math.PI * 2));
    c.ring.geometry.dispose();
    c.ring.geometry = new BufferGeometry().setFromPoints(pts);
    c.ring.visible = true;
    if (br.mode !== 'push') {
      c.arrow.visible = false;
      return;
    }
    // 箭頭長度跟著筆刷大小，頭部兩撇
    const len = Math.max(3, Math.min(12, r * 1.2));
    const head = Math.max(0.8, len * 0.25);
    const seg: Vector3[] = [
      at(0, 0, 0),
      at(0, 0, len),
      at(0, 0, len),
      at(head * 0.7, 0, len - head),
      at(0, 0, len),
      at(-head * 0.7, 0, len - head),
      at(0, 0, len),
      at(0, head * 0.7, len - head),
      at(0, 0, len),
      at(0, -head * 0.7, len - head),
    ];
    c.arrow.geometry.dispose();
    c.arrow.geometry = new BufferGeometry().setFromPoints(seg);
    c.arrow.visible = true;
  };

  /** 滑過未選取結構：bbox 細框。 */
  const showHoverBox = (b: BBox | null) => {
    const c = ctxRef.current;
    if (!c) return;
    if (!b) {
      c.hoverBox.visible = false;
      return;
    }
    c.hoverBox.geometry.dispose();
    c.hoverBox.geometry = boxEdges(b);
    c.hoverBox.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
    c.hoverBox.visible = true;
  };

  /** 拖拉預覽（橘色虛線）：筆刷範圍 × 深度，或整面時整個外框伸縮。 */
  const showGhost = (d: Drag) => {
    const c = ctxRef.current;
    if (!c) return;
    const br = brushRef.current;
    const a = axisOf(d.dir);
    const sign = d.dir[a];
    const face = d.hitVoxel[a] + (sign > 0 ? 1 : 0);
    let lo: Vec3;
    let hi: Vec3;
    if (br.radius === null && d.mode === 'push') {
      const b = bboxRef.current;
      if (!b) return;
      lo = [b.x0, b.y0, b.z0];
      hi = [b.x1 + 1, b.y1 + 1, b.z1 + 1];
      if (sign > 0) hi[a] = Math.max(lo[a], hi[a] + d.n);
      else lo[a] = Math.min(hi[a], lo[a] - d.n);
    } else {
      ({ lo, hi } = footprint(d.hitVoxel, d.dir, br.radius ?? Infinity));
      let far: number;
      if (d.mode === 'push') far = face + sign * d.n;
      else {
        const to = d.hitVoxel[a] + sign * d.n;
        far = to + (sign > 0 ? 1 : 0);
      }
      lo[a] = Math.min(face, far);
      hi[a] = Math.max(face, far);
    }
    const size: Vec3 = [Math.max(0.02, hi[0] - lo[0]), Math.max(0.02, hi[1] - lo[1]), Math.max(0.02, hi[2] - lo[2])];
    c.ghost.geometry.dispose();
    c.ghost.geometry = new EdgesGeometry(new BoxGeometry(size[0], size[1], size[2]));
    c.ghost.computeLineDistances();
    c.ghost.position.set((lo[0] + hi[0]) / 2, vol.Y - (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    c.ghost.visible = true;
    c.ghostFill.scale.set(size[0], size[1], size[2]);
    c.ghostFill.position.copy(c.ghost.position);
    c.ghostFill.visible = true;
  };
  const hideGhost = () => {
    const c = ctxRef.current;
    if (!c) return;
    c.ghost.visible = c.ghostFill.visible = false;
  };

  const nm = (n: number) => `${(Math.abs(n) * nmPerVoxel).toFixed(1)} nm`;
  const tipOf = (d: Drag) => {
    const br = brushRef.current;
    const who = br.radius === null ? '整面' : `筆刷 r${br.radius}`;
    if (d.mode === 'level') {
      const a = axisOf(d.dir);
      const to = d.hitVoxel[a] + d.dir[a] * d.n;
      return `${who} 方頭到 ${'xyz'[a]} = ${to}${d.n ? `（再${d.n > 0 ? '外' : '內'} ${Math.abs(d.n)} vx，${nm(d.n)}）` : ''}`;
    }
    if (!d.n) return `${who}：拖動改變格數，Esc 取消`;
    return `${who} ${directionName(d.dir)}${d.n >= 0 ? '長' : '縮'} ${Math.abs(d.n)} vx（${nm(d.n)}）`;
  };
  /** 游標旁的提示位置（相對畫布）。 */
  const tipPos = (clientX: number, clientY: number) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: Math.min(clientX - r.left + 16, r.width - 160), y: Math.min(clientY - r.top + 18, r.height - 28) };
  };
  /** 拖拉中的格數：沿法線投影，正對著面時改用垂直位移，並夾在 maxN 內。 */
  const stepsOf = (d: Drag, clientX: number, clientY: number) => {
    const dx = clientX - d.sx;
    const dy = clientY - d.sy;
    // 1 格在螢幕上至少算 MIN_PX 像素，縮得很小時不會一抖就好幾格
    const MIN_PX = 2.5;
    let n: number;
    if (d.headOn) n = Math.round(-dy / Math.max(MIN_PX, d.pxPerVoxel));
    else {
      const len = Math.hypot(d.vx, d.vy);
      n = Math.round((dx * d.vx + dy * d.vy) / len / Math.max(MIN_PX, len));
    }
    return Math.max(-d.maxN, Math.min(d.maxN, n));
  };
  /** 拖拉結束：keep = 這一筆會套用，拖拉中的預覽留著等正式結果；否則連預覽一起收掉。 */
  const endDrag = (d: Drag | null, keep = false) => {
    const c = ctxRef.current;
    if (!c) return;
    c.controls.enabled = true;
    lowResRef.current(false);
    hideGhost();
    setDragTip(null);
    if (!keep) onPreview(null);
    if (d && hostRef.current) hostRef.current.style.cursor = 'default';
  };
  /** 拖拉中的那一筆（放開時送出的也是它）。 */
  const sculptOf = (d: Drag): Sculpt => {
    const br = brushRef.current;
    const local: Local = { center: d.hitVoxel, radius: br.radius, ...(br.radius !== null ? { shape: br.shape } : {}) };
    if (d.mode === 'level') {
      const a = axisOf(d.dir);
      return { kind: 'level', dir: d.dir, to: d.hitVoxel[a] + d.dir[a] * d.n, local };
    }
    return { kind: 'push', dir: d.dir, n: d.n, local };
  };
  /** 拖拉中即時預覽：算得出來就把橘色塊換成真正的結果（虛線框留著）；太大就只畫橘色塊。 */
  const livePreview = (d: Drag) => {
    const c = ctxRef.current;
    if (!c) return;
    const op = d.n || d.mode === 'level' ? toOp(sculptOf(d)) : null;
    const ok = op ? onPreview(op) : (onPreview(null), false);
    if (ok) c.ghostFill.visible = false;
  };

  // 拖拉中按 Esc：丟掉這一次，不清選取（capture 搶在其他 Esc 處理前）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (!dragRef.current && !hdRef.current)) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      lowResRef.current(false);
      if (hdRef.current) {
        cancelHdRaf();
        hdRef.current = null;
        downRef.current = null;
        endDrag(null);
        return;
      }
      endDrag(dragRef.current);
      dragRef.current = null;
      downRef.current = null;
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, []);

  // 網格重畫中游標改成等待
  useEffect(() => {
    if (hostRef.current && (meshing || busy)) hostRef.current.style.cursor = 'progress';
    else if (hostRef.current && hostRef.current.style.cursor === 'progress') hostRef.current.style.cursor = 'default';
  }, [meshing, busy]);

  const hoverAt = useRef(0);

  /** 點選：同一處短時間內再點＝沿射線選下一個；點背景延後清選取（雙擊回全貌不該順便清掉）。 */
  const pick = (e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const mode = selectModeOf(e);
    const h = hit(e.clientX, e.clientY);
    if (h?.onCap) {
      onPick(h.p, mode);
      return;
    }
    const along = hitsAlong(e.clientX, e.clientY);
    const keys = along.map((a) => a.key);
    const now = performance.now();
    const prev = lastClick.current;
    let i = 0;
    if (
      along.length > 1 &&
      prev &&
      now - prev.at < RECLICK_MS &&
      Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < RECLICK_PX &&
      prev.along.join('|') === keys.join('|')
    )
      i = (prev.i + 1) % along.length;
    lastClick.current = { x: e.clientX, y: e.clientY, at: now, along: keys, i };
    if (along.length) {
      onPick(along[i].p, mode);
      return;
    }
    if (h) {
      onPick(h.p, mode);
      return;
    }
    if (mode !== 'set') return;
    if (bgTimer.current) clearTimeout(bgTimer.current);
    bgTimer.current = setTimeout(() => {
      bgTimer.current = null;
      onPick(null, 'set');
    }, 250);
  };

  /** 1 格法線、1 格切線投影到螢幕的像素位移（判斷正對面、估每格像素）。 */
  const screenVectors = (point: Vec3, n: Vec3) => {
    const c = ctxRef.current!;
    const r = hostRef.current!.getBoundingClientRect();
    const screen = (v: Vector3) => {
      const q = c.mesh.localToWorld(v).project(c.camera);
      return [((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height];
    };
    const a = screen(new Vector3(...point));
    const b = screen(new Vector3(point[0] + n[0], point[1] + n[1], point[2] + n[2]));
    const [tu] = tangents(n);
    const t = screen(new Vector3(point[0] + tu[0], point[1] + tu[1], point[2] + tu[2]));
    return { vx: b[0] - a[0], vy: b[1] - a[1], pxPerVoxel: Math.max(1, Math.hypot(t[0] - a[0], t[1] - a[1])) };
  };
  const coordsOf = (p: number): Vec3 => {
    const x = p % vol.X;
    const y = ((p - x) / vol.X) % vol.Y;
    return [x, y, (p - x - y * vol.X) / (vol.X * vol.Y)];
  };
  const clearHover = () => {
    showRing(null, null);
    showHoverBox(null);
    setHoverTag(null);
    onHover(null);
  };

  // 按下（capture 階段的原生事件，見掛載時的註解）：決定是點選、轉視角還是筆刷
  downHandler.current = (e: PointerEvent) => {
    const c = ctxRef.current;
    const host = hostRef.current;
    if (!c || !host) return;
    if ((e.target as Element | null)?.closest?.('.gizmo')) return;
    if (e.button === 2) {
      downRef.current = { x: e.clientX, y: e.clientY, button: 2 };
      return;
    }
    if (e.button !== 0) return;
    downRef.current = { x: e.clientX, y: e.clientY, button: 0 };
    // 不是編輯就是轉視角：旋轉中心先放到游標下（plan v10 §4.1）
    const rotate = () => camRef.current?.pivotAt(e.clientX, e.clientY);
    // 瀏覽（不在聚焦編輯）、Alt、計算中、重畫中、看改前：一律轉視角（還是可以點選）
    const t = toolRef.current;
    if (!t || e.altKey || busyRef.current || meshingRef.current || mode === 'orig') return rotate();
    if (t === 'handles') {
      // 按在把手上才是編輯（plan v10 §4.5）；其他地方一律轉視角
      const hh = handleAt(e.clientX, e.clientY);
      if (!hh) return rotate();
      const bb = bboxRef.current;
      const ext = bb ? [bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1, bb.z1 - bb.z0 + 1] : [32, 32, 32];
      let sv: { vx: number; vy: number; pxPerVoxel: number };
      let max: number;
      if (hh.kind === 'face') {
        sv = screenVectors(hh.pos, hh.dir);
        const ax = axisOf(hh.dir);
        max = Math.min([vol.X, vol.Y, vol.Z][ax], Math.max(32, ext[ax]));
      } else {
        sv = screenVectors(hh.pos, hh.inward);
        const [ua, va] = cornerAxis === 'z' ? [0, 1] : cornerAxis === 'y' ? [0, 2] : [2, 1];
        max = Math.max(1, Math.floor(Math.min(ext[ua], ext[va]) / 2));
      }
      hdRef.current = { h: hh, sx: e.clientX, sy: e.clientY, vx: sv.vx, vy: sv.vy, ppv: sv.pxPerVoxel, max, v: 0, armed: false };
      hdSent.current = 0;
      c.controls.enabled = false;
      setHoverTag(null);
      setDragTip({ text: handleTip(hh, 0), ...tipPos(e.clientX, e.clientY) });
      host.setPointerCapture(e.pointerId);
      kick();
      return;
    }
    const h = hitSel(e.clientX, e.clientY);
    if (!h || h.onCap || !selRef.current?.[h.p]) return rotate();
        // 按在已選結構的面上：準備筆刷；拖過死區才算拖拉
        const { vx, vy, pxPerVoxel } = screenVectors(h.point, h.n);
        const ax = axisOf(h.n);
        const bb = bboxRef.current;
        const extent = bb ? [bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1, bb.z1 - bb.z0 + 1][ax] : 0;
        const maxN = Math.min([vol.X, vol.Y, vol.Z][ax], Math.max(32, extent));
        const d: Drag = {
          p: h.p,
          dir: h.n,
          sx: e.clientX,
          sy: e.clientY,
          vx,
          vy,
          n: 0,
          maxN,
          armed: false,
          headOn: Math.hypot(vx, vy) < HEAD_ON_PX,
          pxPerVoxel,
          hitVoxel: coordsOf(h.p),
          mode: brushRef.current.mode,
        };
    dragRef.current = d;
    // 先關掉 controls，OrbitControls 的 pointerdown 就會直接略過這一下
    c.controls.enabled = false;
    c.ring.visible = c.arrow.visible = false;
    setHoverTag(null);
    if (d.mode === 'level') {
      showGhost(d);
      livePreview(d);
    }
    setDragTip({ text: tipOf(d), ...tipPos(e.clientX, e.clientY) });
    host.setPointerCapture(e.pointerId);
  };

  return (
    <div
      ref={hostRef}
      className="view3d"
      onPointerMove={(e) => {
        const hd = hdRef.current;
        if (hd) {
          if (!hd.armed) {
            if (Math.hypot(e.clientX - hd.sx, e.clientY - hd.sy) < DRAG_DEAD_ZONE / 2) return;
            hd.armed = true;
            lowResRef.current(true);
          }
          const dx = e.clientX - hd.sx;
          const dy = e.clientY - hd.sy;
          const v = hd.h.kind === 'face' ? faceSteps(dx, dy, hd.vx, hd.vy, hd.ppv, hd.max) : cornerRadius(dx, dy, hd.vx, hd.vy, hd.max);
          if (v !== hd.v) {
            hd.v = v;
            if (!hdRaf.current)
              hdRaf.current = requestAnimationFrame(() => {
                hdRaf.current = 0;
                const cur = hdRef.current;
                if (!cur || cur.v === hdSent.current) return;
                hdSent.current = cur.v;
                const op = handleOpOf(cur);
                if (op) onPreview(op);
                else onPreview(null);
              });
          }
          setDragTip({ text: handleTip(hd.h, hd.v), ...tipPos(e.clientX, e.clientY) });
          return;
        }
        const d = dragRef.current;
        if (d) {
          if (!d.armed) {
            if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_DEAD_ZONE) return;
            d.armed = true;
            lowResRef.current(true);
          }
          const n = stepsOf(d, e.clientX, e.clientY);
          if (n !== d.n) {
            d.n = n;
            if (d.n || d.mode === 'level') showGhost(d);
            else hideGhost();
            livePreview(d);
          }
          setDragTip({ text: tipOf(d), ...tipPos(e.clientX, e.clientY) });
          return;
        }
        if (downRef.current) return;
        const now = performance.now();
        if (now - hoverAt.current < 80) return;
        hoverAt.current = now;
        const host = hostRef.current!;
        if (mode === 'orig' || meshingRef.current || busyRef.current) {
          clearHover();
          return;
        }
        const pos = tipPos(e.clientX, e.clientY);
        // 把手模式：滑到把手上亮起、游標變抓手
        if (toolRef.current === 'handles') {
          const hh = handleAt(e.clientX, e.clientY);
          if (hh !== hoverHandle.current) {
            hoverHandle.current = hh;
            kick();
          }
          if (hh) {
            showRing(null, null);
            showHoverBox(null);
            host.style.cursor = 'grab';
            setHoverTag({ text: hh.kind === 'face' ? `拖＝${directionName(hh.dir)}長／縮` : '拖＝圓角半徑，點一下調參數', ...pos });
            onHover(hh.kind === 'face' ? `面把手：沿箭頭拖＝${directionName(hh.dir)}整面長／縮，拖的時候就看得到結果，放開套用；Esc 取消` : '角把手：往內拖＝圓角半徑；點一下開圓頭面板調方圓度、不對稱、凹角');
            return;
          }
        }
        const h = toolRef.current === 'brush' ? hitSel(e.clientX, e.clientY) : hit(e.clientX, e.clientY);
        const br = brushRef.current;
        const onSel = toolRef.current === 'brush' && !!h && !h.onCap && !!selRef.current?.[h.p];
        if (onSel) {
          showRing(coordsOf(h.p), h.n);
          showHoverBox(null);
          const who = br.radius === null ? '整面' : `筆刷 ${br.shape === 'square' ? '方' : '圓'} r${br.radius}`;
          const dirName = directionName(h.n);
          if (br.mode === 'level') {
            host.style.cursor = 'crosshair';
            setHoverTag({ text: `點一下：圈內方頭到這面（${dirName}）`, ...pos });
            onHover(`局部方頭（${who}）：點一下把圈內補到這一面；按住再拖可以多 ±n 格；轉視角在別處拖`);
          } else {
            const { vx, vy } = screenVectors(h.point, h.n);
            host.style.cursor = Math.hypot(vx, vy) < HEAD_ON_PX || Math.abs(vy) >= Math.abs(vx) ? 'ns-resize' : 'ew-resize';
            setHoverTag({ text: `拖：${dirName}長／縮`, ...pos });
            onHover(`局部長／縮（${who}）：按住${dirName}拉＝長、往回推＝縮，放開套用（拖的時候就看得到結果），Esc 取消；轉視角在別處拖`);
          }
          return;
        }
        showRing(null, null);
        const comp = h ? compAt(h.p) : null;
        const selected = !!h && !h.onCap && !!selRef.current?.[h.p];
        showHoverBox(comp && !h?.onCap ? comp.bbox : null);
        host.style.cursor = comp && !selected ? 'pointer' : 'default';
        setHoverTag(comp && !selected ? { text: comp.label, ...pos } : null);
        onHover(
          comp
            ? h?.onCap
              ? `剖面：點一下選取 ${comp.label}`
              : selected
                ? toolRef.current
                  ? `${comp.label}：拖箭頭＝整面長縮、拖角＝圓頭；其他地方拖＝轉視角`
                  : `${comp.label}：按 E（或雙擊）進入聚焦編輯；現在拖拉只轉視角`
                : `點一下選取 ${comp.label}；同一處再點一次＝選它後面的結構；Shift 多選`
            : null,
        );
      }}
      onPointerUp={(e) => {
        const c = ctxRef.current;
        const d = dragRef.current;
        const down = downRef.current;
        const hd = hdRef.current;
        // 拖把手／拖筆刷結束：恢復靜止時的 pixelRatio（沒降過就什麼都不做）
        lowResRef.current(false);
        dragRef.current = null;
        downRef.current = null;
        hdRef.current = null;
        if (hd && c) {
          // 還沒算的那一幀不必算了：放開直接用最後的 v 產生 Op（等於 flush）
          cancelHdRaf();
          hdSent.current = null;
          c.controls.enabled = true;
          setDragTip(null);
          kick();
          const op = hd.armed ? handleOpOf(hd) : null;
          if (op) {
            // 預覽留著等正式結果
            onCommit?.(op);
            return;
          }
          onPreview(null);
          if (!hd.armed && hd.h.kind === 'corner') {
            const r = e.currentTarget.getBoundingClientRect();
            onCornerClick?.(hd.h.id, e.clientX - r.left, e.clientY - r.top);
          }
          return;
        }
        if (!c || !down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        if (down.button === 2) {
          // 右鍵拖＝平移；沒拖才開選單
          if (moved < 4) {
            const r = e.currentTarget.getBoundingClientRect();
            const h = hitSel(e.clientX, e.clientY);
            onMenu({ voxel: h?.p ?? null, along: hitsAlong(e.clientX, e.clientY).map((a) => a.key), n: h && !h.onCap ? h.n : null }, e.clientX - r.left, e.clientY - r.top);
          }
          return;
        }
        if (e.button !== 0) return;
        if (d) {
          // 局部方頭：點一下就套用到那一面（拖過的話再加減 n 格）；局部長／縮：拖過死區且 n ≠ 0 才套用
          const apply = d.mode === 'level' || (d.armed && d.n !== 0);
          endDrag(d, apply);
          if (apply) {
            onSculpt(sculptOf(d));
            return;
          }
          if (d.armed) return;
          pick(e);
          return;
        }
        if (moved > 4) return;
        pick(e);
      }}
      onDoubleClick={(e) => {
        const c = ctxRef.current;
        if (!c) return;
        if (bgTimer.current) {
          clearTimeout(bgTimer.current);
          bgTimer.current = null;
        }
        const h = hit(e.clientX, e.clientY);
        // 雙擊已選的結構（還沒聚焦）：進入聚焦編輯；雙擊模型：對準點到的地方（有動畫）；雙擊空白：回全貌
        if (h && !toolRef.current && !h.onCap && selRef.current?.[h.p] && onFocusSel) onFocusSel();
        else if (h) camRef.current?.lookAtPoint(h.world);
        else handle.current?.setView('home');
      }}
      onPointerLeave={() => {
        if (!dragRef.current) clearHover();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg
        ref={gizmoRef}
        className="gizmo"
        width="72"
        height="72"
        viewBox="0 0 72 72"
        aria-hidden="true"
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {(['x', 'y', 'z'] as Axis[]).map((a) => (
          <g key={a} onClick={() => handle.current?.setView(a === 'z' ? 'front' : a === 'y' ? 'top' : 'side')} style={{ cursor: 'pointer' }}>
            <line data-axis-line={a} x1={36} y1={36} x2={36} y2={36} stroke={AXIS_RGB[a]} strokeWidth={2} strokeLinecap="round" />
            <text data-axis-text={a} x={36} y={36} fill={AXIS_RGB[a]} fontSize={10} fontWeight={600} textAnchor="middle">
              {a}
            </text>
          </g>
        ))}
      </svg>
      {dragTip ? (
        <div className="drag-tip" style={{ left: dragTip.x, top: dragTip.y }}>
          {dragTip.text}
        </div>
      ) : hoverTag ? (
        <div className="hover-tag" style={{ left: hoverTag.x, top: hoverTag.y }}>
          {hoverTag.text}
        </div>
      ) : null}
      {(meshing || busy) && <div className="mesh-busy" role="status">{busy ? '計算中…' : '更新 3D 中…'}</div>}
    </div>
  );
}

/**
 * 切面：XY 正面（axis z）、XZ 上視（axis y）、YZ 側面（axis x）。
 * ImageData 逐像素填色；差異只描邊；z 套用範圍畫藍色虛線框。
 */
export function SliceView({
  vol,
  axis,
  at,
  materials,
  hidden,
  selMask,
  cursor,
  scope,
  diff,
  preview,
  onPick,
  onStep,
  onHover,
  box,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  materials: Material[];
  hidden: Set<number>;
  selMask: Uint8Array | null;
  /** 只看切面上這一塊（含端點；並排比較自動放大到差異外框，plan v11 §4.4）；省略＝整片。 */
  box?: { u0: number; v0: number; u1: number; v1: number } | null;
  cursor: Vec3;
  /** 範圍；沿別的軸時在切面上畫藍色虛線框（null = 不畫）。 */
  scope: Scope | null;
  diff: Uint8Array | null;
  /** 即時預覽蓋在切面上（index 只在它根據的陣列還是這份時才傳）。 */
  preview?: Preview | null;
  onPick: (p: Vec3, mode: SelectMode) => void;
  onStep: (delta: number) => void;
  onHover?: (p: Vec3 | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
  const rgb = useMemo(() => {
    const m = new Map<number, Vec3>();
    materials.forEach((x) => m.set(x.id, hexToRgb(x.color)));
    return m;
  }, [materials]);
  const toVoxel = (u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]);

  // 底圖不看預覽（plan v9 P9）：拖拉中只重畫預覽層那一塊
  useEffect(() => {
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff, null);
  }, [vol, axis, at, rgb, hidden, selMask, diff, W, H]);

  const [cu, cv] = axis === 'z' ? [cursor[0], cursor[1]] : axis === 'y' ? [cursor[0], cursor[2]] : [cursor[2], cursor[1]];
  const imgRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: W, h: H });
  const bu0 = box?.u0 ?? 0;
  const bv0 = box?.v0 ?? 0;
  const BW = box ? box.u1 - box.u0 + 1 : W;
  const BH = box ? box.v1 - box.v0 + 1 : H;

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const s = Math.min(e.contentRect.width / BW, e.contentRect.height / BH);
      setSize({ w: Math.floor(BW * s), h: Math.floor(BH * s) });
    });
    ro.observe(fitRef.current!);
    return () => ro.disconnect();
  }, [BW, BH]);

  useEffect(() => {
    const el = imgRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      onStep(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onStep]);

  const uvOf = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const u = Math.floor(bu0 + ((e.clientX - r.left) / r.width) * BW);
    const v = Math.floor(bv0 + ((e.clientY - r.top) / r.height) * BH);
    return u >= 0 && v >= 0 && u < W && v < H ? toVoxel(u, v) : null;
  };

  const partial = !!scope && scope.axis !== axis && (scope.lo > 0 || scope.hi < axisLen(vol, scope.axis) - 1);
  const z0 = scope?.lo ?? 0;
  const z1 = (scope?.hi ?? 0) + 1;
  // scope 的軸在切面上是橫的（u）還是直的（v）
  const vertical = !!scope && (axis === 'y' ? scope.axis === 'z' : axis === 'z' ? scope.axis === 'y' : scope.axis === 'y');
  const frame = { fill: 'var(--c-primary)', fillOpacity: 0.08, stroke: 'var(--c-primary)', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' } as const;

  return (
    <div className="slice-fit" ref={fitRef}>
      <div
        className="slice-img"
        ref={imgRef}
        style={{ width: size.w, height: size.h, ...(box ? { overflow: 'hidden' } : {}) }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = uvOf(e);
          if (p) onPick(p, selectModeOf(e));
        }}
        onPointerMove={(e) => onHover?.(uvOf(e))}
        onPointerLeave={() => onHover?.(null)}
      >
        <div style={box ? { position: 'absolute', width: `${(W / BW) * 100}%`, height: `${(H / BH) * 100}%`, left: `${(-bu0 / BW) * 100}%`, top: `${(-bv0 / BH) * 100}%` } : { position: 'absolute', inset: 0 }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block' }} />
        <SlicePreviewLayer vol={vol} axis={axis} at={at} W={W} H={H} preview={preview} selMask={selMask} rgb={rgb} hidden={hidden} />
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          {partial &&
            (vertical ? (
              <rect x={0} y={z0} width={W} height={z1 - z0} {...frame} />
            ) : (
              <rect x={z0} y={0} width={z1 - z0} height={H} {...frame} />
            ))}
          <line x1={cu + 0.5} y1={0} x2={cu + 0.5} y2={H} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={cv + 0.5} x2={W} y2={cv + 0.5} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
        </div>
      </div>
    </div>
  );
}
