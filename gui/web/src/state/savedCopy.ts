import { createContext, useContext } from "react";
import { isShareProjectKey } from "../shareMode";
import type { DawState } from "./types";
import { useDaw } from "./useDaw";

/**
 * A guest is reading the saved copy because the server was not reached: a share
 * project the link's answer never gave capabilities for. The copy opens
 * read-only, so the link's role is not known there.
 */
function readsSavedCopy(
  state: Pick<DawState, "projectPath" | "shareCapabilities">,
): boolean {
  return (
    isShareProjectKey(state.projectPath) && state.shareCapabilities === null
  );
}

export function useReadsSavedCopy(): boolean {
  return useDaw(readsSavedCopy);
}

export const SavedCopyDateContext = createContext<number | null>(null);

export function useSavedCopyDate(): number | null {
  return useContext(SavedCopyDateContext);
}

const reopenListeners = new Set<() => void>();

export function requestSavedCopyReopen(): void {
  for (const listener of [...reopenListeners]) listener();
}

export function subscribeSavedCopyReopen(listener: () => void): () => void {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
}
