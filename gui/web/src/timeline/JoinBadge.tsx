import { memo, type Ref, useCallback, useEffect, useId, useRef } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { type JoinGlyph, joinGlyph, joinSeamLabel } from "../edit/joinRender";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import { JoinPopover } from "./JoinPopover";

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

interface JoinBadgeProps {
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  zoomPxPerSec: number;
  trackFadeMaxMs: number | null;
}

function JoinBadgeLive({
  left,
  right,
  seamSec,
  zoomPxPerSec,
  trackFadeMaxMs,
}: JoinBadgeProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const popoverId = useId();
  const joinId = right.id;
  const { open, setOpenJoinId } = useDaw((s) => ({
    open: s.openJoinId === joinId,
    setOpenJoinId: s.setOpenJoinId,
  }));
  const close = useCallback(() => {
    if (useDawStore.getState().openJoinId === joinId) {
      setOpenJoinId(null);
    }
  }, [joinId, setOpenJoinId]);
  // A badge that unmounts (its seam stops being a drawn join, a clip starts moving) closes its popover.
  useEffect(() => close, [close]);
  const glyph = joinGlyph(right);
  return (
    <>
      <JoinBadgeView
        ref={buttonRef}
        glyph={glyph}
        blocked={glyph === "crossfade" && right.join_crossfade_blocked != null}
        seamSec={seamSec}
        zoomPxPerSec={zoomPxPerSec}
        expanded={open}
        popoverId={popoverId}
        onClick={() => {
          if (!open) {
            setOpenJoinId(joinId);
          } else if (!inFlightRef.current) {
            close();
          }
        }}
      />
      {open ? (
        <JoinPopover
          id={popoverId}
          left={left}
          right={right}
          seamSec={seamSec}
          trackFadeMaxMs={trackFadeMaxMs}
          anchorRef={buttonRef}
          onClose={close}
          inFlightRef={inFlightRef}
        />
      ) : null}
    </>
  );
}

/** Re-renders only when its props change (rows keep identity across unrelated edits). */
export const JoinBadge = memo(JoinBadgeLive);
