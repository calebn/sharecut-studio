import { hasShareCapability, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { transportAvailability } from "../state/transportAvailability";
import { playTimelineRange } from "../utils/playRange";
import { staleRenderBreakdown } from "../utils/staleRender";
import { PLAY_DENIED_REASON, PLAY_STALE_REASON } from "./rangeActions";
import { seekTransport } from "./seek";
import type { ExecuteResult } from "./types";

type DawState = ReturnType<typeof useDawStore.getState>;

function playGate(s: DawState): string | null {
  const reason = transportAvailability(s).togglePlay;
  if (reason !== undefined) return reason;
  const guest = isShareProjectKey(s.projectPath) || s.guestMode !== null;
  if (guest && !hasShareCapability(s.shareCapabilities, "play"))
    return PLAY_DENIED_REASON;
  if (guest && staleRenderBreakdown(s.project).stale) return PLAY_STALE_REASON;
  return null;
}

export function playSpan(
  start: number,
  end: number,
  padSec: number,
): ExecuteResult {
  const s = useDawStore.getState();
  const reason = playGate(s);
  if (reason) return { status: "disabled", reason };
  playTimelineRange({
    start,
    end,
    padSec,
    beginAudition: s.beginAudition,
    setPlayheadSec: (sec) => void seekTransport(sec),
    setPlayUntilSec: s.setPlayUntilSec,
    setIsPlaying: s.setIsPlaying,
  });
  return { status: "ok" };
}
