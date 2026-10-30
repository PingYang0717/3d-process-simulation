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
  VOID,
  directionName,
  hexToRgb,
  idx,
  voxelFromHit,
} from '../../volume/volume';
import { call, ensure, sidOf } from '../../volume/client';
import type { EditState, Local } from '../../volume/ops';
import { type Brush, type SelectMode, selectModeOf } from './editor';

const SEL_RGB: Vec3 = [22, 119, 255];
/** 選取層沿法線外推的量：固定值，相機再遠也不會和主網格共面閃爍。 */
const INFLATE = 0.03;

export type ViewPreset = 'front' | 'top' | 'side' | 'iso' | 'home' | 'fit';
/** 剖面：沿 axis 在 at 剖開；side = 1 留座標 ≤ at 的那一半，-1 留 ≥ at。 */
export interface Clip {
  axis: Axis;
  at: number;
  side: 1 | -1;
}
export type ViewMode = 'now' | 'orig' | 'diff';
export type Sculpt = { kind: 'push'; dir: Vec3; n: number; local: Local } | { kind: 'level'; dir: Vec3; to: number; local: Local };

export interface View3DHandle {
  setView: (preset: ViewPreset) => void;
  /** 立刻把 mask 裡體素的面改成這個顏色（換材質的即時預覽；正式網格之後覆蓋）。 */
  recolor: (mask: Uint8Array, rgb: Vec3) => void;
}

interface Ctx {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  ghostMesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  selFill: Mesh<BufferGeometry, MeshLambertMaterial>;
  voidMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  voidEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  selBox: LineSegments;
  ghost: LineSegments<BufferGeometry, LineDashedMaterial>;
  ring: LineLoop<BufferGeometry, LineBasicMaterial>;
  cross: LineSegments;
  cap: Mesh<PlaneGeometry, MeshBasicMaterial>;
  capEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
}

