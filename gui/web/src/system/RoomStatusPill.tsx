import { type RoomPhase, roomPillRendering } from "./roomPhase";
import { StatusPill } from "./StatusPill";

/** One rendering of what the room is doing, for every role and place. Capture health lives on tiles and alerts. */
export function RoomStatusPill({ phase }: { phase: RoomPhase }) {
  const { state, text, progress } = roomPillRendering(phase);
  return <StatusPill state={state} text={text} progress={progress} />;
}
