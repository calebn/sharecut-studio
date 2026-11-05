import { useEffect, useRef, useState } from "react";

/** Seconds of watching before the rate is steady enough to name a time. */
const MIN_WATCH_SECONDS = 3;

type Mark = { at: number; bytes: number };

/**
 * Time left at the average rate since `first`, or null until enough has been
 * seen (or when nothing moved, which would say forever).
 */
export function estimateSecondsLeft(
  first: Mark,
  now: Mark,
  total: number,
): number | null {
  const seconds = (now.at - first.at) / 1000;
  const moved = now.bytes - first.bytes;
  if (seconds < MIN_WATCH_SECONDS || moved <= 0) return null;
  return Math.max(0, (total - now.bytes) / (moved / seconds));
}

/**
 * How long a download has left, from the bytes it reports. Null while the
 * total is unknown or the first few seconds have not told a rate yet; starts
 * over when the bytes fall back (a new download).
 */
export function useSecondsLeft(
  bytes: number | null,
  total: number | null,
): number | null {
  const first = useRef<Mark | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (bytes === null || total === null) {
      first.current = null;
      setLeft(null);
      return;
    }
    const now = { at: Date.now(), bytes };
    if (first.current === null || bytes < first.current.bytes) {
      first.current = now;
      setLeft(null);
      return;
    }
    setLeft(estimateSecondsLeft(first.current, now, total));
  }, [bytes, total]);
  return left;
}
