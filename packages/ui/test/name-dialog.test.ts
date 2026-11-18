import { beforeEach, describe, expect, it } from 'vitest';
import {
  askName,
  MAX_DIALOG_NAME_LENGTH,
  normalizeDialogName,
  useNameDialogStore,
} from '../src/shell/name-dialog';
import { readSource } from './read-source';

/**
 * La parte pura de `askName`/`normalizeDialogName` y el contrato de fuente de
 * los menús. Sin jsdom: el store de zustand se ejercita como estado puro y lo
 * que vive en el JSX se comprueba leyendo el archivo (convención del repo).
 */

describe('normalizeDialogName', () => {
  it('recorta los espacios de los extremos y conserva los de dentro', () => {
    expect(normalizeDialogName('  Mi layout  ')).toBe('Mi layout');
    expect(normalizeDialogName('Beat  de  trap')).toBe('Beat  de  trap');
  });

  it('vacío o solo espacios no es un nombre', () => {
    expect(normalizeDialogName('')).toBeNull();
    expect(normalizeDialogName('   ')).toBeNull();
    expect(normalizeDialogName('\n\t ')).toBeNull();
  });

  it('recorta al largo máximo en vez de rechazar el texto', () => {
    const long = 'x'.repeat(MAX_DIALOG_NAME_LENGTH + 20);
    const got = normalizeDialogName(long);
    expect(got).toHaveLength(MAX_DIALOG_NAME_LENGTH);
    expect(got).toBe('x'.repeat(MAX_DIALOG_NAME_LENGTH));
  });

  it('un valor que no es string no es un nombre', () => {
    expect(normalizeDialogName(undefined as unknown as string)).toBeNull();
    expect(normalizeDialogName(42 as unknown as string)).toBeNull();
  });
});

describe('askName: promesa imperativa sobre el store', () => {
  beforeEach(() => {
    // Cancela lo que haya quedado abierto de otra prueba (resuelve su promesa).
    useNameDialogStore.getState().cancel();
  });

  it('abre una petición y cancelar resuelve null', async () => {
    const pending = askName({ title: 'Guardar layout', initial: 'Mi layout' });
    const request = useNameDialogStore.getState().request;
    expect(request).toMatchObject({
      title: 'Guardar layout',
      label: 'Nombre',
      initial: 'Mi layout',
      confirmLabel: 'Guardar',
    });

    useNameDialogStore.getState().cancel();
    await expect(pending).resolves.toBeNull();
    expect(useNameDialogStore.getState().request).toBeNull();
  });

  it('gana la última: la petición anterior se resuelve null', async () => {
    const first = askName({ title: 'Primera' });
    const second = askName({ title: 'Segunda' });

    await expect(first).resolves.toBeNull();
    expect(useNameDialogStore.getState().request?.title).toBe('Segunda');

    expect(useNameDialogStore.getState().confirm('  Nombre nuevo  ')).toBeNull();
    await expect(second).resolves.toBe('Nombre nuevo');
  });

  it('valida el nombre YA normalizado y no cierra si devuelve error', async () => {
    const seen: string[] = [];
    const pending = askName({
      title: 'Con validación',
      initial: '  ab  ',
      validate: (name) => {
        seen.push(name);
        return name.length < 3 ? 'Mínimo tres letras.' : null;
      },
    });

    expect(useNameDialogStore.getState().confirm('  ab  ')).toBe('Mínimo tres letras.');
    expect(seen).toEqual(['ab']);
    expect(useNameDialogStore.getState().request).not.toBeNull();

    expect(useNameDialogStore.getState().confirm('   ')).toBe('Escribe un nombre.');
    expect(useNameDialogStore.getState().confirm('  abc  ')).toBeNull();
    await expect(pending).resolves.toBe('abc');
  });

  it('confirmar sin diálogo abierto devuelve un error y no resuelve nada', () => {
    expect(useNameDialogStore.getState().request).toBeNull();
    expect(useNameDialogStore.getState().confirm('x')).toContain('No hay ningún diálogo');
  });

  it('los valores por defecto se pueden pisar', async () => {
    const pending = askName({
      title: 'Título',
      label: 'Etiqueta propia',
      initial: 'Valor inicial',
      confirmLabel: 'Crear',
    });
    expect(useNameDialogStore.getState().request).toMatchObject({
      label: 'Etiqueta propia',
      initial: 'Valor inicial',
      confirmLabel: 'Crear',
    });
    useNameDialogStore.getState().cancel();
    await pending;
  });
});

describe('fuente: los menús ya no usan window.prompt', () => {
  it('MenuBar no contiene window.prompt y usa askName en sus dos sitios', () => {
    const src = readSource('shell/MenuBar.tsx');
    expect(src).not.toContain('window.prompt');
    expect(src).toContain('askName({');
    expect((src.match(/askName\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Mismos valores por defecto que tenía el prompt que se retiró.
    expect(src).toContain("initial: store.project.meta.title || 'Mi plantilla'");
    expect(src).toContain("initial: 'Mi layout'");
  });

  it('App monta un único NameDialogHost', () => {
    const src = readSource('App.tsx');
    expect(src).toContain('<NameDialogHost />');
    expect((src.match(/<NameDialogHost \/>/g) ?? []).length).toBe(1);
  });

  it('App monta el asa de cada panel y carga los anchos antes de la memoria', () => {
    const src = readSource('App.tsx');
    expect(src).toContain('<PanelSplitter side="browser" />');
    expect(src).toContain('<PanelSplitter side="claude" />');
    const load = src.indexOf('loadPanelWidths()');
    const init = src.indexOf('initWorkspaceMemory()');
    expect(load).toBeGreaterThan(-1);
    expect(init).toBeGreaterThan(load);
  });

  it('StudioNavigation ofrece guardar el escritorio aunque no haya layouts', () => {
    const src = readSource('shell/StudioNavigation.tsx');
    expect(src).toContain('Guardar el escritorio actual…');
    expect(src).toContain("value=\"save-desktop\"");
    // La opción va FUERA del optgroup condicionado por `listLayouts()`.
    const optionAt = src.indexOf('value="save-desktop"');
    const groupAt = src.indexOf('Guardados en el proyecto');
    expect(optionAt).toBeGreaterThan(groupAt);
    expect(src).toContain('saveLayout(name)');
    expect(src).toContain('Escritorio «');
    expect(src).toContain('» guardado en el proyecto.');
  });
});
