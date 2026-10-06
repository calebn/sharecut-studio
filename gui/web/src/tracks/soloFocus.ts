import { presenceAnchor, resolvePresenceAnchor } from "../presence/anchors";
import { focusAndReveal } from "../ui/focusAndReveal";

const SEARCH_ROOT = ".track-headers, .track-mix, [data-shell]";
const FALLBACK = ".track-headers, .track-mix, main";
const ANY_SOLO_BUTTON =
  '[data-presence-anchor^="track:"][data-presence-anchor$=":solo"]';

/**
 * Where keyboard focus lands when the Solo on chip unmounts because it was
 * activated: the S button of the one soloed track, else the first S button
 * beside the chip, else the surrounding tracks region.
 */
export function focusAfterClearSolo(
  chip: HTMLElement,
  soloedTrackIds: readonly string[],
): void {
  const root = chip.closest<HTMLElement>(SEARCH_ROOT) ?? document.body;
  const only =
    soloedTrackIds.length === 1
      ? resolvePresenceAnchor(
          root,
          presenceAnchor("track", soloedTrackIds[0], "solo"),
        )
      : null;
  focusAndReveal(
    only ??
      root.querySelector<HTMLElement>(ANY_SOLO_BUTTON) ??
      chip.closest<HTMLElement>(FALLBACK),
  );
}
