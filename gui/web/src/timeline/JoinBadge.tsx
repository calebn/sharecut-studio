import type { Ref } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { type JoinGlyph, joinSeamLabel } from "../edit/joinRender";

/** | cut, ╲╱ fade, ✕ crossfade in a 12 × 12 box. */
const GLYPH_PATH: Record<JoinGlyph, string> = {
  cut: "M6 1V11",
  fade: "M1 2L6 10L11 2",
  crossfade: "M1 1L11 11M11 1L1 11",
};

export interface JoinBadgeViewProps {
  glyph: JoinGlyph;
  /** A crossfade render cannot blend (`join_crossfade_blocked`). */
  blocked: boolean;
  /** Seam on the timeline (s), following a live roll. */
  seamSec: number;
  zoomPxPerSec: number;
  /** Whether its join popover is open. */
  expanded: boolean;
  /** The popover's id (aria-controls while open). */
  popoverId?: string;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/** One glyph per drawn join, at the top of the seam (#690); a button that opens the join popover. */
export function JoinBadgeView({
  glyph,
  blocked,
  seamSec,
  zoomPxPerSec,
  expanded,
  popoverId,
  onClick,
  ref,
}: JoinBadgeViewProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={`join-badge join-badge--${glyph}${blocked ? " join-badge--blocked" : ""}`}
      style={{ left: seamSec * zoomPxPerSec }}
      aria-label={`${joinSeamLabel(glyph, seamSec)}${blocked ? ", will not blend" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-controls={expanded ? popoverId : undefined}
      title={capabilityTooltip("timeline.join.badge")}
      onClick={onClick}
    >
      <svg
        className="join-badge-glyph"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <path d={GLYPH_PATH[glyph]} />
      </svg>
    </button>
  );
}
