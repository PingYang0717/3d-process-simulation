import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // three 只有載入檔案後的 3D／切面會用到（views.lazy.tsx），antd 另外一包方便快取
        manualChunks: {
          three: ['three', 'three-mesh-bvh'],
          antd: ['antd', '@ant-design/icons'],
        },
      },
    },
  },
  test: { environment: 'node' },
});
