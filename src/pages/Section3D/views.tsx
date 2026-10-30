import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DirectionalLight,
  DoubleSide,
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
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import {
  type Axis,
  type BBox,
  type Material,
  type MeshData,
  type Vec3,
  type Volume,
  type ZRange,
  DIFF_BIT,
  VOID,
  directionName,
  greedyMesh,
  hexToRgb,
  idx,
  voxelFromHit,
} from '../../volume/volume';
import { call, ensure, sidOf } from '../../volume/client';
import type { EditState, Local, Op } from '../../volume/ops';
import type { Preview } from '../../volume/preview';
import { type Brush, type Sculpt, type SelectMode, selectModeOf } from './editor';

export type { Sculpt } from './editor';

const SEL_RGB: Vec3 = [22, 119, 255];
/** 選取層沿法線外推的量：固定值，相機再遠也不會和主網格共面閃爍。 */
const INFLATE = 0.03;
/** 筆刷圈、法線箭頭、拖拉預覽共用的顏色（和十字的淡橘區分）。 */
const BRUSH_COLOR = 0xfa541c;
/** 按下後要先拖過這麼多像素才算拖拉，否則一律當點選（避免手抖就改到體素）。 */
const DRAG_DEAD_ZONE = 8;
/** 法線在螢幕上短於這麼多像素＝正對著面看，改用垂直位移估算格數。 */
const HEAD_ON_PX = 4;
/** 同一個位置再點一次（時間、距離內）＝沿射線選下一個結構。 */
const RECLICK_MS = 1500;
const RECLICK_PX = 6;
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
}

/** 右鍵選單用：點到的體素，以及沿射線往裡面還有哪些結構（key）。 */
export interface MenuHit {
  voxel: number | null;
  along: string[];
}

interface Ctx {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  ghostMesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  changedEdges: LineSegments<BufferGeometry, LineBasicMaterial>;
  selFill: Mesh<BufferGeometry, MeshLambertMaterial>;
  voidMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  voidEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
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

const palette = (materials: Material[]) => {
  const out = new Float32Array(768);
  materials.forEach((m) => {
    const [r, g, b] = hexToRgb(m.color);
    out.set([r / 255, g / 255, b / 255], m.id * 3);
  });
  return out;
};
const hiddenTable = (hidden: Set<number>) => {
  const out = new Uint8Array(256);
  hidden.forEach((m) => (out[m] = 1));
  return out;
};
const toGeometry = (m: MeshData) => {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3));
  g.setAttribute('color', new BufferAttribute(m.colors, 3));
  g.computeBoundingSphere();
  return g;
};
/** 最近幾個主網格（依狀態、隱藏、標紅、配色）：復原、看原始、切 split 時不必重算。 */
const meshCache = new Map<string, unknown>();
const MESH_CACHE_SIZE = 6;
const cached = async <T,>(key: string, make: () => Promise<T>): Promise<T> => {
  const hit = meshCache.get(key);
  if (hit) {
    meshCache.delete(key);
    meshCache.set(key, hit);
    return hit as T;
  }
  const m = await make();
  meshCache.set(key, m);
  if (meshCache.size > MESH_CACHE_SIZE) meshCache.delete(meshCache.keys().next().value!);
  return m;
};

const boxEdges = (b: BBox) => new EdgesGeometry(new BoxGeometry(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1));
const axisOf = (d: Vec3) => (d[0] ? 0 : d[1] ? 1 : 2);
const AXIS_RGB: Record<Axis, string> = { x: '#e5484d', y: '#30a46c', z: '#3e63dd' };
/** 挖洞的邊界多留一點點，剛好落在範圍邊界平面上的面也挖掉（預覽網格會重畫它們）。 */
const HOLE_EPS = 1e-3;

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

/** 收掉即時預覽：預覽網格藏起來、主網格不再挖洞。 */
const hidePreview = (c: Ctx) => {
  c.previewMesh.visible = false;
  c.hole.min.value.set(1, 1, 1);
  c.hole.max.value.set(0, 0, 0);
};

