import { formatTimeShort } from "../utils/time";
import type { TimeRange } from "./seconds";

/** A comment's place in the episode. `end` is present when it came from a selection. */
export type AnchorSpan = { start: number; end?: number };

export type ComposerAnchor =
  | { kind: "follow"; seconds: number }
  | ({ kind: "pinned" } & AnchorSpan)
  | { kind: "episode" };

export type AnchorIntent = "pin" | "here" | "episode";
export type Playhead = { seconds: number; selection?: TimeRange };

const pinnedAt = ({ seconds, selection }: Playhead): ComposerAnchor =>
  selection
    ? { kind: "pinned", start: selection.start, end: selection.end }
    : { kind: "pinned", start: seconds };

/**
 * The one home of the pin rules. Pure and idempotent.
 * `pin` freezes the time the chip shows, `here` re-anchors at the selection or
 * the playhead, `episode` makes a whole-episode note.
 */
export function nextAnchor(
  anchor: ComposerAnchor,
  intent: AnchorIntent,
  playhead: Playhead,
): ComposerAnchor {
  switch (intent) {
    case "pin":
      return anchor.kind === "follow"
        ? { kind: "pinned", start: anchor.seconds }
        : anchor;
    case "here":
      return pinnedAt(playhead);
    case "episode":
      return anchor.kind === "episode" ? anchor : { kind: "episode" };
  }
}

/** Before typing: a selection pins as a range, otherwise follow the playhead. */
export function idleAnchor(playhead: Playhead): ComposerAnchor {
  return playhead.selection
    ? pinnedAt(playhead)
    : { kind: "follow", seconds: playhead.seconds };
}

/** "18:36", or "18:36 to 18:41" (design system 4.5). */
export function formatAnchor(span: AnchorSpan): string {
  const start = formatTimeShort(span.start);
  return span.end === undefined
    ? start
    : `${start} to ${formatTimeShort(span.end)}`;
}
