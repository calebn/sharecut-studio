import { useId } from "react";
import { CommandButton } from "../ui";
import { useRecordHostStore } from "./hostStore";
import { RecIndicator } from "./RecIndicator";
import { REC_CHIP_CAPTURE_LABEL, REC_CHIP_OFFLINE_LABEL } from "./types";

export function RecordTransportChip() {
  const clockId = useId();
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  const connected = useRecordHostStore((s) => s.connected);
  if (!snapshot || snapshot.state === "lobby") {
    return null;
  }

  const live = snapshot.state === "recording" || snapshot.state === "paused";
  const offline = !connected && live;
  const label =
    snapshot.state === "recording"
      ? captureHealth
        ? REC_CHIP_CAPTURE_LABEL[captureHealth]
        : offline
          ? REC_CHIP_OFFLINE_LABEL
          : "Recording. Open record panel"
      : snapshot.state === "paused"
        ? offline
          ? REC_CHIP_OFFLINE_LABEL
          : "Paused. Open record panel"
        : "Open record panel";

  return (
    <CommandButton
      bare
      commandId="record.openPanel"
      className="record-rec-chip"
      data-state={snapshot.state}
      data-offline={offline ? "true" : undefined}
      aria-label={label}
      aria-describedby={clockId}
    >
      <RecIndicator
        snapshot={snapshot}
        capture={captureHealth}
        offline={offline}
        clockId={clockId}
      />
    </CommandButton>
  );
}