/** 預覽裡的體素值：在裁切範圍內取預覽結果，否則取原本的陣列。 */
const patched = (vol: Volume, p: Preview | null | undefined, x: number, y: number, z: number) => {
  if (p) {
    const b = p.box;
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && z >= b.z0 && z <= b.z1)
      return p.data[((z - b.z0) * (b.y1 - b.y0 + 1) + (y - b.y0)) * (b.x1 - b.x0 + 1) + (x - b.x0)];
  }
  return vol.data[idx(vol, x, y, z)];
};

/**
 * 把一個切面畫到 canvas：材質顏色、隱藏材質淡灰、選取混藍、差異描紅邊；patch = 即時預覽蓋上去。
 * 下方切面與 3D 剖面貼圖共用，所以兩邊逐像素相同。
 */
export function drawSlice(
  cv: HTMLCanvasElement,
  vol: Volume,
  axis: Axis,
  at: number,
  rgb: Map<number, Vec3>,
  hidden: Set<number>,
  selMask: Uint8Array | null,
  diff: Uint8Array | null,
  patch?: Preview | null,
) {
  const [W, H] = axis === 'z' ? [vol.X, vol.Y] : axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
  cv.width = W;
  cv.height = H;
  const toVoxel = (u: number, v: number): Vec3 => (axis === 'z' ? [u, v, at] : axis === 'y' ? [u, at, v] : [at, v, u]);
  const img = new ImageData(W, H);
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const [x, y, z] = toVoxel(u, v);
      const i = idx(vol, x, y, z);
      const m = patched(vol, patch, x, y, z);
      const c = hidden.has(m) ? [245, 245, 245] : (rgb.get(m) ?? [255, 0, 255]);
      const o = (v * W + u) * 4;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
      img.data[o + 3] = 255;
      if (selMask?.[i]) {
        img.data[o] = (img.data[o] + SEL_RGB[0]) >> 1;
        img.data[o + 1] = (img.data[o + 1] + SEL_RGB[1]) >> 1;
        img.data[o + 2] = (img.data[o + 2] + SEL_RGB[2]) >> 1;
      }
    }
  const g = cv.getContext('2d')!;
  g.putImageData(img, 0, 0);
  if (diff) {
    g.fillStyle = '#ff4d4f';
    const on = (u: number, v: number) => {
      const [x, y, z] = toVoxel(u, v);
      return diff[idx(vol, x, y, z)];
    };
    for (let v = 0; v < H; v++)
      for (let u = 0; u < W; u++) {
        if (!on(u, v)) continue;
        const edge = [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ].some(([du, dv]) => {
          const nu = u + du;
          const nv = v + dv;
          return nu < 0 || nv < 0 || nu >= W || nv >= H || !on(nu, nv);
        });
        if (edge) g.fillRect(u, v, 1, 1);
      }
  }
}

/**
 * 3D：Worker 做 greedy mesh（同材質同朝向的面合併成大矩形），改過的體素混紅；
 * 選取半透明網格（沿法線外推 0.03 避免共面）＋bbox 線框、橘色十字、剖面（三軸、剖口貼真正的切面圖）。
 * 滑鼠拖拉只做筆刷雕刻：按住已選結構的面沿法線拖＝局部長／縮；補平模式點一下＝補到那一面。
 * 整面長縮、整塊移動都在右欄輸入。差異模式：沒改的半透明灰、改過的實色、拿掉的紅。
 * 體素 y 向下，所以網格 scale y = −1 再平移，讓畫面上方 = y 索引小。
 */
