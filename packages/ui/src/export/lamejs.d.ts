// Tipos mínimos del bundle UMD de lamejs (la entrada ESM de 1.2.1 tiene un
// bug de símbolos sueltos; se importa lame.min.js directamente).
declare module 'lamejs/lame.min.js' {
  class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number);
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
    flush(): Int8Array;
  }
  const lamejs: { Mp3Encoder: typeof Mp3Encoder };
  export default lamejs;
}
