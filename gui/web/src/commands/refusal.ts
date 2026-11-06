import { useDawStore } from "../state/dawStore";
import type { ExecuteResult } from "./types";

/**
 * Runs a palette command and tells the user when it was refused, at error tone
 * (the palette is an explicit ask, so every refusal is worth saying). A result
 * marked `told` is left alone: Refresh mix announces "Refresh failed: …", and the
 * bare reason would replace the action it names. The keyboard listener keeps its
 * own policy of speaking only for commands that change the project.
 */
export async function runAndAnnounceRefusal(
  run: () => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  const result = await run();
  if (result.status === "disabled" && !result.told) {
    useDawStore.getState().announceStatus(result.reason, { tone: "error" });
  }
  return result;
}
