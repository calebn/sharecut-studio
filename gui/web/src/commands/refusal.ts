import { useDawStore } from "../state/dawStore";
import type { ExecuteResult } from "./types";

/**
 * Runs a command and tells the user when it was refused. The refusal is spoken
 * at error tone, the way the keyboard does for commands that change the
 * project. A command that already told the failure in its own words and says so
 * (`told`) is left alone: Refresh mix announces "Refresh failed: …", and the
 * bare reason would replace the action it names.
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
