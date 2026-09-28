import { memo } from "react";
import { JOIN_MODE_SHORT, type JoinGlyph } from "../edit/joinRender";
import { formatRulerTime } from "../utils/time";

/** | cut, ╲╱ fade, ✕ crossfade in a 12 × 12 box. */
const GLYPH_PATH: Record<JoinGlyph, string> = {
  cut: "M6 1V11",
  fade: "M1 2L6 10L11 2",
  crossfade: "M1 1L11 11M11 1L1 11",
};

interface JoinBadgeProps {
  glyph: JoinGlyph;
  /** A crossfade render cannot blend (`join_crossfade_blocked`). */
  blocked: boolean;
  /** Seam on the timeline (s), following a live roll. */
  seamSec: number;
  zoomPxPerSec: number;
}

/**
 * One glyph per drawn join, at the top of the seam (#690). Display-only and
 * click-through for now; #691 makes it the button that opens the join popover.
 */
export function JoinBadgeView({
  glyph,
  blocked,
  seamSec,
  zoomPxPerSec,
}: JoinBadgeProps) {
  return (
    <span
      className={`join-badge join-badge--${glyph}${blocked ? " join-badge--blocked" : ""}`}
      style={{ left: seamSec * zoomPxPerSec }}
      role="img"
      aria-label={`${JOIN_MODE_SHORT[glyph]} join at ${formatRulerTime(seamSec, 0.1)}${blocked ? ", will not blend" : ""}`}
    >
      <svg
        className="join-badge-glyph"
        viewBox="0 0 12 12"
        aria-hidden="true"
        focusable="false"
      >
        <path d={GLYPH_PATH[glyph]} />
      </svg>
    </span>
  );
}

/** Re-renders only when its own (primitive) props change. */
export const JoinBadge = memo(JoinBadgeView);
