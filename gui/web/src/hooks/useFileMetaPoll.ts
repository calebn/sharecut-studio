import { useEffect, useRef } from "react";

export interface FileMeta {
  mtime_ns: number;
  size?: number;
  exists?: boolean;
  server_seq?: number;
}

const DEFAULT_POLL_MS = 1500;

/**
 * Poll a meta endpoint; call onChange when mtime (or size) changes.
 * First successful meta read only baselines — does not fire onChange.
 */
export function useFileMetaPoll(
  enabled: boolean,
  fetchMeta: () => Promise<FileMeta>,
  onChange: (meta: FileMeta) => void | Promise<void>,
  intervalMs = DEFAULT_POLL_MS,
): void {
  const mtimeRef = useRef<number | null>(null);
  const sizeRef = useRef<number | null | undefined>(null);
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
            (meta.size !== undefined && meta.size !== sizeRef.current));
        mtimeRef.current = meta.mtime_ns;
        if (meta.size !== undefined) {
          sizeRef.current = meta.size;
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

    void fetchMetaRef
      .current()
      .then((meta) => {
        if (!cancelled && meta.exists !== false) {
          mtimeRef.current = meta.mtime_ns;
          sizeRef.current = meta.size;
        }
      })
      .catch(() => undefined);

    const id = window.setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled, intervalMs]);
}
