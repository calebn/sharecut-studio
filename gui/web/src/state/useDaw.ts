import { useDawStore } from "./dawStore";
import type { DawState } from "./types";

/** Compatibility facade over the sliced Zustand store. */
export function useDaw(): DawState {
  return useDawStore();
}

/** Subscribe to a ProjectView field so hydrate of other keys can bail out. */
export function useProjectField<
  K extends keyof NonNullable<DawState["project"]>,
>(key: K): NonNullable<DawState["project"]>[K] | undefined {
  return useDawStore((s) => s.project?.[key]);
}
