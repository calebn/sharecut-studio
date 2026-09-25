import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "./dawStore";
import type { DawState } from "./types";

/**
 * Read the DAW store through a selector, compared with `useShallow`.
 *
 * Select exactly the keys a component uses. Return primitives, store
 * references, or objects/tuples of those; build derived arrays or objects
 * with `useMemo` outside the selector. `useShallow` compares one level deep,
 * so a fresh array or object in the result re-renders on every store change.
 * `state/storeGovernance.test.ts` rejects only whole-store reads (no selector
 * or an inline arrow identity selector such as `(s) => s`); the derived-value
 * rule is enforced in review.
 */
export function useDaw<T>(selector: (s: DawState) => T): T {
  return useDawStore(useShallow(selector));
}
