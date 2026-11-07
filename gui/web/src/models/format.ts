import type { ModelState } from "./types";

/** Decimal units, matching the registry's size labels ("~1.6 GB"). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${Math.round(bytes / 1_000_000)} MB`;
  }
  if (bytes >= 1_000) {
    return `${Math.round(bytes / 1_000)} KB`;
  }
  return `${bytes} B`;
}

/** "420 MB of 1.6 GB", or the bytes so far when the total is unknown. */
export function progressText(
  state: Extract<ModelState, { kind: "downloading" }>,
): string {
  return state.total != null
    ? `${formatBytes(state.bytes)} of ${formatBytes(state.total)}`
    : `${formatBytes(state.bytes)} downloaded`;
}
