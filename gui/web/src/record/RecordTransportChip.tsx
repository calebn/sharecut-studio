import { CommandButton } from "../ui";
import { useRecordHostStore } from "./hostStore";
import { RecIndicator } from "./RecIndicator";

export function RecordTransportChip() {
  const snapshot = useRecordHostStore((s) => s.snapshot);
  const captureHealth = useRecordHostStore((s) => s.captureHealth);
  if (!snapshot || snapshot.state === "lobby") {
    return null;
  }

  const label =
    snapshot.state === "recording"
      ? captureHealth === "failed"
        ? "Local capture failed — open record panel"
        : captureHealth === "pending"
          ? "Waiting for microphone — open record panel"
          : "Recording — open record panel"
      : snapshot.state === "paused"
        ? "Paused — open record panel"
        : "Open record panel";

  return (
    <CommandButton
      bare
      commandId="record.openPanel"
      className="record-rec-chip"
      data-state={snapshot.state}
      aria-label={label}
    >
      <RecIndicator
        snapshot={snapshot}
        captureFailed={captureHealth === "failed"}
        capturePending={captureHealth === "pending"}
      />
    </CommandButton>
  );
}
