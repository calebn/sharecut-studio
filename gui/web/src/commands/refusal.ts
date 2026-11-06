import { useDawStore } from "../state/dawStore";
import { plainError } from "../utils/plainError";
import type { ExecuteResult } from "./types";

/**
 * Runs a palette command and tells the user when it was refused, at error tone
 * (the palette is an explicit ask, so every refusal is worth saying). A command
 * that already told the failure in its own words is not overwritten by the bare
 * reason, which would drop the action it names ("Refresh failed: …"): it either
 * says so with `told`, or it announced during this run and the standing text
 * carries the reason (as written, or as error tone rewrites it) or is itself an
 * error. An unrelated
 * announcement, or an old one the run did not make, never hides a refusal. The
 * keyboard listener keeps its own policy of speaking only for commands that
 * change the project.
 */
export async function runAndAnnounceRefusal(
  run: () => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  const toldBefore = useDawStore.getState().statusAnnouncementSeq;
  const result = await run();
  if (result.status !== "disabled" || result.told) {
    return result;
  }
  const live = useDawStore.getState();
  const announcedDuringRun = live.statusAnnouncementSeq !== toldBefore;
  const toldDuringRun =
    announcedDuringRun &&
    ((result.reason !== "" &&
      (live.statusAnnouncement.includes(result.reason) ||
        live.statusAnnouncement.includes(plainError(result.reason)))) ||
      (live.feedbackToast?.id === live.statusAnnouncementSeq &&
        live.feedbackToast.tone === "error"));
  if (!toldDuringRun) {
    live.announceStatus(result.reason, { tone: "error" });
  }
  return result;
}
