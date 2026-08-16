// La fuente de lamejs se importa como texto (?raw de Vite) y se instancia a
// mano en mp3.ts — el paquete no exporta nada usable por sí mismo.
declare module 'lamejs/lame.min.js?raw' {
  const source: string;
  export default source;
}
