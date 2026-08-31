/**
 * La medida en BYTES DE DISCO de cinco Normalizar seguidos sobre un clip largo,
 * con y sin el arreglo — el equivalente de la medida en memoria de la v3.9
 * (6 entradas / 2 304 000 B → 2 / 768 000 B, en `audio-cache-policy.test.ts`).
 *
 * Se mide contra una carpeta de grabaciones de mentira que se comporta como la
 * de verdad en lo único que aquí importa: `recording:save` escribe con
 * `writeFile`, o sea que PISA por nombre y devuelve el nombre que usó.
 * El audio, el codificador WAV y el sha1 son los de verdad.
 *
 * Las dos cosas que se miden:
 *
 *  1. **El nombre por reloj era, además de una fuga, un borrado silencioso.**
 *     `Edit HH.MM.SS.wav` no lleva fecha: dos ediciones del mismo segundo —o la
 *     de hoy contra la de ayer a la misma hora— comparten archivo, y la segunda
 *     se lleva por delante el audio de la primera sin decir nada.
 *  2. **Con el nombre por contenido, cinco Normarlizar dejan UN archivo, no
 *     cinco.** Y no es un truco de laboratorio: normalizar lleva el pico a 0,97,
 *     así que a partir del segundo la ganancia es 1 y el WAV de 24 bits sale
 *     byte a byte idéntico. Ahí se recupera disco sin dar de baja nada, que es
 *     la mitad segura del arreglo.
 *
 * Y al final, la mitad que sí da de baja: cuando la entrada de historial que
 * protegía a un archivo se cae de verdad, el barrido lo recupera y lo dice en
 * bytes.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { encodeWav } from '@orbit/engine';
import { ProjectStore } from '@orbit/core';
import { readSource } from './read-source';

// ── El mundo de mentira: la carpeta de grabaciones ──────────────────────────

/**
 * `userData/recordings` reducida a lo que decide esta medida: guarda por nombre
 * saneado y PISA lo que hubiera (`writeFile`), como el handler `recording:save`
 * de `apps/desktop/src/main/index.ts`.
 */
function fakeRecordingsDir() {
  const files = new Map<string, Uint8Array>();
  const papelera = new Map<string, Uint8Array>();
  return {
    files,
    papelera,
    save(name: string, data: Uint8Array): string {
      const safe = name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'toma.wav';
      files.set(safe, data);
      return safe;
    },
    /** Bytes ocupados ahora mismo. Es la medida. */
    stats() {
      let bytes = 0;
      for (const data of files.values()) bytes += data.byteLength;
      return { files: files.size, bytes };
    },
    /**
     * La capacidad que pide `RecordingStore`: baja REVERSIBLE, no borrado. Aquí
     * la papelera es un `Map` aparte; en el almacén de verdad es una carpeta con
     * caducidad que `recording:read` sigue resolviendo.
     */
    async discard(names: readonly string[]): Promise<string[]> {
      const out: string[] = [];
      for (const name of names) {
        const data = files.get(name);
        if (!data) continue;
        papelera.set(name, data);
        files.delete(name);
        out.push(name);
      }
      return out;
    },
  };
}

// ── El audio de verdad ──────────────────────────────────────────────────────

const RATE = 48000;
/** El "clip largo" del reporte: 30 s estéreo. */
const SECONDS = 30;

function pad(): { left: Float32Array; right: Float32Array } {
  const n = RATE * SECONDS;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.31 * Math.sin(i * 0.01) + 0.05 * Math.sin(i * 0.13);
    right[i] = 0.28 * Math.sin(i * 0.011);
  }
  return { left, right };
}

/**
 * La misma cuenta que `applyOp('normalize', …)` en `AudioEditor.tsx`. Se copia
 * en vez de importarse porque vive dentro del `.tsx` (la convención del repo es
 * no montar componentes); el test de más abajo comprueba contra el CÓDIGO REAL
 * que la fórmula sigue siendo esta.
 */
function normalize(ch: { left: Float32Array; right: Float32Array }) {
  const left = ch.left.slice();
  const right = ch.right.slice();
  const n = left.length;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
    if (a > peak) peak = a;
  }
  const g = peak > 0 ? 0.97 / peak : 1;
  for (let i = 0; i < n; i++) {
    left[i]! *= g;
    right[i]! *= g;
  }
  return { left, right };
}

