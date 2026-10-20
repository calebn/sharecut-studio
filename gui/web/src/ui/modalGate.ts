/**
 * The one gate every overlay registers with: `useDialogModal` (modal dialogs
 * and peek sheets) and `useMenuKeyboard` (menus). The stack is non-reactive,
 * innermost last; `subscribeModalOpen` lets a view follow whether a modal is
 * open (`useModalOpen`). Escape and entry focus belong to the innermost
 * one: an in-app confirm over the Inspector sheet closes only the confirm.
 *
 * The keymap asks one question, `keymapHandoff`. An open menu holds every
 * app shortcut. So does an open modal dialog, as the browser's own `confirm()`
 * did: the Daw keymap runs nothing behind it (no Mod+Z undoing an edit behind
 * "Remove the guest track?"), except the shortcuts the innermost modal hands
 * on, such as M for a marker in the Record room.
 */
type Layer = {
  readonly modal: boolean;
  /** Keymap command ids this modal lets through while it is innermost. */
  readonly shortcuts: readonly string[];
  readonly takeEntryFocus: () => void;
  readonly stackRank: number;
};

const layers: Layer[] = [];
let openMenus = 0;
const modalListeners = new Set<() => void>();
const rankByStackKey = new Map<string, number>();
let nextRank = 1;

function stackRankFor(modal: boolean, stackKey: string | undefined): number {
  if (modal) {
    return Number.POSITIVE_INFINITY;
  }
  if (stackKey) {
    const existing = rankByStackKey.get(stackKey);
    if (existing !== undefined) {
      return existing;
    }
    const rank = nextRank;
    nextRank += 1;
    rankByStackKey.set(stackKey, rank);
    return rank;
  }
  const rank = nextRank;
  nextRank += 1;
  return rank;
}

/**
 * Register an overlay as it opens; pass the result to `closeOverlay`.
 */
export function openOverlay(
  modal: boolean,
  shortcuts: readonly string[] = [],
  takeEntryFocus: () => void = () => undefined,
  stackKey?: string,
): Layer {
  const stackRank = stackRankFor(modal, stackKey);
  const layer = { modal, shortcuts, takeEntryFocus, stackRank };
  if (modal) {
    layers.push(layer);
    notifyModalListeners();
    return layer;
  }
  const insertAt = layers.findIndex((open) => open.stackRank > stackRank);
  layers.splice(insertAt >= 0 ? insertAt : layers.length, 0, layer);
  return layer;
}

export function closeOverlay(layer: Layer): void {
  const index = layers.lastIndexOf(layer);
  if (index >= 0) layers.splice(index, 1);
  if (layer.modal) notifyModalListeners();
}

/** Call as a menu opens (true) and closes (false). */
export function noteMenuOpen(open: boolean): void {
  openMenus = open ? openMenus + 1 : Math.max(0, openMenus - 1);
}

/** True while a menu is open; a menu owns Escape before any dialog. */
export function menuOpen(): boolean {
  return openMenus > 0;
}

function notifyModalListeners(): void {
  for (const listener of modalListeners) listener();
}

/** True while a modal dialog is open (a snapshot for `useModalOpen`). */
export function modalOpen(): boolean {
  return layers.some((layer) => layer.modal);
}

export function subscribeModalOpen(listener: () => void): () => void {
  modalListeners.add(listener);
  return () => {
    modalListeners.delete(listener);
  };
}

/** True when `layer` is the innermost open overlay (it owns Escape). */
export function isInnermostOverlay(layer: Layer): boolean {
  return layers.at(-1) === layer;
}

/** True while any overlay is open (menu, dialog or sheet); each owns Escape. */
export function overlayOpen(): boolean {
  return openMenus > 0 || layers.length > 0;
}

const claimedEscapes = new WeakSet<Event>();

/**
 * True for the first overlay to ask about this Escape. Listeners run in the
 * order their overlays mounted, which a remount can invert, and the innermost
 * overlay may close (and leave the stack) before the next listener runs: that
 * one must not take the same keypress.
 */
export function claimEscape(event: Event): boolean {
  if (claimedEscapes.has(event)) return false;
  claimedEscapes.add(event);
  return true;
}

export function focusInnermostOverlay(): void {
  layers.at(-1)?.takeEntryFocus();
}

/**
 * The keymap commands that may run now: none while a menu is open, the
 * innermost open modal's handoff list (often none) while a dialog is, or null
 * while no overlay holds the keymap and every shortcut runs.
 */
export function keymapHandoff(): readonly string[] | null {
  if (openMenus > 0) return [];
  return layers.findLast((layer) => layer.modal)?.shortcuts ?? null;
}
