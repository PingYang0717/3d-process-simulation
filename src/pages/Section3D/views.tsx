import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react';
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
import { call } from '../../volume/client';
import { type SelectMode, selectModeOf } from './editor';

const SEL_RGB: Vec3 = [22, 119, 255];

export interface View3DHandle {
  resetView: () => void;
}

interface Ctx {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  controls: OrbitControls;
  mesh: Mesh<BufferGeometry, MeshLambertMaterial>;
  selFill: Mesh<BufferGeometry, MeshLambertMaterial>;
  voidMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  voidEdges: LineSegments<EdgesGeometry, LineBasicMaterial>;
  selBox: LineSegments;
  ghost: LineSegments<BufferGeometry, LineDashedMaterial>;
  cross: LineSegments;
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
  local: boolean;
  move: boolean;
  hitVoxel: Vec3;
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
const boxEdges = (b: BBox) => new EdgesGeometry(new BoxGeometry(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1));

/**
 * 3D：Worker 做 greedy mesh（同材質同朝向的面合併成大矩形），改過的體素混紅；
 * 選取半透明網格＋bbox 線框、橘色十字、剖開。xray：VOID 另畫一層、關掉深度測試；translucent：材質半透明。
 * 選好結構後按住它的面拖：位移投影到面法線換成 voxel 數，橘色虛線框預覽，放開才套用；
 * Alt＋拖＝局部凸起，Ctrl＋拖＝整塊移動。
 * 體素 y 向下，所以網格 scale y = −1 再平移，讓畫面上方 = y 索引小。
 */
export function View3D({
  vol,
  materials,
  hidden,
  selMask,
  selBBox,
  cursor,
  clipZ,
  diffMask,
  onPick,
  onMenu,
  onDrag,
  onHover,
  floatRef,
  handle,
  xray = false,
  translucent = false,
  bumpRadius,
  busy,
}: {
  vol: Volume;
  materials: Material[];
  hidden: Set<number>;
  selMask: Uint8Array | null;
  selBBox: BBox | null;
  cursor: Vec3;
  clipZ: number | null;
  diffMask: Uint8Array | null;
  onPick: (voxel: number | null, mode: SelectMode) => void;
  onMenu: (voxel: number | null, x: number, y: number) => void;
  onDrag: (kind: 'push' | 'move', dir: Vec3, n: number, local?: Vec3) => void;
  onHover: (text: string | null) => void;
  floatRef: RefObject<HTMLDivElement>;
  handle: MutableRefObject<View3DHandle | null>;
  xray?: boolean;
  translucent?: boolean;
  bumpRadius: number;
  busy: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const bboxRef = useRef(selBBox);
  bboxRef.current = selBBox;
  const selRef = useRef(selMask);
  selRef.current = selMask;
  const dragRef = useRef<Drag | null>(null);
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const [dragTip, setDragTip] = useState<{ dir: Vec3; n: number; local: boolean } | null>(null);
  const [meshing, setMeshing] = useState(false);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.localClippingEnabled = true;
    host.appendChild(renderer.domElement);
    const scene = new Scene();
    scene.background = new Color('#f5f6f8');
    const camera = new PerspectiveCamera(40, 1, 1, 1e5);
    camera.up.set(0, 1, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const resetView = () => {
      const r = 1.5 * Math.max(vol.X, vol.Y, vol.Z);
      camera.position.set(vol.X / 2 + 0.55 * r, vol.Y / 2 + 0.38 * r, vol.Z / 2 + 0.74 * r);
      camera.far = r * 20;
      camera.updateProjectionMatrix();
      controls.target.set(vol.X / 2, vol.Y / 2, vol.Z / 2);
      controls.update();
    };
    resetView();
    handle.current = { resetView };
    scene.add(new AmbientLight(0xffffff, 0.8));
    const key = new DirectionalLight(0xffffff, 0.85);
    key.position.set(1, 2, 1.5);
    scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.3);
    fill.position.set(-1, -0.5, -1);
    scene.add(fill);
    const frame = new LineSegments(new EdgesGeometry(new BoxGeometry(vol.X, vol.Y, vol.Z)), new LineBasicMaterial({ color: 0xc9cdd1 }));
    frame.position.set(vol.X / 2, vol.Y / 2, vol.Z / 2);
    scene.add(frame);
    // 體素座標的物件：翻 y
    const voxelSpace = <T extends Mesh | LineSegments>(o: T, order = 0) => {
      o.scale.set(1, -1, 1);
      o.position.y = vol.Y;
      o.renderOrder = order;
      o.frustumCulled = false;
      scene.add(o);
      return o;
    };
    const mesh = voxelSpace(new Mesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, side: DoubleSide })));
    const selFill = voxelSpace(
      new Mesh(new BufferGeometry(), new MeshLambertMaterial({ color: 0x1677ff, transparent: true, opacity: 0.45, side: DoubleSide })),
      2,
    );
    const voidMesh = voxelSpace(
      new Mesh(
        new BufferGeometry(),
        new MeshBasicMaterial({ color: 0x262626, transparent: true, opacity: 0.8, depthTest: false, side: DoubleSide }),
      ),
      3,
    );
    const voidEdges = voxelSpace(
      new LineSegments(
        new EdgesGeometry(),
        new LineBasicMaterial({ color: 0xff7875, depthTest: false, transparent: true, opacity: 0.75 }),
      ),
      4,
    );
    selFill.visible = voidMesh.visible = voidEdges.visible = false;
    const selBox = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x1677ff }));
    selBox.visible = false;
    scene.add(selBox);
    const ghost = new LineSegments(new BufferGeometry(), new LineDashedMaterial({ color: 0xd46b08, dashSize: 3, gapSize: 2 }));
    ghost.visible = false;
    scene.add(ghost);
    const cross = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xd46b08 }));
    scene.add(cross);
    ctxRef.current = { renderer, scene, camera, controls, mesh, selFill, voidMesh, voidEdges, selBox, ghost, cross };

    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    // 小標籤在 render loop 裡投影 8 個角定位，不走 React 狀態
    const p = new Vector3();
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
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof Mesh || o instanceof LineSegments) {
          o.geometry.dispose();
          o.material.dispose();
        }
      });
      renderer.dispose();
      host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [vol.X, vol.Y, vol.Z]);

  // 主網格（Worker greedy mesh）；只採用最新一次請求的結果
  const meshSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++meshSeq.current;
    setMeshing(true);
    call('mesh', { vol, hidden: hiddenTable(hidden), diff: diffMask ?? undefined, palette: palette(materials) })
      .then((m) => {
        if (seq !== meshSeq.current || !ctxRef.current) return;
        c.mesh.geometry.dispose();
        c.mesh.geometry = toGeometry(m);
        setMeshing(false);
      })
      .catch(() => setMeshing(false));
  }, [vol, materials, hidden, diffMask]);

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
    const only = new Uint8Array(vol.data.length);
    let n = 0;
    for (let i = 0; i < only.length; i++)
      if (vol.data[i] === VOID) {
        only[i] = 1;
        n++;
      }
    if (!n) return off();
    call('mesh', { vol, hidden: hiddenTable(hidden), only, palette: palette(materials), tint: [0.15, 0.15, 0.15] }).then((m) => {
      if (seq !== voidSeq.current || !ctxRef.current) return;
      c.voidMesh.geometry.dispose();
      c.voidMesh.geometry = toGeometry(m);
      c.voidEdges.geometry.dispose();
      c.voidEdges.geometry = new EdgesGeometry(c.voidMesh.geometry, 30);
      c.voidMesh.visible = c.voidEdges.visible = true;
    });
  }, [vol, hidden, xray]);

  // 選取：半透明網格（只含 affMask）＋ bbox 線框
  const selSeq = useRef(0);
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const seq = ++selSeq.current;
    if (!selMask || !selBBox) {
      c.selFill.visible = c.selBox.visible = false;
      return;
    }
    const b = selBBox;
    c.selBox.geometry.dispose();
    c.selBox.geometry = boxEdges(b);
    c.selBox.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
    c.selBox.visible = true;
    const tint = SEL_RGB.map((v) => v / 255) as Vec3;
    call('mesh', { vol, hidden: hiddenTable(hidden), only: selMask, palette: palette(materials), tint }).then((m) => {
      if (seq !== selSeq.current || !ctxRef.current) return;
      c.selFill.geometry.dispose();
      c.selFill.geometry = toGeometry(m);
      c.selFill.visible = true;
    });
  }, [vol, selMask, selBBox]);

  // 剖開：只畫到 z ≤ clipZ
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const planes = clipZ === null ? [] : [new Plane(new Vector3(0, 0, -1), clipZ + 1)];
    for (const o of [c.mesh, c.selFill, c.voidMesh, c.voidEdges]) o.material.clippingPlanes = planes;
  }, [clipZ, vol.X, vol.Y, vol.Z]);

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
   */
  const hit = (clientX: number, clientY: number) => {
    const c = ctxRef.current;
    if (!c || !c.mesh.geometry.attributes.position) return null;
    const r = hostRef.current!.getBoundingClientRect();
    const ndc = new Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, c.camera);
    const h = ray.intersectObject(c.mesh, false).find((h) => clipZ === null || h.point.z <= clipZ + 1);
    if (!h?.face) return null;
    const pt = c.mesh.worldToLocal(h.point.clone());
    const eye = c.mesh.worldToLocal(c.camera.position.clone()).sub(pt);
    const f = h.face.normal;
    const facing = f.x * eye.x + f.y * eye.y + f.z * eye.z >= 0 ? 1 : -1;
    const n: Vec3 = [f.x * facing, f.y * facing, f.z * facing];
    const point: Vec3 = [pt.x, pt.y, pt.z];
    const solid = (i: number) => i >= 0 && vol.data[i] !== 0 && !hidden.has(vol.data[i]);
    const a = voxelFromHit(vol, point, n);
    if (solid(a)) return { p: a, n, point };
    const back: Vec3 = [-n[0], -n[1], -n[2]];
    const b = voxelFromHit(vol, point, back);
    return solid(b) ? { p: b, n: back, point } : null;
  };

  /** 拖拉預覽：選取的外框沿 dir 伸縮 n 格，畫成橘色虛線。 */
  const showGhost = (n: number, dir: Vec3) => {
    const c = ctxRef.current;
    const b = bboxRef.current;
    if (!c || !b) return;
    const g = { ...b };
    const keys = [
      ['x0', 'x1'],
      ['y0', 'y1'],
      ['z0', 'z1'],
    ] as const;
    keys.forEach(([lo, hi], a) => {
      if (dir[a] > 0) g[hi] += n;
      else if (dir[a] < 0) g[lo] -= n;
    });
    g.x1 = Math.max(g.x0, g.x1);
    g.y1 = Math.max(g.y0, g.y1);
    g.z1 = Math.max(g.z0, g.z1);
    c.ghost.geometry.dispose();
    c.ghost.geometry = boxEdges(g);
    c.ghost.computeLineDistances();
    c.ghost.position.set((g.x0 + g.x1 + 1) / 2, vol.Y - (g.y0 + g.y1 + 1) / 2, (g.z0 + g.z1 + 1) / 2);
    c.ghost.visible = n !== 0;
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
        if (busy) return;
        const h = hit(e.clientX, e.clientY);
        if (!h || !selRef.current?.[h.p]) return;
        // 按在已選結構的面上：開始拖這個面（法線 1 格在螢幕上的位移當作量尺）
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
        dragRef.current = {
          p: h.p,
          dir: h.n,
          sx: e.clientX,
          sy: e.clientY,
          vx: b[0] - a[0],
          vy: b[1] - a[1],
          n: 0,
          local: e.altKey,
          move: e.ctrlKey || e.metaKey,
          hitVoxel: [x, y, z],
        };
        c.controls.enabled = false;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (d) {
          const len2 = d.vx * d.vx + d.vy * d.vy;
          const n = len2 > 1e-6 ? Math.round(((e.clientX - d.sx) * d.vx + (e.clientY - d.sy) * d.vy) / len2) : 0;
          if (n !== d.n) {
            d.n = n;
            showGhost(n, d.dir);
            setDragTip({ dir: d.dir, n, local: d.local });
          }
          return;
        }
        if (downRef.current) return;
        const now = performance.now();
        if (now - hoverAt.current < 80) return;
        hoverAt.current = now;
        const h = hit(e.clientX, e.clientY);
        const onSel = !!h && !!selRef.current?.[h.p];
        hostRef.current!.style.cursor = onSel ? 'grab' : 'default';
        onHover(
          onSel
            ? `拖拉這個面：${directionName(h.n)}推／拉；Alt＋拖＝只凸起半徑 ${bumpRadius} vx 的局部；Ctrl＋拖＝整塊移動`
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
          if (d.n !== 0) onDrag(d.move ? 'move' : 'push', d.dir, d.n, d.local ? d.hitVoxel : undefined);
          else onPick(d.p, selectModeOf(e));
          return;
        }
        if (!down || e.button !== 0 || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        onPick(hit(e.clientX, e.clientY)?.p ?? null, selectModeOf(e));
      }}
      onPointerLeave={() => onHover(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(hit(e.clientX, e.clientY)?.p ?? null, e.clientX - r.left, e.clientY - r.top);
      }}
    >
      {dragTip && (
        <div className="drag-tip">
          {dragTip.local ? '局部' : ''}
          {directionName(dragTip.dir)}
          {dragTip.n > 0 ? '推' : '縮'} {Math.abs(dragTip.n)} vx
        </div>
      )}
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
    const cv = canvasRef.current!;
    cv.width = W;
    cv.height = H;
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
          const r = e.currentTarget.getBoundingClientRect();
          const u = Math.floor(((e.clientX - r.left) / r.width) * W);
          const v = Math.floor(((e.clientY - r.top) / r.height) * H);
          if (u >= 0 && v >= 0 && u < W && v < H) onPick(toVoxel(u, v), selectModeOf(e));
        }}
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
