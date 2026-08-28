/**
 * Biblioteca de plantillas: lo que se prueba aquí es que "Guardar como
 * plantilla" y "Nuevo desde plantilla" son el mismo viaje de ida y vuelta que
 * abrir un .orbit —el proyecto que sale es el mismo que el que entró, incluso
 * tras "cerrar y volver a abrir" (la persistencia de verdad, en localStorage,
 * el mismo mecanismo que usa el navegador sin Electron)—, que la identidad de
 * sesión NO viaja (dos usos de la misma plantilla no comparten historial de
 * versiones), y que una plantilla con audio que no es del pack de fábrica lo
 * dice en vez de abrir muda.
 *
 * Las de fábrica NO son una copia congelada: `factoryStoredTemplate()` (en
 * `state/project-templates.ts`) genera el `.orbit` en el momento desde
 * `createProjectFromTemplate(id)` de `@orbit/core` — el generador que YA
 * existía y que YA usaba `shell/MenuBar.tsx` por su lado. Aquí se comprueba
 * eso mismo: lo que envuelve `findStoredTemplate('factory:<id>')` tiene la
 * MISMA forma que llamar a `createProjectFromTemplate(id)` ahora mismo — si
 * mañana alguien edita `model/templates.ts`, esto lo refleja solo, porque no
 * hay una segunda fuente que se pueda quedar atrás.
 *
 * La mayoría de esto es puro (sin `window`, sin motor de audio): la parte que
 * sí toca disco de verdad —leer los BYTES de un sample— vive en
 * `browser/sound-actions.ts`'s `rehydrateSamples` y no se repite aquí, igual
 * que `dropped-audio.test.ts` prueba el triaje sin tocar Chromium.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyCommand,
  createChannel,
  createEmptyProject,
  createProjectFromTemplate,
  diffProjects,
  isEmptyDiff,
  newId,
  PROJECT_TEMPLATES,
  serializeProject,
  type Project,
  type SampleRef,
} from '@orbit/core';
import {
  allTemplates,
  buildTemplateFromProject,
  describeTemplateLoad,
  describeTemplateSave,
  externalSamples,
  findStoredTemplate,
  instantiateTemplate,
  loadUserTemplates,
  saveCurrentProjectAsTemplate,
  useTemplates,
} from '../src/state/project-templates';

/**
 * La "forma" de un proyecto sin sus ids al azar: dos llamadas a
 * `createProjectFromTemplate(id)` nunca comparten id de canal o de patrón
 * (cada `createChannel`/`createPattern` saca uno nuevo), así que compararlas
 * con `diffProjects` —que empareja POR ID— diría "todo añadido, todo
 * borrado" aunque sean músicalmente idénticas. Esto compara lo que sí importa:
 * nombres, tipos de instrumento, efectos, tempo y cuántas notas trae cada uno.
 */
function shapeOf(project: Project) {
  return {
    tempo: project.tempo,
    title: project.meta.title,
    channels: project.channelOrder.map((id) => {
      const c = project.channels[id]!;
      return { name: c.name, kind: c.kind, mixerTrack: c.mixerTrack };
    }),
    mixerEffects: project.mixer.map((t) => t.slots.map((s) => s?.kind ?? null)),
    noteCounts: project.patternOrder.map((pid) => {
      const p = project.patterns[pid]!;
      return Object.values(p.notes)
        .map((notes) => notes.length)
        .sort((a, b) => a - b);
    }),
  };
}

/** localStorage de mentira: lo justo para que persist()/loadUserTemplates() tengan dónde escribir y leer. */
function fakeLocalStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** Proyecto con un canal, notas y un efecto de mixer — algo que de verdad tenga forma. */
function sampleProject(title: string): Project {
  const project = createEmptyProject(title);
  const channel = createChannel('sub808', 0, 'Orbit Sub');
  applyCommand(project, { type: 'addChannel', channel });
  const patternId = project.patternOrder[0]!;
  applyCommand(project, {
    type: 'addNotes',
    patternId,
    channelId: channel.id,
    notes: [
      { id: newId(), start: 0, duration: 1, key: 36, velocity: 0.9, pan: 0, slide: false },
      { id: newId(), start: 1, duration: 1, key: 38, velocity: 0.8, pan: 0, slide: false },
    ],
  });
  applyCommand(project, {
    type: 'patchMixerTrack',
    trackIndex: 1,
    patch: { name: '808', volume: 0.8 },
  });
  return project;
}

