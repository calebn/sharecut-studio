import { useMemo } from "react";
import { Seam } from "../system/Seam";
import type { AppliedEditRecord, ClipRow } from "../types/project";
import { appliedKind, markerVariant } from "../utils/editMarkerRegistry";
import { clockLabel } from "../utils/time";
import { type AppliedTick, appliedEditTicks } from "./appliedEditTicks";
import { type PlacedSeamChip, planSeams } from "./seamPlan";

interface SeamMarksProps {
  records: readonly AppliedEditRecord[];
  clips: readonly ClipRow[];
  trackId: string;
  zoomPxPerSec: number;
  sessionSec: number;
  selectedId: string | null;
  onSelect: (recordId: string) => void;
  onZoomChip: (chip: PlacedSeamChip) => void;
}

function seamLabel(tick: AppliedTick): string {
  return `${tick.kind === "seam" ? "Cut" : "Edit"} at ${clockLabel(tick.sec)}`;
}

/**
 * Applied edits on a lane (#527), projected through the lane's current clips so
 * later ripples move them to the post-edit join. A cut or edge is a selectable
 * Seam diamond (the action bar's Hear, Keep, Comment and Inspect work on it);
 * seams closer than 24 px fold into a count chip that zooms to the group, so
 * every target keeps WCAG 2.5.8's 24 px. Mute ticks stay decorative: they have
 * no cut to restore.
 */
export function SeamMarks({
  records,
  clips,
  trackId,
  zoomPxPerSec,
  sessionSec,
  selectedId,
  onSelect,
  onZoomChip,
}: SeamMarksProps) {
  const ticks = useMemo(
    () => appliedEditTicks(records, trackId, clips),
    [records, trackId, clips],
  );
  const { muted, live } = useMemo(
    () => ({
      muted: ticks.filter((t) => t.mute),
      live: ticks.filter((t) => !t.mute),
    }),
    [ticks],
  );
  const plan = useMemo(
    () => planSeams(live, zoomPxPerSec, sessionSec),
    [live, zoomPxPerSec, sessionSec],
  );

  if (ticks.length === 0) {
    return null;
  }

  return (
    <div className="applied-edit-layer">
      {muted.map((t) => (
        <div
          key={t.key}
          aria-hidden="true"
          className={`applied-tick applied-tick--${markerVariant(appliedKind(t))}`}
          style={{ left: t.sec * zoomPxPerSec }}
        />
      ))}
      {plan.map((item) =>
        item.kind === "seam" ? (
          <span
            key={item.tick.key}
            className="applied-seam"
            style={{ left: item.xPx }}
          >
            <Seam
              form="diamond"
              kind={item.tick.kind === "seam" ? "cut" : "split"}
              label={seamLabel(item.tick)}
              selected={selectedId === item.tick.recordId}
              onSelect={() => onSelect(item.tick.recordId)}
            />
          </span>
        ) : item.zoomTo == null ? (
          <span
            key={item.ticks[0].key}
            className="edit-chip edit-chip--static"
            role="img"
            style={{ left: item.xPx }}
            aria-label={`${item.ticks.length} cuts close together`}
          >
            {item.ticks.length}
          </span>
        ) : (
          <button
            key={item.ticks[0].key}
            type="button"
            className="edit-chip"
            style={{ left: item.xPx }}
            aria-label={`${item.ticks.length} cuts close together, zoom in to separate them`}
            onClick={() => onZoomChip(item)}
          >
            {item.ticks.length}
          </button>
        ),
      )}
    </div>
  );
}
