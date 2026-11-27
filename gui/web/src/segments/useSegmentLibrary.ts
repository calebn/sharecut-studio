import { useCallback, useEffect, useRef, useState } from "react";
import { loadSegments, removeSegment, type SegmentListRow } from "../api";
import { ApiError, errorMessage } from "../utils/apiError";
import { LIBRARY_CHANGED_EVENT, segmentIdOf } from "./libraryChanged";

export const SEGMENT_BUSY_MESSAGE =
  "Another action is using this segment. Try again.";

export const HIGHLIGHT_MS = 4000;

export type SegmentLibraryState = {
  rows: readonly SegmentListRow[] | null;
  error: string | null;
  /** The row an import just added or matched; it clears itself. */
  highlightId: string | null;
  reload: () => void;
  /** Reloads the list and marks one row, which may not be in the list yet. */
  reveal: (id: string) => void;
  remove: (id: string) => Promise<string | null>;
};

export function useSegmentLibrary(enabled = true): SegmentLibraryState {
  const [rows, setRows] = useState<readonly SegmentListRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const gone = useRef(false);
  const pending = useRef<string | null>(null);

  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void round;
    setLoadError(null);
    loadSegments(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setRows(list);
        setLoadError(null);
        if (pending.current !== null) {
          setHighlightId(pending.current);
          pending.current = null;
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(failure, "Couldn't read the library."));
      });
    return () => controller.abort();
  }, [enabled, round]);

  useEffect(() => {
    if (!enabled) return;
    const changed = (event: Event) => {
      const id = segmentIdOf(event);
      if (id !== undefined) pending.current = id;
      setRound((n) => n + 1);
    };
    window.addEventListener(LIBRARY_CHANGED_EVENT, changed);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, changed);
  }, [enabled]);

  useEffect(() => {
    if (highlightId === null) return;
    const timer = window.setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const reload = useCallback(() => {
    setRound((n) => n + 1);
  }, []);

  const reveal = useCallback((id: string) => {
    pending.current = id;
    setRound((n) => n + 1);
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await removeSegment(id);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 409) {
        return SEGMENT_BUSY_MESSAGE;
      }
      if (!(failure instanceof ApiError && failure.status === 404)) {
        return errorMessage(failure, "Couldn't remove the segment.");
      }
    }
    if (!gone.current) {
      setRows((current) =>
        current ? current.filter((row) => row.id !== id) : current,
      );
      setRound((n) => n + 1);
    }
    return null;
  }, []);

  return { rows, error: loadError, highlightId, reload, reveal, remove };
}
