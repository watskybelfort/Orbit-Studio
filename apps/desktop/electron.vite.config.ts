import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const r = (p: string) => resolve(__dirname, p);

const alias = {
  '@orbit/core': r('../../packages/core/src/index.ts'),
  '@orbit/engine': r('../../packages/engine/src/index.ts'),
  '@orbit/ui': r('../../packages/ui/src/index.ts'),
  '@orbit/collab': r('../../packages/collab/src/index.ts'),
};

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
  },
  preload: {
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: r('src/renderer/index.html') },
    },
  },
});