/** 拖拉中的面：p = 按下的體素、dir = 面的外法線（體素座標）、(vx, vy) = 法線 1 格投影到螢幕的位移。 */
interface Drag {
  p: number;
  dir: Vec3;
  sx: number;
  sy: number;
  vx: number;
  vy: number;
  n: number;
  hitVoxel: Vec3;
  mode: Brush['mode'];
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

/**
 * 把一個切面畫到 canvas：材質顏色、隱藏材質淡灰、選取混藍、差異描紅邊。
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
      const m = vol.data[i];
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
  onPick: (voxel: number | null, mode: SelectMode) => void;
  onMenu: (voxel: number | null, x: number, y: number) => void;
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
  const bboxRef = useRef(selBBox);
  bboxRef.current = selBBox;
  const selRef = useRef(selMask);
  selRef.current = selMask;
  const brushRef = useRef(brush);
  brushRef.current = brush;
  const clipRef = useRef(clip);
  clipRef.current = clip;
  const dragRef = useRef<Drag | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [dragTip, setDragTip] = useState<string | null>(null);
  const [meshing, setMeshing] = useState(false);
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
    const center = new Vector3(vol.X / 2, vol.Y / 2, vol.Z / 2);
    const ISO = new Vector3(0.55, 0.38, 0.74).normalize();
    /** 看向 target、沿 dir 退到剛好看得到半徑 radius 的距離。 */
    const look = (dir: Vector3, target: Vector3, radius: number) => {
      const vf = (camera.fov * Math.PI) / 180;
      const hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
      const d = (radius / Math.sin(Math.min(vf, hf) / 2)) * 1.08;
      camera.position.copy(target).addScaledVector(dir, d);
      controls.target.copy(target);
      controls.update();
    };
    const fullRadius = () => 0.5 * Math.hypot(vol.X, vol.Y, vol.Z);
    const setView = (preset: ViewPreset) => {
      const b = bboxRef.current;
      const target = center.clone();
      let radius = fullRadius();
      if (preset === 'fit' && b) {
        target.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
        radius = Math.max(4, 0.5 * Math.hypot(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1));
      }
      const cur = camera.position.clone().sub(controls.target).normalize();
      const dir =
        preset === 'front'
          ? new Vector3(0, 0, 1)
          : preset === 'top'
            ? new Vector3(0, 1, 0.0005).normalize()
            : preset === 'side'
              ? new Vector3(-1, 0, 0)
              : preset === 'fit'
                ? cur
                : ISO;
      look(dir, target, radius);
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
    const mesh = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })),
    );
    // 點選與滑過提示走 BVH（three-mesh-bvh），不必每次掃過全部三角形
    mesh.raycast = acceleratedRaycast;
    const ghostMesh = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.22, depthWrite: false, side: DoubleSide })),
      1,
    );
    const selFill = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshLambertMaterial({ color: 0x1677ff, transparent: true, opacity: 0.45, depthWrite: false, side: DoubleSide })),
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
    const ring = voxelSpace(new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: 0xd46b08, depthTest: false })), 5);
    selFill.visible = voidMesh.visible = voidEdges.visible = ghostMesh.visible = ring.visible = false;
    const selBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x1677ff }));
    selBox.visible = false;
    scene.add(selBox);
    const ghost = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ color: 0xd46b08, dashSize: 3, gapSize: 2, depthTest: false }));
    ghost.visible = false;
    ghost.renderOrder = 6;
    scene.add(ghost);
    const cross = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xd46b08 }));
    scene.add(cross);
    const cap = new Mesh(new PlaneGeometry(1, 1), new MeshBasicMaterial({ side: DoubleSide }));
    cap.visible = false;
    cap.frustumCulled = false;
    scene.add(cap);
    const capEdges = new LineSegments(new EdgesGeometry(cap.geometry), new LineBasicMaterial({ color: 0xd46b08 }));
    capEdges.visible = false;
    scene.add(capEdges);
    ctxRef.current = { renderer, scene, camera, controls, mesh, ghostMesh, selFill, voidMesh, voidEdges, selBox, ghost, ring, cross, cap, capEdges };

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
    handle.current = { setView, recolor };

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
          tag.style.display = '';
          tag.style.left = `${Math.max(8, Math.min(w - tw - 8, cx - tw / 2))}px`;
          tag.style.top = `${Math.max(8, Math.min(h - 48, top - 44))}px`;
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
      ro.disconnect();
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
    };
    const req =
      mode === 'diff'
        ? cached(`diff|${base}`, () => call('diffMesh', { sid: ensure(state), hidden: hiddenTable(hidden), palette: palette(materials) })).then((r) => {
            if (seq !== meshSeq.current || !ctxRef.current) return;
            swap(r.changed);
            c.ghostMesh.geometry.dispose();
            c.ghostMesh.geometry = toGeometry(r.ghost);
            c.ghostMesh.visible = true;
          })
        : cached(`main|${base}|${showDiff}`, () =>
            call('mesh', { sid: ensure(state), hidden: hiddenTable(hidden), diff: showDiff, palette: palette(materials) }),
          ).then((m) => {
            if (seq !== meshSeq.current || !ctxRef.current) return;
            swap(m);
            c.ghostMesh.visible = false;
          });
    req.then(() => setMeshing(false)).catch(() => setMeshing(false));
  }, [state, materials, hidden, showDiff, mode]);

  useEffect(() => {
    const mat = ctxRef.current?.mesh.material;
    if (!mat) return;
    mat.transparent = translucent;
    mat.opacity = translucent ? 0.3 : 1;
    mat.depthWrite = !translucent;
    mat.needsUpdate = true;
  }, [translucent]);

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
    for (const o of [c.mesh, c.ghostMesh, c.selFill, c.voidMesh, c.voidEdges]) o.material.clippingPlanes = planes;
    if (!clip) {
      c.cap.visible = c.capEdges.visible = false;
      return;
    }
    const cv = document.createElement('canvas');
    drawSlice(cv, vol, clip.axis, clip.at, rgb, hidden, mode === 'orig' ? null : selMask, mode === 'orig' ? null : diffMask);
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
  }, [clip, vol, rgb, hidden, selMask, diffMask, mode]);

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
  const hit = (clientX: number, clientY: number) => {
    const c = ctxRef.current;
    if (!c || !c.mesh.geometry.attributes.position) return null;
    const r = hostRef.current!.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, c.camera);
    const cl = clipRef.current;
    const plane = clipPlane(cl);
    // 剖開時要濾掉剖面後面的命中，所以只有沒剖開才只取第一個
    ray.firstHitOnly = !plane;
    const h = ray.intersectObject(c.mesh, false).find((h) => !plane || plane.distanceToPoint(h.point) >= -1e-6);
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
    if (!h?.face) return null;
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

  /** 筆刷圈：畫在 hit 面上。 */
  const showRing = (v: Vec3 | null, dir: Vec3 | null) => {
    const c = ctxRef.current;
    if (!c) return;
    const br = brushRef.current;
    if (!v || !dir || br.radius === null) {
      c.ring.visible = false;
      return;
    }
    const a = axisOf(dir);
    const [tu, tv] = tangents(dir);
    const center: Vec3 = [v[0] + 0.5, v[1] + 0.5, v[2] + 0.5];
    center[a] += dir[a] * 0.55;
    const r = br.radius + 0.5;
    const pts: Vector3[] = [];
    const push = (du: number, dv: number) =>
      pts.push(new Vector3(center[0] + tu[0] * du + tv[0] * dv, center[1] + tu[1] * du + tv[1] * dv, center[2] + tu[2] * du + tv[2] * dv));
    if (br.shape === 'square') {
      push(-r, -r);
      push(r, -r);
      push(r, r);
      push(-r, r);
    } else for (let k = 0; k < 48; k++) push(r * Math.cos((k / 48) * Math.PI * 2), r * Math.sin((k / 48) * Math.PI * 2));
    c.ring.geometry.dispose();
    c.ring.geometry = new BufferGeometry().setFromPoints(pts);
    c.ring.visible = true;
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
  };

  const tipOf = (d: Drag) => {
    const br = brushRef.current;
    const who = br.radius === null ? '整面' : `筆刷 r${br.radius}`;
    if (d.mode === 'level') {
      const a = axisOf(d.dir);
      const to = d.hitVoxel[a] + d.dir[a] * d.n;
      return `${who} 補平到 ${'xyz'[a]} = ${to}${d.n ? `（點到的面再${d.n > 0 ? '外' : '內'} ${Math.abs(d.n)} vx）` : ''}`;
    }
    return `${who} ${directionName(d.dir)}${d.n >= 0 ? '長' : '縮'} ${Math.abs(d.n)} vx`;
  };

  const hoverAt = useRef(0);

  return (
    <div
      ref={hostRef}
      className="view3d"
      onPointerDown={(e) => {
        const c = ctxRef.current;
        if (!c || e.button !== 0) return;
        downRef.current = { x: e.clientX, y: e.clientY };
        if (busy || mode === 'orig') return;
        const h = hit(e.clientX, e.clientY);
        if (!h || h.onCap || !selRef.current?.[h.p]) return;
        // 按在已選結構的面上：開始筆刷（法線 1 格在螢幕上的位移當作量尺）
        const r = hostRef.current!.getBoundingClientRect();
        const screen = (v: Vector3) => {
          const q = c.mesh.localToWorld(v).project(c.camera);
          return [((q.x + 1) / 2) * r.width, ((1 - q.y) / 2) * r.height];
        };
        const a = screen(new Vector3(...h.point));
        const b = screen(new Vector3(h.point[0] + h.n[0], h.point[1] + h.n[1], h.point[2] + h.n[2]));
        const x = h.p % vol.X;
        const y = ((h.p - x) / vol.X) % vol.Y;
        const z = (h.p - x - y * vol.X) / (vol.X * vol.Y);
        const d: Drag = { p: h.p, dir: h.n, sx: e.clientX, sy: e.clientY, vx: b[0] - a[0], vy: b[1] - a[1], n: 0, hitVoxel: [x, y, z], mode: brushRef.current.mode };
        dragRef.current = d;
        c.controls.enabled = false;
        c.ring.visible = false;
        if (d.mode === 'level') {
          showGhost(d);
          setDragTip(tipOf(d));
        }
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (d) {
          const len2 = d.vx * d.vx + d.vy * d.vy;
          const n = len2 > 1e-6 ? Math.round(((e.clientX - d.sx) * d.vx + (e.clientY - d.sy) * d.vy) / len2) : 0;
          if (n !== d.n) {
            d.n = n;
            showGhost(d);
            setDragTip(tipOf(d));
          }
          return;
        }
        if (downRef.current) return;
        const now = performance.now();
        if (now - hoverAt.current < 80) return;
        hoverAt.current = now;
        const h = mode === 'orig' ? null : hit(e.clientX, e.clientY);
        const onSel = !!h && !h.onCap && !!selRef.current?.[h.p];
        hostRef.current!.style.cursor = onSel ? (brushRef.current.mode === 'level' ? 'crosshair' : 'grab') : 'default';
        if (onSel) {
          const x = h.p % vol.X;
          const y = ((h.p - x) / vol.X) % vol.Y;
          const z = (h.p - x - y * vol.X) / (vol.X * vol.Y);
          showRing([x, y, z], h.n);
        } else showRing(null, null);
        const br = brushRef.current;
        const who = br.radius === null ? '整面' : `筆刷 ${br.shape === 'square' ? '方' : '圓'} r${br.radius}`;
        onHover(
          onSel
            ? br.mode === 'level'
              ? `補平（${who}）：點一下把範圍內補到這一面（${directionName(h.n)}）；按住再拖可以多 ±n 格`
              : `推拉（${who}）：按住${directionName(h.n)}拉＝長、往回推＝縮，放開才套用`
            : h?.onCap
              ? '剖面：點一下選取這裡的結構'
              : null,
        );
      }}
      onPointerUp={(e) => {
        const c = ctxRef.current;
        const d = dragRef.current;
        const down = downRef.current;
        dragRef.current = null;
        downRef.current = null;
        if (!c) return;
        if (d) {
          c.controls.enabled = true;
          c.ghost.visible = false;
          setDragTip(null);
          hostRef.current!.style.cursor = 'default';
          const br = brushRef.current;
          const local: Local = { center: d.hitVoxel, radius: br.radius, ...(br.radius !== null ? { shape: br.shape } : {}) };
          if (d.mode === 'level') {
            const a = axisOf(d.dir);
            onSculpt({ kind: 'level', dir: d.dir, to: d.hitVoxel[a] + d.dir[a] * d.n, local });
          } else if (d.n !== 0) onSculpt({ kind: 'push', dir: d.dir, n: d.n, local });
          else onPick(d.p, selectModeOf(e));
          return;
        }
        if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        onPick(hit(e.clientX, e.clientY)?.p ?? null, selectModeOf(e));
      }}
      onDoubleClick={(e) => {
        const c = ctxRef.current;
        if (!c) return;
        const h = hit(e.clientX, e.clientY);
        // 雙擊模型：旋轉中心移到點到的地方（相機不動，之後繞著它轉）；雙擊空白：回全貌
        if (h) c.controls.target.copy(h.world);
        else handle.current?.setView('home');
      }}
      onPointerLeave={() => {
        onHover(null);
        showRing(null, null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(hit(e.clientX, e.clientY)?.p ?? null, e.clientX - r.left, e.clientY - r.top);
      }}
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
      {dragTip && <div className="drag-tip">{dragTip}</div>}
      {(meshing || busy) && <div className="mesh-busy">{busy ? '計算中…' : '更新 3D…'}</div>}
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
    drawSlice(canvasRef.current!, vol, axis, at, rgb, hidden, selMask, diff);
  }, [vol, axis, at, rgb, hidden, selMask, diff, W, H]);

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
  const frame = { fill: '#1677ff', fillOpacity: 0.08, stroke: '#1677ff', strokeWidth: 1, strokeDasharray: '3 3', vectorEffect: 'non-scaling-stroke' } as const;

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
