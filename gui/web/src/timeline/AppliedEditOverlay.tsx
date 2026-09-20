import type { AppliedEditRecord } from "../types/project";

interface AppliedEditOverlayProps {
  records: AppliedEditRecord[];
  trackId: string;
  zoomPxPerSec: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Visual markers for applied edits. Dense cut stacks cannot meet WCAG 2.5.8 as
 * individual 24px buttons, so ticks are non-interactive; select via Impact panel.
 */
export function AppliedEditOverlay({
  records,
  trackId,
  zoomPxPerSec,
  selectedId,
}: AppliedEditOverlayProps) {
  return (
    <>
      {records
        .filter(
          (r) =>
            r.track_ids.includes(trackId) &&
            r.timeline_start != null &&
            r.timeline_end != null,
        )
        .map((r) => {
          const spanPx = Math.max(
            3,
            (r.timeline_end! - r.timeline_start!) * zoomPxPerSec,
          );
          return (
            <div
              key={r.id}
              className={`applied-tick${selectedId === r.id ? " selected" : ""}`}
              style={{
                left: r.timeline_start! * zoomPxPerSec,
                width: spanPx,
              }}
              title={`${r.operation}: ${r.reason ?? ""}`}
              aria-hidden="true"
            />
          );
        })}
    </>
  );
}
