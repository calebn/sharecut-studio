import { type RoomPhase, roomPillRendering } from "./roomPhase";
import { StatusPill } from "./StatusPill";

/** One rendering of what the room is doing, for every role and place. Capture health lives on tiles and alerts. */
export function RoomStatusPill({
  phase,
  compact,
}: {
  phase: RoomPhase;
  /** The Stage bar's badge form: the live clock alone, "Paused" without it. */
  compact?: boolean;
}) {
  const { state, text, progress } = roomPillRendering(phase, compact);
  return (
    <StatusPill
      state={state}
      text={text}
      progress={progress}
      compact={compact}
    />
  );
}
