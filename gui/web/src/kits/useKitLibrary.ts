import { useCallback, useEffect, useState } from "react";
import { type KitListRow, loadKits } from "../api";
import { errorMessage } from "../utils/apiError";

export type KitLibraryState = {
  rows: readonly KitListRow[] | null;
  error: string | null;
  reload: () => void;
};

/** Reads the kit list once while `enabled`; a guest passes false and never asks. */
export function useKitLibrary(enabled: boolean): KitLibraryState {
  const [rows, setRows] = useState<readonly KitListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void round;
    setError(null);
    loadKits(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setRows(list);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(failure, "Couldn't read the kits."));
      });
    return () => controller.abort();
  }, [enabled, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);

  return { rows, error, reload };
}
