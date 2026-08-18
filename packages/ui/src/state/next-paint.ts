/**
 * Cede un frame real al navegador antes de un trabajo bloqueante (un render
 * offline síncrono): una microtarea no basta para repintar, así que esperamos
 * rAF + macrotarea. Con la ventana oculta u ocluida Chromium NO dispara rAF, así
 * que un timeout de respaldo evita quedarse colgado esperando un frame que no
 * llega.
 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 250);
  });
}
