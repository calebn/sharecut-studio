import { useEffect, useRef } from "react";
import { SANITY_POLL_MS } from "../state/syncCadence";

export { SANITY_POLL_MS } from "../state/syncCadence";

export interface FileMeta {
  mtime_ns: number;
  size?: number;
  exists?: boolean;
  server_seq?: number;
}

/**
 * Poll a meta endpoint; call onChange when mtime_ns, size or server_seq changes.
 * First successful meta read only baselines — does not fire onChange.
 * A focus / visibility check while the baseline read is in flight is skipped.
 * A read from a run that was cleaned up (re-render with new enabled / intervalMs, unmount) never releases the next run's busy flag.
 * server_seq counts only between two readings: a response without it (the
 * server could not read document.db) is ignored for the seq comparison.
 * Also checks at once when the window regains focus or the tab becomes visible.
 */
export function useFileMetaPoll(
  enabled: boolean,
  fetchMeta: () => Promise<FileMeta>,
  onChange: (meta: FileMeta) => void | Promise<void>,
  intervalMs = SANITY_POLL_MS,
): void {
  const mtimeRef = useRef<number | null>(null);
  const sizeRef = useRef<number | null | undefined>(null);
  const seqRef = useRef<number | undefined>(undefined);
  const busyRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const fetchMetaRef = useRef(fetchMeta);
  onChangeRef.current = onChange;
  fetchMetaRef.current = fetchMeta;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;

    // One read for the baseline and every later check. The baseline claims
    // busyRef even if a cancelled run's read is still in flight; later checks
    // skip while it is held. A read releases the flag only while its run is
    // current, so a stale read landing after a re-run (StrictMode remount, a
    // guest socket flap toggling `enabled`) cannot free the new run's flag.
    const read = async (baseline: boolean) => {
      if (cancelled || (!baseline && busyRef.current)) {
        return;
      }
      busyRef.current = true;
      try {
        const meta = await fetchMetaRef.current();
        if (cancelled || meta.exists === false) {
          return;
        }
        const changed =
          !baseline &&
          mtimeRef.current !== null &&
          (meta.mtime_ns !== mtimeRef.current ||
            (meta.size !== undefined && meta.size !== sizeRef.current) ||
            (meta.server_seq !== undefined &&
              seqRef.current !== undefined &&
              meta.server_seq !== seqRef.current));
        mtimeRef.current = meta.mtime_ns;
        if (baseline || meta.size !== undefined) {
          sizeRef.current = meta.size;
        }
        if (meta.server_seq !== undefined) {
          seqRef.current = meta.server_seq;
        }
        if (changed) {
          await onChangeRef.current(meta);
        }
      } catch {
        // Transient
      } finally {
        if (!cancelled) {
          busyRef.current = false;
        }
      }
    };
    const tick = () => {
      void read(false);
    };

    void read(true);

    const id = window.setInterval(() => {
      tick();
    }, intervalMs);
    const onFocus = () => {
      if (document.visibilityState !== "hidden") {
        tick();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [enabled, intervalMs]);
}
