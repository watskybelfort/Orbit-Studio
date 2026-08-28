/**
 * Biblioteca de plantillas de proyecto: el rack montado, las pistas de mixer
 * nombradas y el mixer enrutado, listos al arrancar en vez de un proyecto
 * vacío. Encaja sobre lo que YA existe — el `.orbit` es JSON versionado con
 * los samples referenciados por hash (ver `@orbit/core`'s `format.ts`) —, no
 * es un formato nuevo: una plantilla ES un `.orbit`, guardado con un nombre.
 *
 * Dos orígenes, un mismo tipo (`StoredTemplate`):
 * - De fábrica: las de `PROJECT_TEMPLATES` en `@orbit/core`'s
 *   `model/templates.ts` (trap, boom bap, reggaetón, voz sobre beat) — que ya
 *   existían y ya las usaba el menú Archivo (`shell/MenuBar.tsx`) por su
 *   propio lado, procedural. NO se congelan en un archivo aparte (eso
 *   duplicaría la fuente y las dos copias divergirían en cuanto alguien tocara
 *   una): `factoryStoredTemplate()` genera el `.orbit` en el momento, desde
 *   `createProjectFromTemplate(id)` — el mismo generador, la misma llamada que
 *   hace MenuBar. Una plantilla de fábrica es síntesis en vivo del motor (808,
 *   batería, Nova), sin ni un sample, así que abre y suena en cualquier
 *   máquina.
 * - Del usuario: "Guardar como plantilla" del proyecto actual. Persisten en
 *   settings.json (mismo mecanismo que favoritos/colecciones del Browser, ver
 *   `browser/library-prefs.ts`); fuera de Electron caen a `localStorage`.
 *
 * Dos puntos de entrada, un solo mecanismo: la rama "Plantillas" del Browser
 * (`browser/Browser.tsx`) y el submenú "Nuevo desde plantilla" de
 * `shell/MenuBar.tsx` leen ambos de `allTemplates()` e instancian con
 * `instantiateTemplate`/`newProjectFromStoredTemplate` — no hay ya un camino
 * procedural aparte.
 */

import {
  createProjectFromTemplate,
  newId,
  parseProject,
  PROJECT_TEMPLATES,
  serializeProject,
  type Project,
  type SampleRef,
} from '@orbit/core';
import { create } from 'zustand';

const SETTINGS_KEY = 'projectTemplates';
/** Espejo en localStorage cuando no hay puente de Electron (mismo patrón que library-prefs.ts). */
const LS_KEY = 'orbit.templates';
/** Prefijo del id de una StoredTemplate de fábrica; el resto es el id de core. */
const FACTORY_PREFIX = 'factory:';

export interface StoredTemplate {
  id: string;
  name: string;
  description: string;
  tempo: number;
  /** De fábrica: no se puede borrar ni se guarda en settings.json (ya viene en el bundle). */
  factory: boolean;
  /** El .orbit serializado. Se parsea solo al instanciar, nunca antes de tiempo. */
  json: string;
}

interface TemplatesState {
  userTemplates: StoredTemplate[];
  /** Ya se leyeron de disco (evita pisar con la lista vacía inicial). */
  loaded: boolean;
}

export const useTemplates = create<TemplatesState>(() => ({
  userTemplates: [],
  loaded: false,
}));

// ── De fábrica: SIEMPRE derivadas de core, nunca congeladas ────────────────

/**
 * Una de `PROJECT_TEMPLATES` (core), envuelta como StoredTemplate. Se genera
 * en el momento —`createProjectFromTemplate` de nuevo, no una copia guardada—
 * así que si alguien edita `model/templates.ts` esto lo refleja en el acto,
 * en el Browser y en el menú Archivo por igual. Cuatro plantillas, unos pocos
 * canales cada una: recalcularlas en cada listado no pesa nada.
 */
function factoryStoredTemplate(id: string): StoredTemplate {
  const meta = PROJECT_TEMPLATES.find((t) => t.id === id)!;
  return {
    id: `${FACTORY_PREFIX}${id}`,
    name: meta.name,
    description: meta.description,
    tempo: meta.tempo,
    factory: true,
    json: serializeProject(createProjectFromTemplate(id)),
  };
}

/** Las de fábrica, en el mismo orden en que las declara core. */
function factoryStoredTemplates(): StoredTemplate[] {
  return PROJECT_TEMPLATES.map((t) => factoryStoredTemplate(t.id));
}

/** De fábrica primero (son las que enseñan qué hace la función), luego las del usuario por nombre. */
export function allTemplates(): StoredTemplate[] {
  const user = [...useTemplates.getState().userTemplates].sort((a, b) => a.name.localeCompare(b.name));
  return [...factoryStoredTemplates(), ...user];
}

export function findStoredTemplate(id: string): StoredTemplate | undefined {
  return allTemplates().find((t) => t.id === id);
}

// ── Persistencia (settings.json, con espejo en localStorage) ───────────────

function isStoredTemplateLike(v: unknown): v is StoredTemplate {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r['id'] === 'string' &&
    typeof r['name'] === 'string' &&
    typeof r['json'] === 'string' &&
    typeof r['tempo'] === 'number'
  );
}

/** Una entrada leída de disco, saneada (settings.json se puede haber tocado a mano). */
function sanitize(v: StoredTemplate): StoredTemplate {
  return {
    id: v.id,
    name: v.name,
    description: typeof v.description === 'string' ? v.description : '',
    tempo: typeof v.tempo === 'number' && v.tempo > 0 ? v.tempo : 120,
    factory: false, // una plantilla de fábrica nunca vive en settings.json
    json: v.json,
  };
}

