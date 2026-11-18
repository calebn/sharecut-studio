import { isShareProjectKey } from "../utils/can";
import type { DawState } from "./types";
import { useDaw } from "./useDaw";

/**
 * A guest is reading the saved copy because the server was not reached: a share
 * project the link's answer never gave capabilities for. The copy opens
 * read-only, so the link's role is not known there.
 */
export function readsSavedCopy(
  state: Pick<DawState, "projectPath" | "shareCapabilities">,
): boolean {
  return (
    isShareProjectKey(state.projectPath) && state.shareCapabilities === null
  );
}

export function useReadsSavedCopy(): boolean {
  return useDaw(readsSavedCopy);
}
