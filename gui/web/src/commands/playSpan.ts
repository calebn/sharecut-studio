import { hasShareCapability, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { transportAvailability } from "../state/transportAvailability";
import {
  DEFAULT_AUDITION_PAD_SEC,
  playTimelineRange,
} from "../utils/playRange";
import { PLAY_DENIED_REASON } from "./rangeActions";
import type { ExecuteResult } from "./types";

type DawState = ReturnType<typeof useDawStore.getState>;

function playGate(s: DawState): string | null {
  const reason = transportAvailability(s).togglePlay;
  if (reason !== undefined) return reason;
  const guest = isShareProjectKey(s.projectPath) || s.guestMode !== null;
  if (guest && !hasShareCapability(s.shareCapabilities, "play"))
    return PLAY_DENIED_REASON;
  return null;
}

export function playSpan(
  start: number,
  end: number,
  padSec = DEFAULT_AUDITION_PAD_SEC,
): ExecuteResult {
  const s = useDawStore.getState();
  const reason = playGate(s);
  if (reason) return { status: "disabled", reason };
  playTimelineRange({
    start,
    end,
    padSec,
    beginAudition: s.beginAudition,
  });
  return { status: "ok" };
}
