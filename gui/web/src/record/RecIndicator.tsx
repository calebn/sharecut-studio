import { useEffect, useState } from "react";
import { useIntervalTick } from "../hooks/useIntervalTick";
import { ClipLed } from "../ui";
import { formatTimeShort } from "../utils/time";
import { recordingClockMs } from "./clock";
import {
  type CaptureHealth,
  REC_CAPTURE_LABEL,
  REC_OFFLINE_SUFFIX,
  type RecordSnapshot,
} from "./types";

export function RecIndicator({
  snapshot,
  capture = null,
  clockId,
  offline = false,
  clipping,
  clockNowMs,
}: {
  snapshot: RecordSnapshot;
  capture?: CaptureHealth;
  clockId?: string;
  /** Host record socket is down; only affects recording and paused. */
  offline?: boolean;
  /** Take clipping state; undefined hides the LED (producers). */
  clipping?: boolean;
  /** Fixed clock for deterministic previews; omit for the live timer. */
  clockNowMs?: number;
}) {
  const [markedAt, setMarkedAt] = useState(() => clockNowMs ?? Date.now());
  const [baseMs, setBaseMs] = useState(snapshot.recording_ms ?? 0);

  useEffect(() => {
    setBaseMs(snapshot.recording_ms ?? 0);
    setMarkedAt(clockNowMs ?? Date.now());
  }, [clockNowMs, snapshot.recording_ms, snapshot.state]);

  // Live timer: re-render once a second unless a fixed preview clock is set.
  useIntervalTick(1000, clockNowMs == null);

  let label = "Waiting for host";
  if (snapshot.state === "recording") {
    label = capture ? REC_CAPTURE_LABEL[capture] : "REC";
  } else if (snapshot.state === "paused") {
    label = "PAUSED";
  } else if (snapshot.state === "stopped") {
    label = "Stopped";
  }
  const showOffline =
    offline &&
    !capture &&
    (snapshot.state === "recording" || snapshot.state === "paused");
  if (showOffline) {
    label = `${label} ${REC_OFFLINE_SUFFIX}`;
  }
  const clock = recordingClockMs(
    { ...snapshot, recording_ms: baseMs },
    (clockNowMs ?? Date.now()) - markedAt,
  );
  return (
    <div className="cluster record-indicator" role="status">
      <span className="record-rec-label" data-state={snapshot.state}>
        {snapshot.state === "recording" && !capture && !showOffline ? (
          <span className="record-rec-dot" aria-hidden="true" />
        ) : null}
        {label}
      </span>
      <span id={clockId} className="record-clock" aria-live="off">
        {formatTimeShort(clock / 1000)}
      </span>
      {clipping === undefined ? null : <ClipLed lit={clipping} label="Take" />}
    </div>
  );
}
