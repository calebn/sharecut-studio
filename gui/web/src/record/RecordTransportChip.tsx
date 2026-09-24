import { useId } from "react";
import { CommandButton } from "../ui";
import { useRecordHostStore } from "./hostStore";
import { RecIndicator } from "./RecIndicator";

export function RecordTransportChip() {
  const clockId = useId();
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  if (!snapshot || snapshot.state === "lobby") {
    return null;
  }

  const label =
    snapshot.state === "recording"
      ? captureHealth === "failed"
        ? "Local capture failed. Open record panel"
        : captureHealth === "pending"
          ? "Waiting for microphone. Open record panel"
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
        captureFailed={captureHealth === "failed"}
        capturePending={captureHealth === "pending"}
        clockId={clockId}
      />
    </CommandButton>
  );
}
