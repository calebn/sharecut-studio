import type { CoverProps } from "../system/Cover";
import type { RoomPhase } from "../system/roomPhase";

/** Tab text per pill phase. A new RoomPhase kind fails the build here. */
const PHASE_TAB: Record<RoomPhase["kind"], string> = {
  waiting: "Waiting",
  countdown: "Stay quiet",
  live: "Recording",
  paused: "Paused",
  saving: "Saving to project…",
  saved: "Saved to project",
  reconnecting: "Reconnecting…",
};

/** The /rec tab title. A shown cover supplies its own title. */
export function guestTabTitle(input: {
  cover: CoverProps | null;
  bootstrapped: boolean;
  seat: "guest" | "producer";
  /** What the viewer is doing about the room, as the sheet and the scrim show it. */
  stance: "joining" | "declined" | "in";
  phase: RoomPhase;
  episode: string;
}): string {
  const { cover, bootstrapped, seat, stance, phase, episode } = input;
  const state = cover
    ? cover.title
    : !bootstrapped
      ? "Joining the room"
      : seat === "producer" && stance !== "in"
        ? "Join to listen"
        : stance === "joining"
          ? "Join the room"
          : stance === "declined"
            ? "Not being recorded"
            : phase.kind === "saving" && phase.failed
              ? "Saving stopped"
              : PHASE_TAB[phase.kind];
  return `${state} | ${episode.trim() || "ShareCut Studio"}`;
}
