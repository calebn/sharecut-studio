import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PresenceViewer } from "../stage/frame/personCard";
import { useDawStore } from "../state/dawStore";
import { followCapsOf } from "./goToPlan";

/** What decides whether this viewer can open where someone else is: the stage they are on, what their link may reach, and the episode length. */
export function usePresenceViewer(): PresenceViewer {
  const { stage, guestMode, breakpoint, durationSec } = useDawStore(
    useShallow((s) => ({
      stage: s.stage,
      guestMode: s.guestMode,
      breakpoint: s.shellBreakpoint,
      durationSec: s.project?.timeline_duration_sec ?? Number.NaN,
    })),
  );
  return useMemo(
    () => ({
      stage,
      durationSec,
      caps: followCapsOf(guestMode, breakpoint),
    }),
    [stage, durationSec, guestMode, breakpoint],
  );
}