/**
 * El WAV de 24 bits de vuelta a float, que es lo que hace `decodeAudioData` al
 * releer el sample recién escrito antes del siguiente Normalizar. Sin esta
 * vuelta la medida sería mentira: mediría cinco operaciones sobre el buffer en
 * memoria, no sobre lo que de verdad quedó en disco.
 */
function decodeWav24(wav: Uint8Array): { left: Float32Array; right: Float32Array } {
  const frames = (wav.byteLength - 44) / 6;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [left, right]) {
      let s = wav[off]! | (wav[off + 1]! << 8) | (wav[off + 2]! << 16);
      if (s & 0x800000) s -= 0x1000000;
      ch[i] = s / 8388607;
      off += 3;
    }
  }
  return { left, right };
}

const sha1 = (data: Uint8Array) => createHash('sha1').update(data).digest('hex');

// ── 1. El nombre por reloj: fuga Y borrado silencioso ───────────────────────

describe('el nombre por reloj de antes', () => {
  it('dos ediciones del mismo segundo comparten archivo: la segunda pisa el audio de la primera', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 30, 14, 3, 22));
    const dir = fakeRecordingsDir();
    const two = (n: number) => String(n).padStart(2, '0');
    const clockName = () => {
      const s = new Date();
      return `Edit ${two(s.getHours())}.${two(s.getMinutes())}.${two(s.getSeconds())}.wav`;
    };

    const a = encodeWav(new Float32Array([0.5]), new Float32Array([0.5]), RATE, 24);
    const fileA = dir.save(clockName(), a);
    // Un año después, a la misma hora del reloj: el nombre no lleva fecha.
    vi.setSystemTime(new Date(2027, 1, 2, 14, 3, 22));
    const b = encodeWav(new Float32Array([-0.9]), new Float32Array([-0.9]), RATE, 24);
    const fileB = dir.save(clockName(), b);

    expect(fileA).toBe(fileB);
    // El proyecto viejo sigue apuntando a `recording:Edit 14.03.22.wav` — y ese
    // archivo ya tiene otro audio dentro. El sample no está "perdido": está
    // MENTIDO, con un hash que ya no describe su contenido.
    expect(sha1(dir.files.get(fileA)!)).not.toBe(sha1(a));
    expect(sha1(dir.files.get(fileA)!)).toBe(sha1(b));
    vi.useRealTimers();
  });

  it('y cuando no colisionan, cinco Normalizar dejan cinco archivos para siempre', () => {
    const dir = fakeRecordingsDir();
    let cur = pad();
    for (let n = 1; n <= 5; n++) {
      const out = normalize(cur);
      const wav = encodeWav(out.left, out.right, RATE, 24);
      dir.save(`Edit 14.03.${String(20 + n).padStart(2, '0')}.wav`, wav);
      cur = decodeWav24(wav);
    }
    const antes = dir.stats();
    expect(antes.files).toBe(5);
    // 5 × (44 + 30·48000·2·3) = 43 200 220 B ≈ 41,2 MiB que no se van nunca.
    expect(antes.bytes).toBe(5 * (44 + SECONDS * RATE * 2 * 3));
    expect(antes.bytes).toBe(43_200_220);
  });
});

// ── 2. La medida: los mismos cinco Normalizar, con el nombre por contenido ──

