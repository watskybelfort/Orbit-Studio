/**
 * Acceso de bajo nivel a los bytes de un sample.
 *
 * Vive aparte de `sound-actions` porque lo necesitan módulos que no tienen por
 * qué arrastrar el alta de canales ni el bus de comandos: el analizador de
 * audio (`state/audio-analysis`), el render de export, la colaboración y la
 * política de disco. Sin esta hoja, cualquiera de ellos que importara
 * `sound-actions` cerraba un ciclo con `bounce` (que ya importa el render).
 */

/** Identidad por contenido, en sha1 hexadecimal; null si no hay WebCrypto. */
export async function sha1Hex(data: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-1', data);
    let out = '';
    for (const b of new Uint8Array(digest)) out += b.toString(16).padStart(2, '0');
    return out;
  } catch {
    return null;
  }
}

/** Bytes de un SampleRef según su esquema, o null si no es resoluble aquí. */
export async function readSampleBytes(path: string): Promise<ArrayBuffer | null> {
  const api = window.orbit;
  if (!api) return null;
  if (path.startsWith('factory:')) return api.library.read(path.slice('factory:'.length));
  if (path.startsWith('pack:')) return api.pack.read(path.slice('pack:'.length));
  if (path.startsWith('recording:')) return api.recording.read(path.slice('recording:'.length));
  if (path.startsWith('user:')) return api.folder.read(path.slice('user:'.length));
  return null;
}
