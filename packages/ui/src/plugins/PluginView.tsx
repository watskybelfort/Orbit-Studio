/**
 * La vista de un plugin dentro de la UI de Orbit.
 *
 * Este componente es el DUEÑO del canvas — y el plugin no lo ve nunca. Lo que
 * hace, cada vuelta del `requestAnimationFrame`:
 *
 *   1. rellena el buffer de entrada con lo que la UI ya tenía delante (los
 *      valores de las perillas, y si la vista lo pidió, el nivel y el espectro
 *      del tap del kernel — ver `view-input.ts`: del hilo de audio no cruza
 *      nada nuevo),
 *   2. se lo manda al worker por transferencia,
 *   3. cuando el worker devuelve la lista de dibujo, la relee validando cada
 *      número y la repinta él mismo (`view-replay.ts`).
 *
 * El plugin, al otro lado, solo ha visto floats.
 *
 * El bucle de rAF también es el latido del watchdog: como el plugin se cuelga
 * en SU hilo, este sigue vivo y llega a decidir que el otro no contesta.
 */

import { useEffect, useRef, useState } from 'react';
import { engine, store } from '../state/app';
import { useUiStore } from '../state/ui';
import { acquireScopeTracked, isScopeTrackActive } from '../state/scope-track';
import { SpectrumAnalyzer } from '../scope/spectrum';
import type { ParsedView } from '../state/plugin-parse';
import { fillViewInput, levelOfFrame } from './view-input';
import { replayDisplayList, type Canvas2DLike } from './view-replay';
import { CANVAS_FALLBACK_INK, CANVAS_FALLBACK_MUTED } from '../theme/palette';
import { PALETTE_VARS, VIEW_MAX_HEIGHT, VIEW_MIN_HEIGHT } from './view-protocol';
import { PluginViewSession, type DeathReason, type ViewPort } from './view-session';
import './plugin-view.css';

export interface PluginViewProps {
  /** Id del plugin (para recuperar su fuente del registro). */
  pluginId: string;
  /** Código del plugin. Cruza al worker como TEXTO y se compila allí. */
  source: string;
  /** Declaración de la vista, ya saneada por el parser. */
  view: ParsedView;
  /** Claves de las perillas, en orden: define el orden en el que van sus valores. */
  paramKeys: readonly string[];
  /** Defaults por clave, para cuando el slot aún no guardó un valor. */
  defaults: Readonly<Record<string, number>>;
  /**
   * De dónde salen los valores en vivo. Se lee en cada frame (no por props)
   * para que mover una perilla mueva la curva en el MISMO frame, igual que
   * hace el analizador del EQ.
   */
  readParams: () => Readonly<Record<string, number>>;
  /**
   * Pista del mixer cuyo tap alimenta nivel/espectro. Si la vista no pide
   * ninguno de los dos, no se pide el tap (es un recurso único y compartido).
   */
  trackIndex?: number;
}

/** Motivo → lo que lee el usuario cuando su vista se apaga. */
const DEATH_TEXT: Record<DeathReason, string> = {
  timeout: 'La vista del plugin se colgó y se apagó. El audio sigue sonando.',
  budget: 'La vista del plugin consumía demasiado y se apagó. El audio sigue sonando.',
  error: 'La vista del plugin falló y se apagó. El audio sigue sonando.',
  worker: 'La vista del plugin no pudo arrancar.',
  disposed: '',
};

/** ¿Se pueden crear workers aquí? (En Node/tests, no.) */
function canUseWorker(): boolean {
  return typeof Worker !== 'undefined';
}

