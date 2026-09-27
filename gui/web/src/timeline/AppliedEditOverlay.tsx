import { useMemo } from "react";
import type { AppliedEditRecord, ClipRow } from "../types/project";
import { appliedEditTicks } from "./appliedEditTicks";

interface AppliedEditOverlayProps {
  records: AppliedEditRecord[];
  clips: readonly ClipRow[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
}

/**
 * Visual markers for applied edits, projected through the lane's current clips
 * (#527) so later ripples move them to the post-edit join instead of the stale
 * pre-edit range. Records that no longer map to a clip appear only in the
 * Impact panel's Applied edits list. Dense cut stacks cannot meet WCAG 2.5.8 as
 * individual 24px buttons, so ticks are non-interactive and carry no hover title
 * (the layer is `pointer-events: none` and `aria-hidden`); labels and selection
 * live in Impact → Applied edits. This is deliberate: the tests pin it and
 * include an axe check.
 */
export function AppliedEditOverlay({
  records,
  clips,
  trackId,
  zoomPxPerSec,
  selectedId,
}: AppliedEditOverlayProps) {
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
          className={`applied-tick applied-tick--${t.kind}${
            selectedId === t.recordId ? " selected" : ""
          }`}
          style={{ left: t.sec * zoomPxPerSec }}
        />
      ))}
    </div>
  );
}
