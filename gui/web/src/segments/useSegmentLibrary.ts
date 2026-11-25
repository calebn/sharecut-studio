import { useCallback, useEffect, useRef, useState } from "react";
import { loadSegments, removeSegment, type SegmentListRow } from "../api";
import { ApiError, errorMessage } from "../utils/apiError";

export const SEGMENT_BUSY_MESSAGE =
  "Another action is using this segment. Try again.";

export type SegmentLibraryState = {
  rows: readonly SegmentListRow[] | null;
  error: string | null;
  reload: () => void;
  remove: (id: string) => Promise<string | null>;
};

export function useSegmentLibrary(enabled = true): SegmentLibraryState {
  const [rows, setRows] = useState<readonly SegmentListRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const gone = useRef(false);

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
    loadSegments(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setRows(list);
        setLoadError(null);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(failure, "Couldn't read the library."));
      });
    return () => controller.abort();
  }, [enabled, round]);

  const reload = useCallback(() => {
    setLoadError(null);
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

  return { rows, error: loadError, reload, remove };
}
