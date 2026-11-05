import { useDawStore } from "./dawStore";

type ProjectSignalScope =
  | { lifetime: "path"; path: string }
  | { lifetime: "document"; path: string; epoch: number };

/**
 * Abort a path-owned server operation when its physical project path changes.
 * A document-owned UI operation also ends when that document's epoch changes.
 * Call dispose() on settlement to release the store subscription.
 */
export function projectScopedSignal(scope: ProjectSignalScope): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const ac = new AbortController();
  const unsubscribe = useDawStore.subscribe((state) => {
    if (
      state.projectPath !== scope.path ||
      (scope.lifetime === "document" && state.projectEpoch !== scope.epoch)
    ) {
      unsubscribe();
      ac.abort(new DOMException("Project changed", "AbortError"));
    }
  });
  return { signal: ac.signal, dispose: unsubscribe };
}
