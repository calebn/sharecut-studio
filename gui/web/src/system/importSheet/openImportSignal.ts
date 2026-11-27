import { useLayoutEffect, useSyncExternalStore } from "react";

let holds = 0;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Marks an import sheet as showing; the returned function ends the mark, once. */
export function holdOpenImport(): () => void {
  holds += 1;
  announce();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    holds -= 1;
    announce();
  };
}

/** Whether any import host (Home, the Library sheet, a received file) has a sheet or a file in hand. */
export function openImportBusy(): boolean {
  return holds > 0;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenImportBusy(): boolean {
  return useSyncExternalStore(subscribe, openImportBusy, () => false);
}

/** Holds the mark while `active`; a layout effect, so it is set before any passive effect looks. */
export function useHoldOpenImport(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    return holdOpenImport();
  }, [active]);
}

export function _resetOpenImportForTests(): void {
  holds = 0;
  listeners.clear();
}