function readLocal(): StoredTemplate[] {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isStoredTemplateLike).map(sanitize) : [];
  } catch {
    return [];
  }
}

function writeLocal(list: StoredTemplate[]): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // cuota llena o storage bloqueado: se queda en memoria
  }
}

function persist(list: StoredTemplate[]): void {
  const api = window.orbit;
  if (api) void api.settings.set({ [SETTINGS_KEY]: list }).catch(() => writeLocal(list));
  else writeLocal(list);
}

/** Carga las plantillas del usuario al store (una vez, al montar el Browser). */
export async function loadUserTemplates(): Promise<void> {
  if (useTemplates.getState().loaded) return;
  let raw: unknown;
  try {
    const settings = await window.orbit?.settings.get();
    raw = settings ? settings[SETTINGS_KEY] : undefined;
  } catch {
    raw = undefined;
  }
  const list = Array.isArray(raw) ? raw.filter(isStoredTemplateLike).map(sanitize) : readLocal();
  useTemplates.setState({ userTemplates: list, loaded: true });
}

// ── Guardar y crear (puro: nada de esto toca window ni el store de arriba) ──

/**
 * Plantilla nueva a partir de un proyecto: el `.orbit` entero, serializado
 * tal cual. No hay nada de una "sesión" que limpiar aquí dentro — `meta` no
 * lleva rutas ni ids de máquina — así que el saneo de verdad pasa en
 * `instantiateTemplate`, al otro lado del viaje.
 */
export function buildTemplateFromProject(
  project: Project,
  name: string,
  description = '',
): StoredTemplate {
  return {
    id: newId(),
    name,
    description,
    tempo: project.tempo,
    factory: false,
    json: serializeProject(project),
  };
}

export function saveCurrentProjectAsTemplate(
  project: Project,
  name: string,
  description = '',
): StoredTemplate {
  const template = buildTemplateFromProject(project, name, description);
  const next = [...useTemplates.getState().userTemplates, template];
  useTemplates.setState({ userTemplates: next });
  persist(next);
  return template;
}

export function deleteUserTemplate(id: string): void {
  const next = useTemplates.getState().userTemplates.filter((t) => t.id !== id);
  if (next.length === useTemplates.getState().userTemplates.length) return;
  useTemplates.setState({ userTemplates: next });
  persist(next);
}

/**
 * El proyecto de una plantilla, listo para ser EL proyecto activo.
 *
 * `id` se regenera SIEMPRE: si se reutilizara el que trae el `.orbit` de la
 * plantilla, dos canciones nacidas de la misma plantilla compartirían la
 * carpeta de versiones (`userData/versions/<id del proyecto>/`, ver
 * `state/versions.ts`) y la historia de la una se mezclaría con la de la
 * otra — el mismo bicho, dos veces, cada vez que alguien use la plantilla dos
 * veces. `meta` también se resetea: una plantilla es un punto de partida, no
 * siempre el título de la canción de la que se guardó.
 *
 * Lo que NO se toca es el resto de ids internos (canales, patrones, pistas):
 * son válidos DENTRO del proyecto nada más, igual que al abrir el mismo
 * .orbit dos veces o al hacer "Guardar como" a un archivo nuevo — ninguno de
 * esos caminos los regenera hoy, y esta ruta se comporta igual.
 */
export function instantiateTemplate(template: StoredTemplate): Project {
  const project = parseProject(template.json);
  project.id = newId();
  project.meta = { title: template.name, author: '', comments: '' };
  return project;
}

/**
 * Samples que la plantilla necesita y que NO son del pack de fábrica
 * (`factory:`): carpetas del usuario, packs generados o grabaciones. Una
 * plantilla de fábrica siempre da la lista vacía (no carga ni un sample); una
 * guardada desde un proyecto con audio importado puede no.
 *
 * Sirve para dos cosas: avisar al GUARDAR ("esta plantilla no va a sonar
 * igual en otra máquina") y, del otro lado, para explicar qué faltó después
 * de intentar cargarlos de verdad (`browser/sound-actions.ts`'s
 * `rehydrateSamples`, que es quien sabe si el archivo se pudo leer o no).
 */
export function externalSamples(project: Project): SampleRef[] {
  return Object.values(project.samples).filter((s) => !s.path.startsWith('factory:'));
}

// ── Los avisos, aparte de cómo se supieron ──────────────────────────────────
//
// Mismo reparto que `describeKeymapDrop` en `browser/sound-actions.ts`: QUÉ
// decir es puro y se prueba solo; CÓMO se supo (leer bytes de disco, de
// verdad) necesita el puente de Electron y vive en `project-file.ts`.

/** Tras cargar: si `missing` no está vacío, dice CUÁLES en vez de abrir mudo. */
export function describeTemplateLoad(name: string, missing: readonly SampleRef[]): string {
  if (missing.length === 0) return `Plantilla "${name}" cargada.`;
  const names = missing.map((s) => s.name).join(', ');
  return (
    `Plantilla "${name}" cargada, pero falta${missing.length === 1 ? '' : 'n'} ` +
    `${missing.length} sonido${missing.length === 1 ? '' : 's'} en este equipo: ${names}.`
  );
}

/** Al guardar: avisa si la plantilla no va a sonar sola en otra máquina. */
export function describeTemplateSave(name: string, external: readonly SampleRef[]): string {
  if (external.length === 0) return `Plantilla "${name}" guardada.`;
  const names = external.map((s) => s.name).join(', ');
  return (
    `Plantilla "${name}" guardada. Usa ${external.length} sonido(s) que no son del pack de ` +
    `fábrica (${names}): solo se oirán enteros en equipos que ya los tengan.`
  );
}
