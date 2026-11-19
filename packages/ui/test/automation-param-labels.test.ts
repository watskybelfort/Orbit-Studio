/**
 * Los desplegables de "Nuevo clip de automatización" hablaban en clave.
 *
 * El valor de cada opción es la clave que el motor entiende
 * (`volume`, `stereoWidth`, `tempo`) y tiene que seguir siéndolo: cambiarla
 * rompería el clip y los tests de automatización. Lo que estaba mal era el
 * TEXTO visible: `stereoWidth` es vocabulario de código, no de mezcla. Este
 * test fija las dos mitades a la vez — etiqueta legible, clave intacta — para
 * que un refactor no arregle una y rompa la otra.
 *
 * Se lee el fuente en vez de montar el componente por la misma razón que
 * `mixtab-effective-track.test.ts`: sin jsdom, la propiedad que importa vive
 * entera en el JSX.
 */
import { describe, expect, it } from 'vitest';
import { readSource } from './read-source';

const file = readSource('editors/automation/AutomationEditor.tsx');

describe('Automatización: etiquetas legibles sin tocar la clave que viaja al motor', () => {
  it('traduce los parámetros de mixer a castellano', () => {
    expect(file).toMatch(/MIXER_PARAM_LABELS[\s\S]*volume:\s*'Volumen'/);
    expect(file).toMatch(/MIXER_PARAM_LABELS[\s\S]*pan:\s*'Paneo'/);
    expect(file).toMatch(/MIXER_PARAM_LABELS[\s\S]*stereoWidth:\s*'Anchura estéreo'/);
  });

  it('traduce el parámetro de transporte', () => {
    expect(file).toMatch(/TRANSPORT_PARAM_LABELS[\s\S]*tempo:\s*'Tempo'/);
  });

  it('el <option> pinta la etiqueta y conserva la clave cruda como value', () => {
    expect(file).toMatch(
      /\{MIXER_PARAMS\.map\(\(p\) => \(\s*<option key=\{p\} value=\{p\}>\{MIXER_PARAM_LABELS\[p\]\}<\/option>/,
    );
    expect(file).toMatch(
      /\{TRANSPORT_PARAMS\.map\(\(p\) => \(\s*<option key=\{p\} value=\{p\}>\{TRANSPORT_PARAM_LABELS\[p\]\}<\/option>/,
    );
  });

  it('no vuelve a enseñar la clave en crudo', () => {
    expect(file).not.toContain('>{p}</option>');
  });
});
