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
  LineSegments,
  Mesh,
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
import { type Axis, type BBox, type Material, type Vec3, type Volume, type ZRange, buildFaces, hexToRgb, idx } from '../../volume/volume';
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
  mesh?: Mesh<BufferGeometry, MeshLambertMaterial>;
  faceVoxel?: Int32Array;
  selFill?: Mesh<BufferGeometry, MeshLambertMaterial>;
  selBox?: LineSegments;
  cross?: LineSegments;
}

const dispose = (scene: Scene, obj?: Mesh | LineSegments) => {
  if (!obj) return;
  scene.remove(obj);
  obj.geometry.dispose();
};

/**
 * 3D：暴露面網格（vertex color）、改過的體素混紅、選取半透明網格＋bbox 線框、橘色十字、剖開。
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
  floatRef,
  handle,
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
  floatRef: RefObject<HTMLDivElement>;
  handle: MutableRefObject<View3DHandle | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const bboxRef = useRef(selBBox);
  bboxRef.current = selBBox;

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.localClippingEnabled = true;
    host.appendChild(renderer.domElement);
    const scene = new Scene();
    scene.background = new Color('#f5f5f5');
    const camera = new PerspectiveCamera(40, 1, 1, 4000);
    camera.up.set(0, 1, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    const resetView = () => {
      const r = 1.5 * Math.max(vol.X, vol.Y, vol.Z);
      camera.position.set(vol.X / 2 + 0.55 * r, vol.Y / 2 + 0.38 * r, vol.Z / 2 + 0.74 * r);
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
    const frame = new LineSegments(
      new EdgesGeometry(new BoxGeometry(vol.X, vol.Y, vol.Z)),
      new LineBasicMaterial({ color: 0xbfbfbf }),
    );
    frame.position.set(vol.X / 2, vol.Y / 2, vol.Z / 2);
    scene.add(frame);
    ctxRef.current = { renderer, scene, camera, controls };

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
      renderer.dispose();
      host.removeChild(renderer.domElement);
      ctxRef.current = null;
    };
  }, [vol.X, vol.Y, vol.Z]);

  // 主網格
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    const rgb = new Map<number, Vec3>();
    materials.forEach((m) => rgb.set(m.id, hexToRgb(m.color)));
    const f = buildFaces(vol, (m) => (m === 0 || hidden.has(m) ? null : (rgb.get(m) ?? [255, 0, 255])));
    if (diffMask) {
      for (let t = 0; t < f.faceVoxel.length; t++) {
        if (!diffMask[f.faceVoxel[t]]) continue;
        const base = t * 9;
        for (let v = 0; v < 3; v++) {
          const i = base + v * 3;
          f.colors[i] = f.colors[i] * 0.35 + 0.65;
          f.colors[i + 1] = f.colors[i + 1] * 0.35 + 0.3 * 0.65;
          f.colors[i + 2] = f.colors[i + 2] * 0.35 + 0.3 * 0.65;
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(f.positions, 3));
    g.setAttribute('normal', new BufferAttribute(f.normals, 3));
    g.setAttribute('color', new BufferAttribute(f.colors, 3));
    const prevClip = c.mesh?.material.clippingPlanes ?? [];
    if (c.mesh) {
      c.mesh.material.dispose();
      dispose(c.scene, c.mesh);
    }
    const mesh = new Mesh(g, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide, clippingPlanes: prevClip }));
    mesh.scale.set(1, -1, 1);
    mesh.position.y = vol.Y;
    c.scene.add(mesh);
    c.mesh = mesh;
    c.faceVoxel = f.faceVoxel;
  }, [vol, materials, hidden, diffMask]);

  // 選取：半透明網格（只含 affMask）＋ bbox 線框
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    if (c.selFill) {
      c.selFill.material.dispose();
      dispose(c.scene, c.selFill);
      c.selFill = undefined;
    }
    dispose(c.scene, c.selBox);
    c.selBox = undefined;
    if (!selMask || !selBBox) return;
    const f = buildFaces(vol, () => SEL_RGB, selMask);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(f.positions, 3));
    g.setAttribute('normal', new BufferAttribute(f.normals, 3));
    const fillMesh = new Mesh(g, new MeshLambertMaterial({ color: 0x1677ff, transparent: true, opacity: 0.45, side: DoubleSide }));
    fillMesh.scale.set(1, -1, 1);
    fillMesh.position.y = vol.Y;
    fillMesh.renderOrder = 2;
    fillMesh.material.clippingPlanes = c.mesh?.material.clippingPlanes ?? [];
    c.scene.add(fillMesh);
    c.selFill = fillMesh;
    const b = selBBox;
    const box = new LineSegments(
      new EdgesGeometry(new BoxGeometry(b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, b.z1 - b.z0 + 1)),
      new LineBasicMaterial({ color: 0x1677ff }),
    );
    box.position.set((b.x0 + b.x1 + 1) / 2, vol.Y - (b.y0 + b.y1 + 1) / 2, (b.z0 + b.z1 + 1) / 2);
    c.scene.add(box);
    c.selBox = box;
  }, [vol, selMask, selBBox]);

  // 剖開：只畫到 z ≤ clipZ
  useEffect(() => {
    const c = ctxRef.current;
    if (!c?.mesh) return;
    const planes = clipZ === null ? [] : [new Plane(new Vector3(0, 0, -1), clipZ + 1)];
    c.mesh.material.clippingPlanes = planes;
    if (c.selFill) c.selFill.material.clippingPlanes = planes;
  }, [clipZ, vol, selMask, materials, hidden, diffMask]);

  // 十字
  useEffect(() => {
    const c = ctxRef.current;
    if (!c) return;
    dispose(c.scene, c.cross);
    const [x, y, z] = cursor;
    const g = new BufferGeometry().setFromPoints([
      new Vector3(0, vol.Y - y - 0.5, z + 0.5),
      new Vector3(vol.X, vol.Y - y - 0.5, z + 0.5),
      new Vector3(x + 0.5, 0, z + 0.5),
      new Vector3(x + 0.5, vol.Y, z + 0.5),
      new Vector3(x + 0.5, vol.Y - y - 0.5, 0),
      new Vector3(x + 0.5, vol.Y - y - 0.5, vol.Z),
    ]);
    const cross = new LineSegments(g, new LineBasicMaterial({ color: 0xd46b08 }));
    c.scene.add(cross);
    c.cross = cross;
  }, [cursor, vol]);

  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    const c = ctxRef.current;
    if (!c?.mesh || !c.faceVoxel) return null;
    const r = e.currentTarget.getBoundingClientRect();
    const ndc = new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new Raycaster();
    ray.setFromCamera(ndc, c.camera);
    const hits = ray.intersectObject(c.mesh, false).filter((h) => clipZ === null || h.point.z <= clipZ + 1);
    return hits.length && hits[0].faceIndex !== undefined && hits[0].faceIndex !== null ? c.faceVoxel[hits[0].faceIndex] : null;
  };
  const down = useRef<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={hostRef}
      className="view3d"
      onPointerDown={(e) => {
        down.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={(e) => {
        if (!down.current || e.button !== 0) return;
        const moved = Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y);
        down.current = null;
        if (moved <= 4) onPick(pick(e), selectModeOf(e));
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        onMenu(pick(e), e.clientX - r.left, e.clientY - r.top);
      }}
    />
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
