import { useEffect, useRef } from "react";

export interface FileMeta {
  mtime_ns: number;
  size?: number;
  exists?: boolean;
  server_seq?: number;
}

// Sockets deliver in-process changes immediately; this sanity poll only
// catches writes made by other processes (#662).
export const SANITY_POLL_MS = 30_000;

/**
 * Poll a meta endpoint; call onChange when mtime_ns, size or server_seq changes.
 * First successful meta read only baselines — does not fire onChange.
 * A focus / visibility check while the baseline read is in flight is skipped.
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

    const tick = async () => {
      if (busyRef.current || cancelled) {
        return;
      }
      busyRef.current = true;
      try {
        const meta = await fetchMetaRef.current();
        if (cancelled) {
          return;
        }
        if (meta.exists === false) {
          return;
        }
        const changed =
          mtimeRef.current !== null &&
          (meta.mtime_ns !== mtimeRef.current ||
            (meta.size !== undefined && meta.size !== sizeRef.current) ||
            (meta.server_seq !== undefined &&
              seqRef.current !== undefined &&
              meta.server_seq !== seqRef.current));
        mtimeRef.current = meta.mtime_ns;
        if (meta.size !== undefined) {
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
        busyRef.current = false;
      }
    };

    // The baseline holds busyRef like tick(), so a focus / visibility check
    // fired before it lands cannot race it and overwrite the refs out of order.
    busyRef.current = true;
    void fetchMetaRef.current().then(
      (meta) => {
        busyRef.current = false;
        if (!cancelled && meta.exists !== false) {
          mtimeRef.current = meta.mtime_ns;
          sizeRef.current = meta.size;
          if (meta.server_seq !== undefined) {
            seqRef.current = meta.server_seq;
          }
        }
      },
      () => {
        busyRef.current = false;
      },
    );

    const id = window.setInterval(() => {
      void tick();
    }, intervalMs);
    const onFocus = () => {
      if (document.visibilityState !== "hidden") {
        void tick();
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
