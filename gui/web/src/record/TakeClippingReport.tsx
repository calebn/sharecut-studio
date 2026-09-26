import { useId } from "react";
import { Button } from "../ui";
import { formatClock } from "./clock";
import type { TakeClipping, TakeClipRegion } from "./keeper/clipRegions";
import {
  CLIPPING_JUNCTION_HINT,
  CLIPPING_RECOVERY_COPY,
  CLIPPING_TRUNCATED_COPY,
  clippingLiveCopy,
  clippingReportCopy,
  NO_CLIPPING_COPY,
  type RecordRoomState,
} from "./types";

type Props = {
  report: TakeClipping | null;
  roomState: RecordRoomState | undefined;
  /**
   * Host only: a jump action for a region, or null while the take has not
   * landed on the timeline. Omit it (guests) to list ranges without jumping.
   */
  jumpFor?: (region: TakeClipRegion) => (() => void) | null;
};

/** Live clipping notice during a take and the post-take clipping report. */
export function TakeClippingReport({ report, roomState, jumpFor }: Props) {
  const hintId = useId();
  if (!report) {
    return null;
  }
  const count = report.regions.length;
  if (roomState === "recording" || roomState === "paused") {
    return count > 0 ? (
      <p role="status" className="record-warn">
        {clippingLiveCopy(count)}
      </p>
    ) : null;
  }
  if (roomState !== "stopped") {
    return null;
  }
  if (count === 0) {
    return report.known ? (
      <p className="record-hint">{NO_CLIPPING_COPY}</p>
    ) : null;
  }
  const anyPending =
    jumpFor !== undefined && report.regions.some((r) => jumpFor(r) === null);
  return (
    <section className="stack" aria-labelledby={`${hintId}-h`}>
      <h3 id={`${hintId}-h`}>Clipping report</h3>
      <p className="record-warn">
        {clippingReportCopy(count, report.takeIndex)}
      </p>
      {report.truncated ? (
        <p className="record-hint">{CLIPPING_TRUNCATED_COPY}</p>
      ) : null}
      <ul className="stack">
        {report.regions.map((region) => {
          const jump = jumpFor ? jumpFor(region) : null;
          const range = `${formatClock(region.startMs)}–${formatClock(region.endMs)}`;
          return (
            <li
              key={`${region.segmentIndex}-${region.startMs}`}
              className="cluster"
            >
              <span>{range}</span>
              {jumpFor ? (
                <Button
                  type="button"
                  onClick={jump ?? undefined}
                  disabled={jump === null}
                  aria-describedby={jump === null ? hintId : undefined}
                >
                  Jump to
                  <span className="sr-only"> {range}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {anyPending ? (
        <p id={hintId} className="record-hint">
          {CLIPPING_JUNCTION_HINT}
        </p>
      ) : null}
      <p className="record-hint">{CLIPPING_RECOVERY_COPY}</p>
    </section>
  );
}
