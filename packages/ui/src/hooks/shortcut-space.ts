/** Decisión pura: el transporte solo toma Espacio si el foco no tiene una
 * interacción propia. Sin instanceof: admite SVG, nodos de texto y elementos
 * de otra ventana. El widget sigue siendo responsable de su activación. */
interface ShortcutNode {
  tagName?: string;
  isContentEditable?: boolean;
  parentElement?: ShortcutNode | null;
  getAttribute?: (name: string) => string | null;
}

const NATIVE_CONTROLS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY', 'AUDIO', 'VIDEO']);
const WIDGET_ROLES = new Set([
  'button', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'textbox', 'searchbox', 'tree', 'treeitem', 'link',
]);

export function shouldHandleTransportSpace(event: {
  code: string;
  defaultPrevented: boolean;
  target: unknown;
}): boolean {
  if (event.code !== 'Space' || event.defaultPrevented) return false;
  let node = event.target && typeof event.target === 'object' ? event.target as ShortcutNode : null;
  let editable: boolean | undefined;
  for (; node; node = node.parentElement ?? null) {
    // La declaración más cercana manda: contenteditable=false puede crear
    // una zona de edición no textual dentro de un ancestro editable.
    if (editable === undefined) {
      const attribute = node.getAttribute?.('contenteditable')?.toLowerCase();
      if (attribute === 'false') editable = false;
      else if (attribute === '' || attribute === 'true' || attribute === 'plaintext-only' || node.isContentEditable) editable = true;
    }
    if (editable) return false;
    const tag = node.tagName?.toUpperCase();
    if (tag && NATIVE_CONTROLS.has(tag)) return false;
    if ((tag === 'A' || tag === 'AREA') && node.getAttribute?.('href') != null) return false;
    const roles = node.getAttribute?.('role')?.toLowerCase().split(/\s+/) ?? [];
    if (roles.some((role) => WIDGET_ROLES.has(role))) return false;
  }
  return true;
}
