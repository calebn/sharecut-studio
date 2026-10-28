import { useMemo } from "react";
import type { AppliedEditRecord, ClipRow } from "../types/project";
import { appliedKind, markerVariant } from "../utils/editMarkerRegistry";
import { appliedEditTicks } from "./appliedEditTicks";

interface AppliedEditOverlayProps {
  records: readonly AppliedEditRecord[];
  clips: readonly ClipRow[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
}

/**
 * Visual markers for applied edits, projected through the lane's current clips
 * (#527) so later ripples move them to the post-edit join instead of the stale
 * pre-edit range. A record that no longer maps to a clip has no marker; the
 * Applied edits list that showed it left with the Impact panel (#2293). Dense
 * cut stacks cannot meet WCAG 2.5.8 as individual 24px buttons, so ticks are
 * non-interactive and carry no hover title (the layer is `pointer-events: none`
 * and `aria-hidden`). This is deliberate: the tests pin it and include an axe
 * check.
 */
export function AppliedEditOverlay({
  records,
  clips,
  trackId,
  zoomPxPerSec,
  selectedId,
}: AppliedEditOverlayProps) {
  // `appliedEditTicks` still filters by `trackId` on purpose, though
  // TimelineView passes this lane its own slice (see PendingEditOverlay).
  const ticks = useMemo(
    () => appliedEditTicks(records, trackId, clips),
    [records, trackId, clips],
  );

  if (ticks.length === 0) {
    return null;
  }

  return (
    <div className="applied-edit-layer" aria-hidden="true">
      {ticks.map((t) => (
        <div
          key={t.key}
          className={`applied-tick applied-tick--${markerVariant(appliedKind(t))}${
            selectedId === t.recordId ? " selected" : ""
          }`}
          style={{ left: t.sec * zoomPxPerSec }}
        />
      ))}
    </div>
  );
}
