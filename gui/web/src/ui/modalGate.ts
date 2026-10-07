/**
 * Non-reactive stack of open overlays (`useDialogModal`: modal dialogs and
 * peek sheets), innermost last. Escape belongs to the innermost one: an
 * in-app confirm over the Inspector sheet closes only the confirm.
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
};

const layers: Layer[] = [];

/** Register an overlay as it opens; pass the result to `closeOverlay`. */
export function openOverlay(
  modal: boolean,
  shortcuts: readonly string[] = [],
): Layer {
  const layer = { modal, shortcuts };
  layers.push(layer);
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

/**
 * The keymap commands the innermost open modal lets through (often none), or
 * null while no modal is open and every shortcut runs.
 */
export function modalShortcuts(): readonly string[] | null {
  return layers.findLast((layer) => layer.modal)?.shortcuts ?? null;
}
