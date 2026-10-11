import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/sa/',
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.VITE_PORT || '8180', 10),
    proxy: {
      '/sa/api': {
        target: 'http://localhost:3100',
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    exclude: ['src/components/__tests__/FilterEditor.spec.tsx'],
    setupFiles: ['src/test/vitest.setup.ts'],
    // 整页渲染类用例（antd 表单/表格/图表）单文件就要 4–34 秒，5s 默认值在并行跑整轮时
    // 会随机器负载随机超时（同一用例单跑必过）。这里统一放宽，避免把「机器忙」误判成功能回归。
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
