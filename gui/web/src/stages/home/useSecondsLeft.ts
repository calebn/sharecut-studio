import { useEffect, useRef, useState } from "react";

const MIN_WATCH_SECONDS = 3;

/** Seconds without a new byte before the estimate is dropped: a stalled download names no time. */
const STALL_SECONDS = 10;

/** An estimate longer than this is a guess from a rate that has not settled, so it is not shown. */
const MAX_SECONDS_LEFT = 6 * 3600;

type Mark = { at: number; bytes: number };

/**
 * Time left at the average rate since `first`, or null until enough has been
 * seen (when nothing moved, or when the rate says hours).
 */
export function estimateSecondsLeft(
  first: Mark,
  now: Mark,
  total: number,
): number | null {
  const seconds = (now.at - first.at) / 1000;
  const moved = now.bytes - first.bytes;
  if (seconds < MIN_WATCH_SECONDS || moved <= 0) return null;
  const left = Math.max(0, (total - now.bytes) / (moved / seconds));
  return left > MAX_SECONDS_LEFT ? null : left;
}

/**
 * How long a download has left, from the bytes it reports. Null while the
 * total is unknown or the first few seconds have not told a rate yet; starts
 * over when the bytes fall back (a new download) and goes quiet when they
 * stop moving.
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
    const stalled = window.setTimeout(
      () => setLeft(null),
      STALL_SECONDS * 1000,
    );
    return () => window.clearTimeout(stalled);
  }, [bytes, total]);
  return left;
}
