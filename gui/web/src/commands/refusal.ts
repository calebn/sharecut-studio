import { useDawStore } from "../state/dawStore";
import type { ExecuteResult } from "./types";

/**
 * Runs a palette command and tells the user when it was refused, at error tone
 * (the palette is an explicit ask, so every refusal is worth saying). A command
 * that already told the failure in its own words is not overwritten by the bare
 * reason, which would drop the action it names ("Refresh failed: …"): it either
 * says so with `told`, or its announcement still standing after the run carries
 * the reason. An unrelated announcement that does not carry the reason never
 * hides a refusal. The keyboard listener keeps its own policy of speaking only
 * for commands that change the project.
 */
export async function runAndAnnounceRefusal(
  run: () => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  const result = await run();
  if (result.status !== "disabled" || result.told) {
    return result;
  }
  const live = useDawStore.getState();
  if (!live.statusAnnouncement.includes(result.reason)) {
    live.announceStatus(result.reason, { tone: "error" });
  }
  return result;
}
