import type { Ref } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import {
  JOIN_GLYPH_PATH,
  type JoinGlyph,
  joinSeamLabel,
} from "../edit/joinRender";
import { hitTargetProps } from "./hitTargets";

export interface JoinBadgeViewProps {
  /** The clip whose incoming join this badge edits. */
  clipId: string;
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
  clipId,
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
      {...hitTargetProps("join", clipId, seamSec, {
        selected: expanded,
        detail: glyph,
      })}
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
        <path d={JOIN_GLYPH_PATH[glyph]} />
      </svg>
    </button>
  );
}
