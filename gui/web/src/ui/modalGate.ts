/**
 * Non-reactive stack of open overlays (`useDialogModal`: modal dialogs and
 * peek sheets), innermost last. Escape and entry focus belong to the innermost
 * one: an in-app confirm over the Inspector sheet closes only the confirm.
 *
 * An open modal dialog holds every app shortcut, as the browser's own
 * `confirm()` did: the Daw keymap runs nothing behind it (no Mod+Z undoing an
 * edit behind "Remove the guest track?"), except the shortcuts the innermost
 * modal hands on, such as M for a marker in the Record room.
 *
 * Non-modals order by `stackRank`, not last mount. A peek sheet that remounts
 * reuses the rank for its `stackKey`, so a later JoinPopover stays innermost.
 */
type Layer = {
  readonly modal: boolean;
  /** Keymap command ids this modal lets through while it is innermost. */
  readonly shortcuts: readonly string[];
  readonly takeEntryFocus: () => void;
  readonly stackRank: number;
};

const layers: Layer[] = [];
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
 * Register an overlay as it opens; pass the result to `closeOverlay`. A
 * non-modal layer goes below every open overlay with a higher rank (modals
 * are highest): a sheet that remounts or renders beneath a popover or modal
 * belongs under it.
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
    return layer;
  }
  const insertAt = layers.findIndex((open) => open.stackRank > stackRank);
  layers.splice(insertAt >= 0 ? insertAt : layers.length, 0, layer);
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

/** True while any overlay is registered. The keymap must not run Escape then. */
export function hasOpenOverlay(): boolean {
  return layers.length > 0;
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
 * The keymap commands the innermost open modal lets through (often none), or
 * null while no modal is open and every shortcut runs.
 */
export function modalShortcuts(): readonly string[] | null {
  return layers.findLast((layer) => layer.modal)?.shortcuts ?? null;
}