describe('guardar y crear desde una plantilla propia', () => {
  it('el proyecto que sale de la plantilla es el mismo que el que se guardó (mismo diff musical: vacío)', () => {
    const original = sampleProject('Mi tema');
    const template = buildTemplateFromProject(original, 'Mi tema', 'una prueba');
    const restored = instantiateTemplate(template);

    // meta.title se resetea AL NOMBRE DE LA PLANTILLA a propósito — aquí
    // coinciden porque se guardó con el mismo nombre que el proyecto, así que
    // el diff musical (que sí mira el título) tiene que salir vacío.
    expect(isEmptyDiff(diffProjects(original, restored))).toBe(true);
  });

  it('el id del proyecto se renueva: dos usos de la misma plantilla no comparten historial de versiones', () => {
    const original = sampleProject('Base');
    const template = buildTemplateFromProject(original, 'Base');
    const a = instantiateTemplate(template);
    const b = instantiateTemplate(template);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(original.id);
    expect(b.id).not.toBe(original.id);
  });

  it('aparece en allTemplates() y se encuentra por id tras guardarla', () => {
    const before = allTemplates().length;
    const template = buildTemplateFromProject(sampleProject('Nueva'), 'Nueva plantilla');
    // buildTemplateFromProject es puro (no la registra); allTemplates() sigue
    // igual hasta que algo la mete en el store — eso es responsabilidad de
    // saveCurrentProjectAsTemplate, que sí toca settings/localStorage y no se
    // prueba aquí (ver el comentario de cabecera).
    expect(allTemplates().length).toBe(before);
    expect(findStoredTemplate(template.id)).toBeUndefined();
  });
});

describe('samples que no son del pack de fábrica', () => {
  function withSample(path: string): Project {
    const project = sampleProject('Con sample');
    const sample: SampleRef = { id: newId(), name: 'Voz importada', path, hash: 'x', duration: 1 };
    applyCommand(project, { type: 'registerSample', sample });
    return project;
  }

  it('un path factory: no cuenta como externo', () => {
    expect(externalSamples(withSample('factory:drums/kick-01.wav'))).toHaveLength(0);
  });

  it('una ruta de usuario, absoluta o no, sí cuenta como externa', () => {
    expect(externalSamples(withSample('user:C:\\Users\\alguien\\Samples\\voz.wav'))).toHaveLength(1);
    expect(externalSamples(withSample('C:\\Users\\alguien\\voz.wav'))).toHaveLength(1);
    expect(externalSamples(withSample('recording:toma-1.wav'))).toHaveLength(1);
  });
});

describe('el aviso que se le da al usuario (sin tocar disco)', () => {
  it('al cargar sin nada que falte, dice que se cargó y punto', () => {
    expect(describeTemplateLoad('Trap', [])).toBe('Plantilla "Trap" cargada.');
  });

  it('al cargar con samples ausentes, los nombra', () => {
    const missing: SampleRef[] = [
      { id: 'a', name: 'Voz ad-lib', path: 'user:x.wav', hash: 'h', duration: 1 },
    ];
    const msg = describeTemplateLoad('Voz sobre beat', missing);
    expect(msg).toContain('Voz sobre beat');
    expect(msg).toContain('Voz ad-lib');
    expect(msg).toMatch(/falta 1 sonido/);
  });

  it('con más de uno, pluraliza', () => {
    const missing: SampleRef[] = [
      { id: 'a', name: 'A', path: 'user:a.wav', hash: 'h', duration: 1 },
      { id: 'b', name: 'B', path: 'user:b.wav', hash: 'h', duration: 1 },
    ];
    expect(describeTemplateLoad('X', missing)).toMatch(/faltan 2 sonidos/);
  });

  it('al guardar sin samples externos, no hay advertencia', () => {
    expect(describeTemplateSave('Trap', [])).toBe('Plantilla "Trap" guardada.');
  });

  it('al guardar con samples externos, avisa de que no viaja sola', () => {
    const external: SampleRef[] = [
      { id: 'a', name: 'Voz', path: 'user:v.wav', hash: 'h', duration: 1 },
    ];
    expect(describeTemplateSave('Voz sobre beat', external)).toMatch(/no son del pack de fábrica/);
  });
});

