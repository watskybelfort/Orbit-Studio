/** La búsqueda orienta por tarea y vocabulario cotidiano, también sin tildes. */
export const SETTINGS_SECTIONS = [
  { id: 'appearance', label: 'Apariencia', description: 'Color, tamaño y tipografía. Los cambios se aplican al instante.', keywords: 'tema oscuro claro acrílico transparencia tinte acento fuentes escala tamaño zoom radio esquinas personalizar importar exportar' },
  { id: 'workspace', label: 'Escritorio', description: 'Elige cómo se abren y se recuerdan tus ventanas.', keywords: 'espacio trabajo ventanas disposición recordar guardar restaurar semáforo mac windows botones enfoque compacto zen paneles' },
  { id: 'devices', label: 'Audio y MIDI', description: 'Configura tu micro, entradas de audio y controladores.', keywords: 'micrófono dispositivo grabación escuchar monitor ganancia rutas canales teclado midi velocidad curva pitch latencia calibración loopback cuantización mandos' },
  { id: 'plugins', label: 'Plugins', description: 'Conecta galerías para encontrar instrumentos y efectos.', keywords: 'galería complementos instrumentos efectos instalar fuentes confianza firma' },
  { id: 'updates', label: 'Actualizaciones', description: 'Decide si quieres recibir avisos de nuevas versiones.', keywords: 'actualizar versión release avisos novedades descargar' },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]['id'];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
}

export function findSettingsSections(query: string) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return SETTINGS_SECTIONS.filter((section) => {
    const text = normalize(`${section.label} ${section.description} ${section.keywords}`);
    return terms.every((term) => text.includes(term));
  });
}
