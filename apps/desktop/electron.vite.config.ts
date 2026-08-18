import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const r = (p: string) => resolve(__dirname, p);

// El alias de subruta va ANTES que el del paquete: el plugin de alias sustituye
// por prefijo y el orden de inserción decide.
const alias = {
  '@orbit/claude-bridge/node/ws-host': r('../../packages/claude-bridge/src/node/ws-host.ts'),
  '@orbit/claude-bridge/node/bridge-auth': r('../../packages/claude-bridge/src/node/bridge-auth.ts'),
  '@orbit/claude-bridge': r('../../packages/claude-bridge/src/index.ts'),
  '@orbit/core': r('../../packages/core/src/index.ts'),
  '@orbit/engine': r('../../packages/engine/src/index.ts'),
  '@orbit/ui': r('../../packages/ui/src/index.ts'),
  '@orbit/collab': r('../../packages/collab/src/index.ts'),
  '@orbit/server': r('../../apps/server/src/index.ts'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        // Dependencias nativas opcionales de ws: no existen y no hacen falta.
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: 'src/renderer',
    // Windows reserva rangos de puertos para Hyper-V y el 5173 de vite cayó
    // dentro (netsh interface ipv4 show excludedportrange protocol=tcp): con
    // el puerto por defecto, `npm run dev` moría con EACCES en ::1:5173. El
    // 5900 está fuera de todos los rangos reservados de esta máquina.
    server: { port: 5900 },
    plugins: [react()],
    resolve: { alias },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: r('src/renderer/index.html') },
    },
  },
});
