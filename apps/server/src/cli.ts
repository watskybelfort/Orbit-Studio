/**
 * Entrada de línea de comandos del servidor de colaboración: `npm run server`
 * (tsx src/cli.ts). Arranca la librería con el puerto/host del entorno y cierra
 * limpio guardando las salas al recibir SIGINT/SIGTERM.
 */

import { startServer } from './index';

startServer({
  port: Number(process.env.PORT ?? 7900),
  host: process.env.HOST ?? '127.0.0.1',
})
  .then((handle) => {
    const shutdown = () => {
      console.log('\n[server] cerrando: guardando rooms…');
      void handle.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((err: unknown) => {
    console.error('[server]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
