/**
 * Non-reactive stack of open overlays (`useDialogModal`: modal dialogs and
 * peek sheets), innermost last. Escape and entry focus belong to the innermost
 * one: an in-app confirm over the Inspector sheet closes only the confirm.
 *
 * An open modal dialog holds every app shortcut, as the browser's own
 * `confirm()` did: the Daw keymap runs nothing behind it (no Mod+Z undoing an
 * edit behind "Remove the guest track?"), except the shortcuts the innermost
 * modal hands on, such as M for a marker in the Record room.
 */
type Layer = {
  readonly modal: boolean;
  /** Keymap command ids this modal lets through while it is innermost. */
  readonly shortcuts: readonly string[];
  readonly takeEntryFocus: () => void;
};

const layers: Layer[] = [];

/**
 * Register an overlay as it opens; pass the result to `closeOverlay`. A
 * non-modal layer goes below the topmost open modal: nothing non-modal opens
 * from inside a modal (it makes the chrome inert), so a sheet that remounts
 * or renders beneath one belongs under it.
 */
export function openOverlay(
  modal: boolean,
  shortcuts: readonly string[] = [],
  takeEntryFocus: () => void = () => undefined,
): Layer {
  const layer = { modal, shortcuts, takeEntryFocus };
  const topModal = modal ? -1 : layers.findLastIndex((open) => open.modal);
  layers.splice(topModal >= 0 ? topModal : layers.length, 0, layer);
  return layer;
}

export function closeOverlay(layer: Layer): void {
  const index = layers.lastIndexOf(layer);
  if (index >= 0) layers.splice(index, 1);
}

/** True when `layer` is the innermost open overlay (it owns Escape). */
export function isInnermostOverlay(layer: Layer): boolean {
  return layers.at(-1) === layer;
}

export function focusInnermostOverlay(): void {
  layers.at(-1)?.takeEntryFocus();
}

/**
 * The keymap commands the innermost open modal lets through (often none), or
 * null while no modal is open and every shortcut runs.
 */
export function modalShortcuts(): readonly string[] | null {
  return layers.findLast((layer) => layer.modal)?.shortcuts ?? null;
}
