import type { StateCreator, StoreApi } from "zustand";
import { shallow } from "zustand/shallow";

/**
 * A zustand middleware plus the `batch()` it is driven by. Calls to `set`
 * (the creator's own `set`, `api.setState`, or a store-wide `useX.setState`)
 * made while a batch is open fold into one pending full-state object instead
 * of writing straight through; `get`/`api.getState` inside the batch see
 * that pending state (read-your-writes); listeners fire once, at the
 * outermost batch's exit, with the pre-batch state as `previousState` — the
 * same shape a single `set()` call gives them.
 */
export type WriteBatch<T> = {
  middleware: (
    config: StateCreator<T, [], [], T>,
  ) => StateCreator<T, [], [], T>;
  /** Runs `fn`, batching every store write made inside it into one commit. */
  batch: <R>(fn: () => R) => R;
};

/** Creates one write-batch pair. Each DAW store instance gets its own. */
export function createWriteBatch<T extends object>(): WriteBatch<T> {
  let depth = 0;
  let pending: T | null = null;
  let baseAtEntry: T | null = null;
  let rawSet: StoreApi<T>["setState"] = () => {
    throw new Error("write batch used before the store was created");
  };
  let rawGet: StoreApi<T>["getState"] = () => {
    throw new Error("write batch used before the store was created");
  };

  const batchedSet: StoreApi<T>["setState"] = (partial, replace) => {
    if (depth === 0) {
      rawSet(partial as never, replace as never);
      return;
    }
    const base = pending ?? rawGet();
    const patch =
      typeof partial === "function"
        ? (partial as (state: T) => T | Partial<T>)(base)
        : partial;
    pending = (replace ? patch : Object.assign({}, base, patch)) as T;
  };

  const batchedGet: StoreApi<T>["getState"] = () => pending ?? rawGet();

  function batch<R>(fn: () => R): R {
    if (depth === 0) {
      baseAtEntry = rawGet();
    }
    depth += 1;
    try {
      return fn();
    } finally {
      depth -= 1;
      if (depth === 0) {
        const toCommit = pending;
        const base = baseAtEntry;
        pending = null;
        baseAtEntry = null;
        // Mimics zustand's own no-op rule: a batch that changed nothing (no
        // writes at all, or writes that landed back on the pre-batch state)
        // never calls the underlying setState, so listeners are not notified.
        if (toCommit && base && !shallow(toCommit, base)) {
          rawSet(toCommit, true);
        }
      }
    }
  }

  /**
   * Swaps `api.setState` / `api.getState` in place rather than composing
   * through zustand's middleware chain, so it must stay the only middleware
   * on the store (or wrap the slice creator directly, inside every other
   * one). An outer middleware that captured the original `api.setState`
   * would bypass batching, and an inner one would read the batch's pending
   * state from `getState()`. Adding `persist`, `devtools` or
   * `subscribeWithSelector` needs a test that batching and read-your-writes
   * still hold.
   */
  const middleware =
    (config: StateCreator<T, [], [], T>): StateCreator<T, [], [], T> =>
    (_set, _get, api) => {
      rawSet = api.setState.bind(api);
      rawGet = api.getState.bind(api);
      api.setState = batchedSet;
      api.getState = batchedGet;
      return config(batchedSet, batchedGet, api);
    };

  return { middleware, batch };
}
