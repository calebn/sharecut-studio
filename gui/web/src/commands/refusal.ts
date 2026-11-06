import { useDawStore } from "../state/dawStore";
import type { ExecuteResult } from "./types";

export function announceRefusal(result: ExecuteResult): ExecuteResult {
  if (
    result.status === "disabled" &&
    !result.told &&
    result.reason.trim().length > 0
  ) {
    useDawStore.getState().announceStatus(result.reason, { tone: "error" });
  }
  return result;
}

export async function runAndAnnounceRefusal(
  run: () => Promise<ExecuteResult>,
): Promise<ExecuteResult> {
  return announceRefusal(await run());
}