export function View3D({
  state,
  materials,
  hidden,
  selMask,
  selComps,
  zRange,
  selBBox,
  cursor,
  clip,
  showDiff,
  diffMask,
  mode,
  brush,
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
  zRange: ZRange;
  selBBox: BBox | null;
  cursor: Vec3;
  clip: Clip | null;
  /** 改過的體素混紅（和原始比，Worker 算）。 */
  showDiff: boolean;
  /** 差異 mask（剖面貼圖描紅邊用）。 */
  diffMask: Uint8Array | null;
  mode: ViewMode;
  brush: Brush;
  nmPerVoxel: number;
  /** 原始陣列（預覽裡改過的體素混紅用）。 */
  orig: Volume | null;
  /** 即時預覽（主執行緒裁切重算的結果，base = 它根據的陣列）；null = 沒有。網格在這裡畫，正式網格到了就收掉。 */
  preview: (Preview & { base: Uint8Array }) | null;
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
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.localClippingEnabled = true;
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
    // 中鍵也能轉視角：選取的結構佔滿畫面時，左鍵是筆刷，還有中鍵（或 Alt＋左鍵）可以轉
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.ROTATE, RIGHT: MOUSE.PAN };
    // 滾輪朝游標縮放；不能縮到模型裡面、也不能退到看不見
    controls.zoomToCursor = true;
    controls.minDistance = size * 0.08;
    controls.maxDistance = size * 8;
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
      if (!mesh.geometry.attributes.position) return false;
      const dir = target.clone().sub(pos);
      const dist = dir.length();
      probe.set(pos, dir.normalize());
      probe.firstHitOnly = true;
      const h = probe.intersectObject(mesh, false)[0];
      return !!h && h.distance < dist - radius;
    };
    const setView = (preset: ViewPreset) => {
      const b = bboxRef.current;
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
            ? new Vector3(0, 1, 0.0005).normalize()
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
    scene.add(new AmbientLight(0xffffff, 0.8));
    const key = new DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.3);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);
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
    const previewMesh = voxelSpace(new Mesh(new BufferGeometry(), new MeshLambertMaterial(mainParams)));
    previewMesh.visible = false;
    const ghostMesh = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false, side: DoubleSide })),
      1,
    );
    ghostMesh.raycast = acceleratedRaycast;
    // 差異模式：改過的部分描紅邊，和半透明的「沒改」分開
    const changedEdges = voxelSpace(new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xff4d4f })), 2);
    changedEdges.visible = false;
    const selFill = voxelSpace(
      new Mesh(new BufferGeometry(), withHole(new MeshLambertMaterial({ color: 0x1677ff, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide }), hole)),
      2,
    );
    const voidMesh = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: 0x262626, transparent: true, opacity: 0.8, depthTest: false, side: DoubleSide })),
      3,
    );
    const voidEdges = voxelSpace(
      new LineSegments(new EdgesGeometry(), new LineBasicMaterial({ color: 0xff7875, depthTest: false, transparent: true, opacity: 0.75 })),
      4,
    );
    const ring = voxelSpace(new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: BRUSH_COLOR, depthTest: false, linewidth: 2 })), 5);
    // 法線箭頭：往外＝長、往內＝縮，按下前就知道會往哪推
    const arrow = voxelSpace(new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: BRUSH_COLOR, depthTest: false })), 5);
    selFill.visible = voidMesh.visible = voidEdges.visible = ghostMesh.visible = ring.visible = arrow.visible = false;
    const selBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x1677ff }));
    selBox.visible = false;
    scene.add(selBox);
    // 滑過未選取的結構：細灰框
    const hoverBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x595959, transparent: true, opacity: 0.8 }));
    hoverBox.visible = false;
    scene.add(hoverBox);
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
    ctxRef.current = { renderer, scene, camera, controls, mesh, ghostMesh, changedEdges, selFill, voidMesh, voidEdges, selBox, hoverBox, previewMesh, hole, ghost, ghostFill, ring, arrow, cross, cap, capEdges };
    // 按下要在 OrbitControls（掛在 canvas 上）之前決定是不是筆刷：capture 階段先跑，筆刷就先把 controls 關掉，
    // OrbitControls 連這一下都不會記到。之前是 React 的 onPointerDown 事後才關，OrbitControls 已經記了一個指標、
    // 又因為指標被我們捕捉而收不到放開，之後滾輪縮放就一直沒反應（視角像被鎖住）。
    const onDown = (e: PointerEvent) => downHandler.current?.(e);
    host.addEventListener('pointerdown', onDown, { capture: true });
    let flashTimer: ReturnType<typeof setTimeout>[] = [];
    const flash = () => {
      flashTimer.forEach(clearTimeout);
      flashTimer = [];
      const m = selBox.material;
      const on = () => m.color.setHex(BRUSH_COLOR);
      const off = () => m.color.setHex(0x1677ff);
      if (reducedMotion()) return;
      [0, 300, 600].forEach((t) => {
        flashTimer.push(setTimeout(on, t));
        flashTimer.push(setTimeout(off, t + 150));
      });
    };

    const recolor = (mask: Uint8Array, color: Vec3) => {
      const g = mesh.geometry;
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
    };
    handle.current = { setView, recolor, flash };

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    // 小標籤與座標軸小圖在 render loop 裡投影定位，不走 React 狀態
    const p = new Vector3();
    const q = camera.quaternion.clone();
    const axes: [Axis, Vector3][] = [
      ['x', new Vector3(1, 0, 0)],
      ['y', new Vector3(0, -1, 0)],
      ['z', new Vector3(0, 0, 1)],
    ];
    let raf = 0;
    const tick = () => {
      if (anim) {
        const k = Math.min(1, (performance.now() - anim.start) / anim.ms);
        const e = 1 - (1 - k) * (1 - k) * (1 - k);
        camera.position.lerpVectors(anim.p0, anim.p1, e);
        controls.target.lerpVectors(anim.t0, anim.t1, e);
        if (k >= 1) anim = null;
      }
      controls.update();
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
          const tw = tag.offsetWidth || 300;
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
      flashTimer.forEach(clearTimeout);
      ro.disconnect();
      host.removeEventListener('pointerdown', onDown, { capture: true });
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments || o instanceof LineLoop) {
          o.geometry.dispose();
          (o.material as { dispose: () => void }).dispose();
        }
      });
      cap.material.map?.dispose();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [vol.X, vol.Y, vol.Z]);

  // 主網格（Worker greedy mesh）；差異模式另外要一層半透明的「沒改」；只採用最新一次請求的結果
  const meshSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++meshSeq.current;
    setMeshing(true);
    const base = [sidOf(state.vol.data), [...hidden].sort().join(','), materials.map((m) => m.color).join('')].join('|');
    const swap = (m: MeshData) => {
      const g = toGeometry(m);
      if (m.quads) g.boundsTree = new MeshBVH(g);
      c.mesh.geometry.dispose();
      c.mesh.geometry = g;
      // 正式網格到了，預覽收掉
      hidePreview(c);
    };
    const req =
      mode === 'diff'
        ? cached(`diff|${base}`, () => call('diffMesh', { sid: ensure(state), hidden: hiddenTable(hidden), palette: palette(materials) })).then((r) => {
            if (seq !== meshSeq.current || !ctxRef.current) return;
            swap(r.changed);
            const g = toGeometry(r.ghost);
            if (r.ghost.quads) g.boundsTree = new MeshBVH(g);
            c.ghostMesh.geometry.dispose();
            c.ghostMesh.geometry = g;
            c.ghostMesh.visible = true;
            // 改動很大時描邊太貴（EdgesGeometry 是 O(n log n)），就只靠實色
            c.changedEdges.geometry.dispose();
            c.changedEdges.geometry = r.changed.quads > 0 && r.changed.quads < 60000 ? new EdgesGeometry(c.mesh.geometry, 1) : new BufferGeometry();
            c.changedEdges.visible = true;
          })
        : cached(`main|${base}|${showDiff}`, () =>
            call('mesh', { sid: ensure(state), hidden: hiddenTable(hidden), diff: showDiff, palette: palette(materials) }),
          ).then((m) => {
            if (seq !== meshSeq.current || !ctxRef.current) return;
            swap(m);
            c.ghostMesh.visible = false;
            c.changedEdges.visible = false;
          });
    req.then(() => setMeshing(false)).catch(() => setMeshing(false));
  }, [state, materials, hidden, showDiff, mode]);

  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    for (const mat of [c.mesh.material, c.previewMesh.material]) {
      mat.transparent = translucent;
      mat.opacity = translucent ? 0.3 : 1;
      mat.depthWrite = !translucent;
      mat.needsUpdate = true;
    }
  }, [translucent]);

  // 即時預覽：裁切範圍（外加一圈鄰居）在主執行緒 greedy mesh，主網格同一範圍挖掉；正式網格 swap 時收掉
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    if (!preview || preview.base !== state.vol.data || mode === 'diff') {
      hidePreview(c);
      return;
    }
    const b = preview.box;
    const bx = b.x1 - b.x0 + 1;
    const by = b.y1 - b.y0 + 1;
    const bz = b.z1 - b.z0 + 1;
    const hx = bx + 2;
    const hy = by + 2;
    const hz = bz + 2;
    const codes = new Uint16Array(hx * hy * hz);
    const o = origRef.current;
    for (let z = 0; z < hz; z++) {
      const vz = b.z0 - 1 + z;
      if (vz < 0 || vz >= vol.Z) continue;
      for (let y = 0; y < hy; y++) {
        const vy = b.y0 - 1 + y;
        if (vy < 0 || vy >= vol.Y) continue;
        for (let x = 0; x < hx; x++) {
          const vx = b.x0 - 1 + x;
          if (vx < 0 || vx >= vol.X) continue;
          const i = (vz * vol.Y + vy) * vol.X + vx;
          const inside = x >= 1 && x <= bx && y >= 1 && y <= by && z >= 1 && z <= bz;
          const m = inside ? preview.data[((z - 1) * by + (y - 1)) * bx + (x - 1)] : vol.data[i];
          if (!m || hidden.has(m)) continue;
          codes[(z * hy + y) * hx + x] = showDiff && o && o.data[i] !== m ? m | DIFF_BIT : m;
        }
      }
    }
    const m = greedyMesh(hx, hy, hz, codes, (code) => {
      const [r, g, bl] = rgb.get(code & 255) ?? [255, 0, 255];
      return code & DIFF_BIT ? [(r / 255) * 0.35 + 0.65, (g / 255) * 0.35 + 0.2, (bl / 255) * 0.35 + 0.2] : [r / 255, g / 255, bl / 255];
    });
    // 只留重心落在裁切範圍（含邊界面）裡的三角形：外圈鄰居之間的面與外圈最外面的面主網格本來就有
    const keep: number[] = [];
    for (let t = 0; t < m.positions.length; t += 9) {
      const cx = (m.positions[t] + m.positions[t + 3] + m.positions[t + 6]) / 3;
      const cy = (m.positions[t + 1] + m.positions[t + 4] + m.positions[t + 7]) / 3;
      const cz = (m.positions[t + 2] + m.positions[t + 5] + m.positions[t + 8]) / 3;
      if (cx >= 1 - HOLE_EPS && cx <= bx + 1 + HOLE_EPS && cy >= 1 - HOLE_EPS && cy <= by + 1 + HOLE_EPS && cz >= 1 - HOLE_EPS && cz <= bz + 1 + HOLE_EPS) keep.push(t);
    }
    const positions = new Float32Array(keep.length * 9);
    const normals = new Float32Array(keep.length * 9);
    const colors = new Float32Array(keep.length * 9);
    keep.forEach((t, k) => {
      for (let j = 0; j < 9; j++) {
        positions[k * 9 + j] = m.positions[t + j] + [b.x0 - 1, b.y0 - 1, b.z0 - 1][j % 3];
        normals[k * 9 + j] = m.normals[t + j];
        colors[k * 9 + j] = m.colors[t + j];
      }
    });
    c.previewMesh.geometry.dispose();
    c.previewMesh.geometry = toGeometry({ positions, normals, colors, quads: keep.length / 2 });
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
      c.voidMesh.visible = c.voidEdges.visible = false;
    };
    if (!xray || hidden.has(VOID)) return off();
    const only = { mat: VOID };
    call('mesh', { sid: ensure(state), hidden: hiddenTable(hidden), only, palette: palette(materials), tint: [0.15, 0.15, 0.15] }).then((m) => {
      if (seq !== voidSeq.current || !ctxRef.current) return;
      c.voidMesh.geometry.dispose();
      c.voidMesh.geometry = toGeometry(m);
      c.voidEdges.geometry.dispose();
      c.voidEdges.geometry = new EdgesGeometry(c.voidMesh.geometry, 30);
      // 沒有空洞時網格是空的
      c.voidMesh.visible = c.voidEdges.visible = m.quads > 0;
    });
  }, [state, hidden, xray]);

  // 選取：半透明網格（只含 affMask，沿法線外推）＋ bbox 線框；換選取時先藏舊的再等新的
  const selSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++selSeq.current;
    c.selFill.visible = false;
    if (!selComps?.length || !selBBox) {
      c.selBox.visible = false;
      return;
    }
    const b = selBBox;
    c.selBox.geometry.dispose();
    c.selBox.geometry = boxEdges(b);
    c.selBox.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
    c.selBox.visible = true;
    const tint = SEL_RGB.map((v) => v / 255) as Vec3;
    const only = { comps: selComps, zRange, box: b };
    call('mesh', { sid: ensure(state), hidden: hiddenTable(hidden), only, palette: palette(materials), tint, inflate: INFLATE }).then((m) => {
      if (seq !== selSeq.current || !ctxRef.current) return;
      c.selFill.geometry.dispose();
      c.selFill.geometry = toGeometry(m);
      c.selFill.visible = true;
    });
  }, [state, selComps, zRange, selBBox]);

  /** 剖面的世界座標平面；null = 不剖。 */
  const clipPlane = (cl: Clip | null) => {
    if (!cl) return null;
    const { axis, at, side } = cl;
    if (axis === 'z') return side > 0 ? new Plane(new Vector3(0, 0, -1), at + 1) : new Plane(new Vector3(0, 0, 1), -at);
    if (axis === 'x') return side > 0 ? new Plane(new Vector3(-1, 0, 0), at + 1) : new Plane(new Vector3(1, 0, 0), -at);
    return side > 0 ? new Plane(new Vector3(0, 1, 0), -(vol.Y - at - 1)) : new Plane(new Vector3(0, -1, 0), vol.Y - at);
  };

  // 剖面：剪掉一半、剖口貼切面圖
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const plane = clipPlane(clip);
    const planes = plane ? [plane] : [];
    for (const o of [c.mesh, c.previewMesh, c.ghostMesh, c.selFill, c.voidMesh, c.voidEdges]) o.material.clippingPlanes = planes;
    if (!clip) {
      c.cap.visible = c.capEdges.visible = false;
      return;
    }
    const cv = document.createElement('canvas');
    const patch = preview && preview.base === vol.data && mode === 'now' ? preview : null;
    drawSlice(cv, vol, clip.axis, clip.at, rgb, hidden, mode === 'orig' ? null : selMask, mode === 'orig' ? null : diffMask, patch);
    const tex = new CanvasTexture(cv);
    tex.magFilter = NearestFilter;
    tex.minFilter = NearestFilter;
    tex.generateMipmaps = false;
    c.cap.material.map?.dispose();
    c.cap.material.map = tex;
    c.cap.material.needsUpdate = true;
    const [W, H] = clip.axis === 'z' ? [vol.X, vol.Y] : clip.axis === 'y' ? [vol.X, vol.Z] : [vol.Z, vol.Y];
    c.cap.geometry.dispose();
    c.cap.geometry = new PlaneGeometry(W, H);
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
    c.capEdges.geometry.dispose();
    c.capEdges.geometry = new EdgesGeometry(c.cap.geometry);
    c.capEdges.position.copy(c.cap.position);
    c.capEdges.rotation.copy(c.cap.rotation);
    c.cap.visible = c.capEdges.visible = true;
  }, [clip, vol, rgb, hidden, selMask, diffMask, mode, preview]);

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
  /** 可點選的網格：差異模式連半透明的「沒改」也算。 */
  const pickables = () => {
    const c = ctxRef.current!;
    const out: Mesh[] = [];
    if (c.mesh.geometry.attributes.position) out.push(c.mesh);
    if (c.ghostMesh.visible && c.ghostMesh.geometry.attributes.position) out.push(c.ghostMesh);
    return out;
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
    if (!c || !c.mesh.geometry.attributes.position) return null;
    const ray = rayAt(clientX, clientY);
    const cl = clipRef.current;
    const plane = clipPlane(cl);
    // 剖開時要濾掉剖面後面的命中，所以只有沒剖開才只取第一個
    ray.firstHitOnly = !plane;
    const h = ray.intersectObjects(pickables(), false).find((h) => !plane || plane.distanceToPoint(h.point) >= -1e-6);
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
  /** 沿射線由近到遠經過的結構（key 與各自第一個體素），最多 8 個；被擋住的也能選。 */
  const hitsAlong = (clientX: number, clientY: number): { key: string; p: number }[] => {
    const c = ctxRef.current;
    if (!c || !c.mesh.geometry.attributes.position) return [];
    const ray = rayAt(clientX, clientY);
    ray.firstHitOnly = false;
    const plane = clipPlane(clipRef.current);
    const L = state.L;
    const out: { key: string; p: number }[] = [];
    const seen = new Set<string>();
    for (const h of ray.intersectObjects(pickables(), false)) {
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

  /** 筆刷圈：畫在 hit 面上；推拉模式再加一支法線箭頭（往外＝長）。 */
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
      return `${who} 補平到 ${'xyz'[a]} = ${to}${d.n ? `（再${d.n > 0 ? '外' : '內'} ${Math.abs(d.n)} vx，${nm(d.n)}）` : ''}`;
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
      if (e.key !== 'Escape' || !dragRef.current) return;
      e.stopImmediatePropagation();
      e.preventDefault();
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
    // Alt 拖＝只轉視角；筆刷關閉、計算中、重畫中、看原始時不雕刻（還是可以點選）
    if (e.altKey || brushRef.current.mode === 'off' || busyRef.current || meshingRef.current || mode === 'orig') return;
    const h = hit(e.clientX, e.clientY);
    if (!h || h.onCap || !selRef.current?.[h.p]) return;
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
        const d = dragRef.current;
        if (d) {
          if (!d.armed) {
            if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_DEAD_ZONE) return;
            d.armed = true;
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
        const h = hit(e.clientX, e.clientY);
        const br = brushRef.current;
        const onSel = !!h && !h.onCap && !!selRef.current?.[h.p] && br.mode !== 'off';
        const pos = tipPos(e.clientX, e.clientY);
        if (onSel) {
          showRing(coordsOf(h.p), h.n);
          showHoverBox(null);
          const who = br.radius === null ? '整面' : `筆刷 ${br.shape === 'square' ? '方' : '圓'} r${br.radius}`;
          const dirName = directionName(h.n);
          if (br.mode === 'level') {
            host.style.cursor = 'crosshair';
            setHoverTag({ text: `點一下：圈內補平到這面（${dirName}）`, ...pos });
            onHover(`補平（${who}）：點一下把範圍內補到這一面；按住再拖可以多 ±n 格；轉視角用中鍵或 Alt＋左鍵拖`);
          } else {
            const { vx, vy } = screenVectors(h.point, h.n);
            host.style.cursor = Math.hypot(vx, vy) < HEAD_ON_PX || Math.abs(vy) >= Math.abs(vx) ? 'ns-resize' : 'ew-resize';
            setHoverTag({ text: `拖：${dirName}長／縮`, ...pos });
            onHover(`推拉（${who}）：按住${dirName}拉＝長、往回推＝縮，放開套用（拖的時候就看得到結果），Esc 取消；轉視角用中鍵或 Alt＋左鍵拖`);
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
                ? `筆刷已關閉：拖拉只轉視角，不會改到 ${comp.label}；要雕刻請在上方「筆刷」切回推拉或補平`
                : `點一下選取 ${comp.label}；同一處再點一次＝選它後面的結構；Shift 多選`
            : null,
        );
      }}
      onPointerUp={(e) => {
        const c = ctxRef.current;
        const d = dragRef.current;
        const down = downRef.current;
        dragRef.current = null;
        downRef.current = null;
        if (!c || !down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
        if (down.button === 2) {
          // 右鍵拖＝平移；沒拖才開選單
          if (moved < 4) {
            const r = e.currentTarget.getBoundingClientRect();
            const h = hit(e.clientX, e.clientY);
            onMenu({ voxel: h?.p ?? null, along: hitsAlong(e.clientX, e.clientY).map((a) => a.key) }, e.clientX - r.left, e.clientY - r.top);
          }
          return;
        }
        if (e.button !== 0) return;
        if (d) {
          // 補平：點一下就套用到那一面（拖過的話再加減 n 格）；推拉：拖過死區且 n ≠ 0 才套用
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
        // 雙擊模型：旋轉中心移到點到的地方（相機不動，之後繞著它轉）；雙擊空白：回全貌
        if (h) c.controls.target.copy(h.world);
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
  zRange,
  diff,
  preview,
  onPick,
  onStep,
  onHover,
}: {
  vol: Volume;
  axis: Axis;
  at: number;
  materials: Material[];
  hidden: Set<number>;
  selMask: Uint8Array | null;
  cursor: Vec3;
  zRange: ZRange;
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

  useEffect(() => {
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff, preview);
  }, [vol, axis, at, rgb, hidden, selMask, diff, preview, W, H]);

  const [cu, cv] = axis === 'z' ? [cursor[0], cursor[1]] : axis === 'y' ? [cursor[0], cursor[2]] : [cursor[2], cursor[1]];
  const imgRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: W, h: H });

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const s = Math.min(e.contentRect.width / W, e.contentRect.height / H);
      setSize({ w: Math.floor(W * s), h: Math.floor(H * s) });
    });
    ro.observe(fitRef.current!);
    return () => ro.disconnect();
  }, [W, H]);

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
    const u = Math.floor(((e.clientX - r.left) / r.width) * W);
    const v = Math.floor(((e.clientY - r.top) / r.height) * H);
    return u >= 0 && v >= 0 && u < W && v < H ? toVoxel(u, v) : null;
  };

  const partial = axis !== 'z' && (zRange[0] > 0 || zRange[1] < vol.Z - 1);
  const z0 = zRange[0];
  const z1 = zRange[1] + 1;
  const frame = { fill: 'var(--c-primary)', fillOpacity: 0.08, stroke: 'var(--c-primary)', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' } as const;

  return (
    <div className="slice-fit" ref={fitRef}>
      <div
        className="slice-img"
        ref={imgRef}
        style={{ width: size.w, height: size.h }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = uvOf(e);
          if (p) onPick(p, selectModeOf(e));
        }}
        onPointerMove={(e) => onHover?.(uvOf(e))}
        onPointerLeave={() => onHover?.(null)}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', imageRendering: 'pixelated', display: 'block' }} />
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          {partial &&
            (axis === 'y' ? (
              <rect x={0} y={z0} width={W} height={z1 - z0} {...frame} />
            ) : (
              <rect x={z0} y={0} width={z1 - z0} height={H} {...frame} />
            ))}
          <line x1={cu + 0.5} y1={0} x2={cu + 0.5} y2={H} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} y1={cv + 0.5} x2={W} y2={cv + 0.5} stroke="#d46b08" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        </svg>
      </div>
    </div>
  );
}