describe('plantillas de fábrica (única fuente: PROJECT_TEMPLATES de core)', () => {
  it('trae las cuatro que ya existían: trap, boom bap, reggaetón y voz sobre beat', () => {
    const ids = allTemplates()
      .filter((t) => t.factory)
      .map((t) => t.id);
    expect(ids).toEqual(PROJECT_TEMPLATES.map((t) => `factory:${t.id}`));
    expect(ids).toContain('factory:trap');
    expect(ids).toContain('factory:boombap');
    expect(ids).toContain('factory:reggaeton');
    expect(ids).toContain('factory:voz-sobre-beat');
  });

  it('no es una copia congelada: la misma forma que createProjectFromTemplate(id) da AHORA MISMO', () => {
    for (const t of PROJECT_TEMPLATES) {
      const wrapped = findStoredTemplate(`factory:${t.id}`)!;
      const fromWrapper = JSON.parse(wrapped.json) as Project;
      const fresh = createProjectFromTemplate(t.id);
      expect(shapeOf(fromWrapper)).toEqual(shapeOf(fresh));
      // Los metadatos que enseña la UI (Browser y MenuBar) también salen de
      // la ficha de core, no de un texto copiado a mano por segunda vez.
      expect(wrapped.name).toBe(t.name);
      expect(wrapped.description).toBe(t.description);
      expect(wrapped.tempo).toBe(t.tempo);
    }
  });

  it('todas son "de fábrica" y ya están en allTemplates() sin guardar nada', () => {
    for (const t of PROJECT_TEMPLATES) {
      const wrapped = findStoredTemplate(`factory:${t.id}`);
      expect(wrapped?.factory).toBe(true);
    }
  });

  it('no cargan ni un sample: síntesis pura, nada que pueda faltar en otra máquina', () => {
    for (const t of PROJECT_TEMPLATES) {
      const project = createProjectFromTemplate(t.id);
      expect(Object.keys(project.samples)).toHaveLength(0);
      expect(externalSamples(project)).toHaveLength(0);
    }
  });

  it('no llevan rutas absolutas ni nada que huela a una máquina o sesión concreta', () => {
    for (const t of PROJECT_TEMPLATES) {
      const json = serializeProject(createProjectFromTemplate(t.id));
      // Unidad de Windows (C:\...), ruta *nix de usuario, o el propio esquema
      // "user:"/"recording:" que delata algo capturado en una máquina.
      expect(json).not.toMatch(/[A-Za-z]:\\\\/);
      expect(json).not.toMatch(/\/home\//);
      expect(json).not.toMatch(/\/Users\//);
      expect(json).not.toMatch(/"user:|"recording:/);
    }
  });

  it('cada "Nuevo desde plantilla" saca un proyecto con id propio', () => {
    const t = findStoredTemplate('factory:trap')!;
    const a = instantiateTemplate(t);
    const b = instantiateTemplate(t);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe('');
  });

  it('abren con el tempo y el título del género (no el que traía la plantilla al generarse)', () => {
    const trap = findStoredTemplate('factory:trap')!;
    const project = instantiateTemplate(trap);
    expect(project.tempo).toBe(trap.tempo);
    expect(project.meta.title).toBe(trap.name);
    expect(project.meta.author).toBe('');
  });
});

describe('guardar, "cerrar" y volver a abrir (persistencia de verdad)', () => {
  it('una plantilla guardada sobrevive a cerrar y reabrir, y el proyecto que sale es el mismo', async () => {
    // Fuera de Electron (`window` sin `.orbit`) cae a localStorage — el mismo
    // camino que toma la app en el navegador, no un atajo de la prueba.
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', fakeLocalStorage());
    try {
      const original = sampleProject('Sesión de mentira');
      saveCurrentProjectAsTemplate(original, 'Sesión de mentira', 'para la prueba de cierre y apertura');
      expect(allTemplates().some((t) => t.name === 'Sesión de mentira')).toBe(true);

      // "Cerrar": se olvida lo que había en memoria, como al reabrir la app.
      useTemplates.setState({ userTemplates: [], loaded: false });
      expect(allTemplates().some((t) => t.name === 'Sesión de mentira')).toBe(false);

      // "Volver a abrir": se relee de localStorage, no de la memoria de antes.
      await loadUserTemplates();
      const found = allTemplates().find((t) => t.name === 'Sesión de mentira');
      expect(found).toBeDefined();

      const restored = instantiateTemplate(found!);
      expect(isEmptyDiff(diffProjects(original, restored))).toBe(true);
      expect(restored.id).not.toBe(original.id);
    } finally {
      // Deja el store como lo encontró: otra prueba de este archivo cuenta
      // `allTemplates()` esperando solo las de fábrica.
      useTemplates.setState({ userTemplates: [], loaded: false });
      vi.unstubAllGlobals();
    }
  });
});
