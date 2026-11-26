import { useCallback, useEffect, useRef, useState } from "react";
import { type KitListRow, loadKits } from "../api";
import { HIGHLIGHT_MS } from "../segments/useSegmentLibrary";
import { errorMessage } from "../utils/apiError";

export type KitLibraryState = {
  rows: readonly KitListRow[] | null;
  error: string | null;
  /** The kit a save just added or changed; it clears itself. */
  highlightId: string | null;
  reload: () => void;
  /** Reads the list again and marks one kit, which may not be listed until the read ends. */
  reveal: (id: string) => void;
};

/**
 * Reads the kit list each time `enabled` turns true and on `reload()`; a guest passes
 * false and never asks. A failed read drops the rows it had, so the list never offers
 * an action on data the studio could not confirm.
 */
export function useKitLibrary(enabled: boolean): KitLibraryState {
  const [rows, setRows] = useState<readonly KitListRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
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
        if (pending.current !== null) {
          setHighlightId(pending.current);
          pending.current = null;
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setRows(null);
        setLoadError(errorMessage(failure, "Couldn't read the kits."));
      });
    return () => controller.abort();
  }, [enabled, readToken]);

  useEffect(() => {
    if (highlightId === null) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const reload = useCallback(() => setReadToken({}), []);
  const reveal = useCallback((id: string) => {
    pending.current = id;
    setReadToken({});
  }, []);

  return { rows, error: loadError, highlightId, reload, reveal };
}
