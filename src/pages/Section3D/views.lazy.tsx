import { Suspense, lazy } from 'react';

/** 3D／切面畫布拖著 three.js；歡迎頁用不到，等載入檔案後再抓。CompareView 與 index 都從這裡拿。 */
type View3DProps = Parameters<typeof import('./views').View3D>[0];
type SliceViewProps = Parameters<typeof import('./views').SliceView>[0];

const LazyView3D = lazy(() => import('./views').then((m) => ({ default: m.View3D })));
const LazySliceView = lazy(() => import('./views').then((m) => ({ default: m.SliceView })));

export function View3D(props: View3DProps) {
  return (
    <Suspense fallback={<div className="view-loading" role="status">載入 3D 引擎…</div>}>
      <LazyView3D {...props} />
    </Suspense>
  );
}

export function SliceView(props: SliceViewProps) {
  return (
    <Suspense fallback={<div className="view-loading" role="status">載入中…</div>}>
      <LazySliceView {...props} />
    </Suspense>
  );
}
