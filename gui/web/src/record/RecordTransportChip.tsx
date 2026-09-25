import { useId } from "react";
import { CommandButton } from "../ui";
import { useRecordHostStore } from "./hostStore";
import { RecIndicator } from "./RecIndicator";
import { REC_CHIP_CAPTURE_LABEL } from "./types";

export function RecordTransportChip() {
  const clockId = useId();
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  if (!snapshot || snapshot.state === "lobby") {
    return null;
  }

  const label =
    snapshot.state === "recording"
      ? captureHealth
        ? REC_CHIP_CAPTURE_LABEL[captureHealth]
        : "Recording. Open record panel"
      : snapshot.state === "paused"
        ? "Paused. Open record panel"
        : "Open record panel";

  return (
    <CommandButton
      bare
      commandId="record.openPanel"
      className="record-rec-chip"
      data-state={snapshot.state}
      aria-label={label}
      aria-describedby={clockId}
    >
      <RecIndicator
        snapshot={snapshot}
        capture={captureHealth}
        clockId={clockId}
      />
    </CommandButton>
  );
}
