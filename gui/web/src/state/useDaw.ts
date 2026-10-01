import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "./dawStore";
import type { DawState } from "./types";

/**
 * Read the DAW store through a selector, compared with `useShallow`.
 *
 * Select exactly the values a component uses. Use `pickDaw` for plain fields
 * and a custom selector for conditional projections of primitives or store
 * references. Build derived arrays or objects with `useMemo` outside the
 * selector. `useShallow` compares one level deep, so fresh top-level selector
 * objects keep their reference when their values are unchanged.
 * `state/storeGovernance.test.ts` rejects whole-store reads and checks hot
 * fields selected through `pickDaw`.
 */
export function useDaw<T>(selector: (s: DawState) => T): T {
  return useDawStore(useShallow(selector));
}

export function pickDaw<K extends keyof DawState>(
  ...keys: K[]
): (state: DawState) => Pick<DawState, K> {
  return (state) =>
    Object.fromEntries(keys.map((key) => [key, state[key]])) as Pick<
      DawState,
      K
    >;
}
