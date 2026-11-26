import { useCallback, useEffect, useState } from "react";
import { type KitListRow, loadKits } from "../api";
import { errorMessage } from "../utils/apiError";

export type KitLibraryState = {
  rows: readonly KitListRow[] | null;
  error: string | null;
  reload: () => void;
};

/**
 * Reads the kit list each time `enabled` turns true and on `reload()`; a guest passes
 * false and never asks. A failed read drops the rows it had, so the list never offers
 * an action on data the studio could not confirm.
 */
export function useKitLibrary(enabled: boolean): KitLibraryState {
  const [rows, setRows] = useState<readonly KitListRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Each reload() swaps in a new token, which re-runs the read below.
  const [readToken, setReadToken] = useState<object>({});

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoadError(null);
    loadKits(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setRows(list);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setRows(null);
        setLoadError(errorMessage(failure, "Couldn't read the kits."));
      });
    return () => controller.abort();
  }, [enabled, readToken]);

  const reload = useCallback(() => setReadToken({}), []);

  return { rows, error: loadError, reload };
}