export function PluginView({
  pluginId,
  source,
  view,
  paramKeys,
  defaults,
  readParams,
  trackIndex,
}: PluginViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [death, setDeath] = useState<{ reason: DeathReason; detail: string } | null>(null);

  // Los valores se leen en cada frame por esta referencia, no por la props
  // capturada al montar: así mover una perilla mueve el dibujo en el mismo
  // frame sin reiniciar el worker en cada render.
  const readRef = useRef(readParams);
  readRef.current = readParams;
  // Mismo motivo para las claves y los defaults: el llamante puede calcularlos
  // en línea, y una identidad nueva por render no puede recompilar el plugin.
  const keysRef = useRef(paramKeys);
  keysRef.current = paramKeys;
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  const wantsTap = view.needs.level || view.needs.spectrum;
  const height = Math.min(VIEW_MAX_HEIGHT, Math.max(VIEW_MIN_HEIGHT, view.height));

  useEffect(() => {
    setDeath(null);
    if (!canUseWorker()) return;

    // Sin canvas montado no hay nada que arrancar (ni worker que crear).
    if (!canvasRef.current) return;

    // El tap del kernel es uno y se comparte (Orbit Scope, EQ, analizador de
    // pista). Solo se pide si la vista declaró que quiere señal.
    const releaseScope =
      wantsTap && trackIndex !== undefined ? acquireScopeTracked(trackIndex) : null;

    const worker = new Worker(new URL('./plugin-view-worker.ts', import.meta.url), {
      type: 'module',
    });

    // Buffers de trabajo del host: preasignados una vez, reutilizados siempre.
    const level = new Float32Array(2);
    const palette: string[] = PALETTE_VARS.map(() => CANVAS_FALLBACK_INK);
    const spectrum = view.needs.spectrum ? new SpectrumAnalyzer() : null;

    const port: ViewPort = {
      post: (message, transfer) => {
        if (transfer && transfer.length > 0) worker.postMessage(message, transfer);
        else worker.postMessage(message);
      },
      terminate: () => worker.terminate(),
    };

    const session = new PluginViewSession({
      port,
      source,
      paramKeys: keysRef.current,
      labelCount: view.labels.length,
      sampleRate: engine.sampleRate,
      fps: view.fps,
      onDraw: (list, len) => {
        const cv = canvasRef.current;
        const wrap = wrapRef.current;
        if (!cv || !wrap) return;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        const w = wrap.clientWidth;
        const h = wrap.clientHeight;
        if (w === 0 || h === 0) return;
        const css = getComputedStyle(cv);
        for (let i = 0; i < PALETTE_VARS.length; i++) {
          palette[i] = css.getPropertyValue(PALETTE_VARS[i]!).trim() || CANVAS_FALLBACK_MUTED;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        const dpr = window.devicePixelRatio || 1;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, w, h);
        // El repintado lo hace el HOST: la lista es solo datos, y aquí se
        // valida cada número antes de convertirlo en un píxel.
        replayDisplayList(ctx as unknown as Canvas2DLike, list, len, {
          width: w,
          height: h,
          palette,
          labels: view.labels,
          font: `10px ${css.fontFamily}`,
        });
      },
      onDeath: (reason, detail) => {
        if (reason !== 'disposed') setDeath({ reason, detail });
      },
    });

    worker.addEventListener('message', (e: MessageEvent<unknown>) => {
      session.handleMessage(e.data, performance.now());
    });
    worker.addEventListener('error', (e) => {
      session.handleWorkerError(e.message || 'Error del worker de la vista');
    });
    worker.addEventListener('messageerror', () => {
      session.handleWorkerError('El worker de la vista mandó un mensaje ilegible');
    });

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const cv = canvasRef.current;
      const wrap = wrapRef.current;
      if (!cv || !wrap) return;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
      }

      // Esta llamada corre SIEMPRE, tenga o no que mandar frame: es la que le
      // da al watchdog la oportunidad de cazar un worker colgado.
      session.tick(performance.now(), (input) => {
        // El tap solo vale si esta pista es la que está viajando ahora mismo:
        // si otra vista se lo llevó, se manda nivel a cero en vez de el audio
        // de una pista ajena (mismo criterio que el EQ y el Orbit Scope).
        const owns = trackIndex !== undefined && isScopeTrackActive(trackIndex);
        const frame = owns ? useUiStore.getState().scopeFrame : null;
        if (view.needs.level) levelOfFrame(frame, level);
        if (spectrum && frame) spectrum.update(frame);
        fillViewInput(input, {
          aspect: h / Math.max(1, w),
          sampleRate: engine.sampleRate,
          paramKeys: keysRef.current,
          params: readRef.current(),
          defaults: defaultsRef.current,
          level: view.needs.level ? level : null,
          spectrumDb: spectrum ? spectrum.db : null,
        });
      });
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      session.dispose();
      releaseScope?.();
    };
    // Deliberadamente NO dependen de `readParams`/`defaults`: cambiar la
    // referencia de una función en un render no debe tirar y rearrancar el
    // worker (sería recompilar el plugin en cada tecla). Los valores en vivo
    // entran por `readRef`.
  }, [pluginId, source, view, trackIndex, wantsTap]);

  if (!canUseWorker()) return null;

  return (
    <div className="plugin-view" ref={wrapRef} style={{ height: `${height}px` }}>
      <canvas ref={canvasRef} />
      {death && (
        <div className="plugin-view-dead" role="status">
          <b>{DEATH_TEXT[death.reason]}</b>
          {death.detail !== '' && <span>{death.detail}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Envoltorio para un slot de efecto del mixer: saca la fuente del registro y
 * lee los params del slot en vivo desde el store.
 */
export function EffectPluginView({
  pluginId,
  source,
  view,
  paramKeys,
  defaults,
  trackIndex,
  slotIndex,
}: {
  pluginId: string;
  source: string;
  view: ParsedView;
  paramKeys: readonly string[];
  defaults: Readonly<Record<string, number>>;
  trackIndex: number;
  slotIndex: number;
}) {
  return (
    <PluginView
      pluginId={pluginId}
      source={source}
      view={view}
      paramKeys={paramKeys}
      defaults={defaults}
      // Del STORE, no de la props del slot: la automatización y los LFO mueven
      // los valores sin que este componente vuelva a renderizar, y la vista
      // tiene que seguirlos igual.
      readParams={() => store.project.mixer[trackIndex]?.slots[slotIndex]?.params ?? {}}
      trackIndex={trackIndex}
    />
  );
}

/**
 * Envoltorio para el INSTRUMENTO de un canal (Channel Rack): el plugin que
 * sustituye a la voz, no un insert de su cadena. Los valores salen de
 * `channel.params` directamente —el mismo sitio de donde los lee `SoundTab`
 * para sus perillas— y el tap del scope va por `trackIndex`, que quien monta
 * este componente tiene que resolver con la pista EFECTIVA del canal
 * (`trackOfChannel`, `@orbit/core`), no con `channel.mixerTrack` crudo: un
 * canal sin pista propia dentro de una carpeta con bus compila en el bus del
 * grupo, y pasarle el campo crudo aquí mediría el máster en vez del canal
 * (ver `ChannelRack.tsx`, que resuelve `effectiveTrack` con ese mismo
 * criterio antes de pasarlo).
 */
export function InstrumentPluginView({
  pluginId,
  source,
  view,
  paramKeys,
  defaults,
  channelId,
  trackIndex,
}: {
  pluginId: string;
  source: string;
  view: ParsedView;
  paramKeys: readonly string[];
  defaults: Readonly<Record<string, number>>;
  channelId: string;
  trackIndex?: number;
}) {
  return (
    <PluginView
      pluginId={pluginId}
      source={source}
      view={view}
      paramKeys={paramKeys}
      defaults={defaults}
      readParams={() => store.project.channels[channelId]?.params ?? {}}
      trackIndex={trackIndex}
    />
  );
}

/**
 * Envoltorio para un insert PROPIO de un canal (pestaña "Efectos" del Channel
 * Rack). Misma vista, otra procedencia de los valores; el tap del scope va por
 * la pista EFECTIVA del canal (`trackOfChannel`, `@orbit/core`), no por
 * `channel.mixerTrack` crudo: un canal sin pista propia dentro de una carpeta
 * con bus compila en el bus del grupo, y pasarle el campo crudo aquí mediría
 * el máster en vez de lo que sale de la cadena (ver `FxTab.tsx`, que resuelve
 * `effectiveTrack` con ese mismo criterio antes de pasarlo).
 */
export function ChannelPluginView({
  pluginId,
  source,
  view,
  paramKeys,
  defaults,
  channelId,
  slotIndex,
  trackIndex,
}: {
  pluginId: string;
  source: string;
  view: ParsedView;
  paramKeys: readonly string[];
  defaults: Readonly<Record<string, number>>;
  channelId: string;
  slotIndex: number;
  trackIndex?: number;
}) {
  return (
    <PluginView
      pluginId={pluginId}
      source={source}
      view={view}
      paramKeys={paramKeys}
      defaults={defaults}
      readParams={() => store.project.channels[channelId]?.fx?.[slotIndex]?.params ?? {}}
      trackIndex={trackIndex}
    />
  );
}
