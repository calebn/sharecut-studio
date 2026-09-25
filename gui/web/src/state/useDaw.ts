import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "./dawStore";
import type { DawState } from "./types";

/**
 * Read the DAW store through a selector, compared with `useShallow`.
 *
 * Select exactly the keys a component uses. Return primitives, store
 * references, or objects/tuples of those; build derived arrays or objects
 * with `useMemo` outside the selector (`state/storeGovernance.test.ts`).
 */
export function useDaw<T>(selector: (s: DawState) => T): T {
  return useDawStore(useShallow(selector));
}
