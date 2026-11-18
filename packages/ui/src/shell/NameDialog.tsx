/**
 * Diálogo de nombre PROPIO, sobre `<dialog>` nativo.
 *
 * `window.prompt` no existe en Electron 43: lanza «prompt() is not supported».
 * Los menús que lo llamaban (guardar plantilla, guardar layout) morían antes de
 * hacer nada o se quedaban abiertos. Esto lo sustituye con el mismo mecanismo
 * que ya usa «Acerca de»: `<dialog>` modal, que confina el Tab y deja inerte el
 * estudio, foco al input al abrir y devuelto a quien lo abrió al cerrar.
 *
 * Hay dos entradas:
 * - `NameDialog`, componente controlado (lo usa el host y puede usarlo quien
 *   necesite un modal dentro de su árbol).
 * - `askName()` en `./name-dialog`, promesa para módulos que NO son React.
 * `NameDialogHost` es el puente: un solo host en `App` escucha el store y pinta
 * el diálogo.
 */

import { useEffect, useRef, useState } from 'react';
import {
  MAX_DIALOG_NAME_LENGTH,
  normalizeDialogName,
  useNameDialogStore,
} from './name-dialog';

interface NameDialogProps {
  title: string;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  /** Devuelve un mensaje de error, o null si el nombre vale. */
  validate?: (name: string) => string | null;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

export function NameDialog({
  title,
  label = 'Nombre',
  initialValue = '',
  confirmLabel = 'Guardar',
  validate,
  onCancel,
  onConfirm,
}: NameDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Igual que `AboutDialog`: el modal nativo se abre en un efecto para no
  // pintar un diálogo no modal en el primer frame, y devuelve el foco al
  // cerrarse. Sin el `finally` del cleanup, cancelar con Esc dejaría el foco
  // en el body y los atajos globales volverían a actuar sin que se vea dónde.
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = dialog?.ownerDocument.activeElement;
    dialog?.showModal();
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  const submit = () => {
    const normalized = normalizeDialogName(value);
    if (normalized === null) {
      setError('Escribe un nombre.');
      return;
    }
    const message = validate?.(normalized) ?? null;
    if (message !== null) {
      setError(message);
      return;
    }
    onConfirm(normalized);
  };

  return (
    <dialog
      ref={dialogRef}
      className="name-dialog popup"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        // Un keydown del modal sube hasta el listener global de atajos: con el
        // foco en el input, F5/Ctrl+S no pueden actuar detrás.
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        // Clic en el velo = cancelar, como en «Acerca de».
        const box = event.currentTarget.getBoundingClientRect();
        if (
          event.target === event.currentTarget &&
          (event.clientX < box.left || event.clientX > box.right ||
            event.clientY < box.top || event.clientY > box.bottom)
        ) {
          onCancel();
        }
      }}
    >
      <form
        className="name-dialog__form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 className="name-dialog__title">{title}</h2>
        <label className="name-dialog__field">
          <span>{label}</span>
          <input
            ref={inputRef}
            className="name-dialog__input"
            value={value}
            maxLength={MAX_DIALOG_NAME_LENGTH}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error !== null}
            aria-describedby={error !== null ? 'name-dialog-error' : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              if (error !== null) setError(null);
            }}
            onKeyDown={(event) => {
              // Enter confirma aunque el botón esté deshabilitado: así un
              // nombre vacío enseña «Escribe un nombre» en vez de no hacer nada.
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </label>
        {error !== null && (
          <p id="name-dialog-error" className="name-dialog__error" role="alert">
            {error}
          </p>
        )}
        <div className="name-dialog__actions">
          <button type="button" className="name-dialog__btn" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="name-dialog__btn primary" disabled={normalizeDialogName(value) === null}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * Único punto de montaje de la API imperativa (`askName`). Va siempre en `App`
 * (no condicionado): si no hay petición no pinta nada.
 */
export function NameDialogHost() {
  const request = useNameDialogStore((s) => s.request);
  if (!request) return null;
  return (
    <NameDialog
      key={request.id}
      title={request.title}
      label={request.label}
      initialValue={request.initial}
      confirmLabel={request.confirmLabel}
      {...(request.validate ? { validate: request.validate } : null)}
      onCancel={() => useNameDialogStore.getState().cancel()}
      onConfirm={(name) => {
        // El store normaliza/valida otra vez y resuelve la promesa de `askName`.
        // Si rechazara (misma función de validación que ya pasó el componente),
        // el diálogo sigue abierto porque `request` no se limpia.
        useNameDialogStore.getState().confirm(name);
      }}
    />
  );
}
