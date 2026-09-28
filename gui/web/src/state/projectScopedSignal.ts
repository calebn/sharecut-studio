import { useDawStore } from "./dawStore";

/**
 * An AbortSignal that aborts once the DAW store's `projectPath` moves away from
 * `projectPath` (a project switch). Call `dispose()` when the work settles so
 * the store subscription is dropped.
 */
export function projectScopedSignal(projectPath: string): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const ac = new AbortController();
  const unsubscribe = useDawStore.subscribe((state) => {
    if (state.projectPath !== projectPath) {
      unsubscribe();
      ac.abort(new DOMException("Project changed", "AbortError"));
    }
  });
  return { signal: ac.signal, dispose: unsubscribe };
}
