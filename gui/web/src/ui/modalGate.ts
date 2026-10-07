/**
 * Non-reactive stack of open overlays (`useDialogModal`: modal dialogs and
 * peek sheets), innermost last. Escape belongs to the innermost one: an
 * in-app confirm over the Inspector sheet closes only the confirm, and while
 * any modal dialog is open the Daw keymap leaves Escape alone, so it does not
 * also clear the selection behind it.
 */
type Layer = { readonly modal: boolean };

const layers: Layer[] = [];

/** Register an overlay as it opens; pass the result to `closeOverlay`. */
export function openOverlay(modal: boolean): Layer {
  const layer = { modal };
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

/** True while a modal dialog is open. */
export function peekModalOpen(): boolean {
  return layers.some((layer) => layer.modal);
}
