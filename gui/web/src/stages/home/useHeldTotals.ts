import { useRef } from "react";
import { type DownloadTotals, holdTotals } from "./homeModel";

/** The download's totals, never falling back until the download is over. */
export function useHeldTotals(
  next: DownloadTotals | null,
): DownloadTotals | null {
  const held = useRef<DownloadTotals | null>(null);
  held.current = holdTotals(held.current, next);
  return held.current;
}