describe('cinco Normalizar sobre un clip de 30 s: el disco antes y después', () => {
  it('cinco archivos / 43 200 220 B pasan a uno / 8 640 044 B', async () => {
    vi.resetModules();
    const gc = await import('../src/state/sample-gc');
    gc.forgetRecordingLedger();

    const dir = fakeRecordingsDir();
    let cur = pad();
    const paths: string[] = [];
    for (let n = 1; n <= 5; n++) {
      // Exactamente el orden de `runOp`: hash → nombre por contenido → save →
      // anotación → (registro del sample, que aquí no hace falta medir).
      const out = normalize(cur);
      const wav = encodeWav(out.left, out.right, RATE, 24);
      const hash = sha1(wav);
      const file = dir.save(`Normalizar ${hash}.wav`, wav);
      const path = `recording:${file}`;
      gc.noteRecordingWritten({ sampleId: `edit-${n}`, path, bytes: wav.byteLength });
      paths.push(path);
      cur = decodeWav24(wav);
    }

    const despues = dir.stats();
    // Normalizar deja el pico en 0,97; a partir del segundo la ganancia es 1 y
    // el WAV sale byte a byte idéntico, así que los cinco nombres son el mismo.
    expect(new Set(paths).size).toBe(1);
    expect(despues.files).toBe(1);
    expect(despues.bytes).toBe(44 + SECONDS * RATE * 2 * 3);
    expect(despues.bytes).toBe(8_640_044);
    // El mismo 80 % de recorte que la medida en memoria, en disco.
    expect(despues.bytes).toBe(43_200_220 / 5);

    // Y el contador que lo dice sin deducirlo, igual que `uiAudioCacheStats()`.
    expect(gc.recordingLedgerStats()).toEqual({ files: 1, bytes: 8_640_044 });
    // Un archivo, cinco ids que lo nombran: la baja tendrá que exigirlos todos.
    expect(gc.recordingLedgerEntries()[0]!.sampleIds).toHaveLength(5);
    gc.forgetRecordingLedger();
  }, 30_000);

  it('la fórmula que se copió aquí es la que corre de verdad en el editor', () => {
    const file = readSource('editors/audio/AudioEditor.tsx');
    const at = file.indexOf("if (op === 'normalize')");
    expect(at).toBeGreaterThanOrEqual(0);
    const cuerpo = file.slice(at, file.indexOf("} else if (op === 'reverse')", at));
    expect(cuerpo).toContain('const g = peak > 0 ? 0.97 / peak : 1;');
    expect(cuerpo).toMatch(/Math\.max\(Math\.abs\(left\[i\]!\), Math\.abs\(right\[i\]!\)\)/);
  });
});

// ── 3. La otra mitad: el barrido recupera lo que ya no puede volver ─────────

describe('cuando el historial ya no protege el archivo, el disco vuelve', () => {
  it('el barrido lo baja a la papelera y el hueco se ve en bytes', async () => {
    vi.resetModules();
    const gc = await import('../src/state/sample-gc');
    gc.forgetRecordingLedger();

    const dir = fakeRecordingsDir();
    const store = new ProjectStore();
    const wav = encodeWav(new Float32Array(RATE), new Float32Array(RATE), RATE, 24);
    const file = dir.save(`Normalizar ${sha1(wav)}.wav`, wav);
    const path = `recording:${file}`;
    gc.noteRecordingWritten({ sampleId: 'edit-1', path, bytes: wav.byteLength });
    store.dispatch({
      type: 'registerSample',
      sample: { id: 'edit-1', name: 'edit', path, hash: sha1(wav), duration: 1 },
    });

    const deps = () => ({
      project: store.project,
      unreachableIds: (ids: Iterable<string>) => store.unreachableIds(ids),
    });
    const antes = dir.stats();

    // Mientras el proyecto lo nombre, el barrido no toca nada. Ni un byte.
    const primero = await gc.sweepRecordingFiles(deps(), dir);
    expect(primero.discarded).toEqual([]);
    expect(dir.stats()).toEqual(antes);

    // Se desregistra y se envejece el historial hasta que la entrada se cae del
    // tope de 500: recién ahí no hay forma de volver.
    store.dispatch({ type: 'unregisterSample', sampleId: 'edit-1' }, { origin: 'gc' });
    for (let i = 0; i < 501; i++) store.dispatch({ type: 'setTempo', tempo: 90 + (i % 40) });

    const segundo = await gc.sweepRecordingFiles(deps(), dir);
    expect(segundo.sent).toBe(true);
    expect(segundo.discarded).toEqual([file]);
    expect(dir.stats()).toEqual({ files: 0, bytes: 0 });
    expect(antes.bytes - dir.stats().bytes).toBe(wav.byteLength);

    // Y no se borró: la baja es reversible durante su retención, que es el
    // contrato de `discard`. Un `unlink` aquí sería otra política.
    expect(dir.papelera.get(file)).toBeDefined();
    gc.forgetRecordingLedger();
  }, 30_000);
});
