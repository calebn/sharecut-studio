import type { ModelFailure, ModelState } from "./types";

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

/** The progress bar's spoken value: "420 MB of 1.6 GB", or the bytes so far when the total is unknown. */
export function progressText(
  state: Extract<ModelState, { kind: "downloading" }>,
): string {
  return state.total != null
    ? `${formatBytes(state.bytes)} of ${formatBytes(state.total)}`
    : `${formatBytes(state.bytes)} downloaded`;
}

const HINTS: Record<NonNullable<ModelFailure["kind"]>, string> = {
  http: "Try again in a few minutes.",
  network: "Check your internet connection, then retry.",
  disk: "Free some disk space or fix the folder, then retry.",
  pin_mismatch:
    "Retry the download. If it fails again, save a problem report from Help, Export diagnostics.",
};

/** What to do next for a typed failure; untyped text gets the general advice. */
export function failureHint(failure: ModelFailure): string {
  return failure.kind
    ? HINTS[failure.kind]
    : "Retry, or save a problem report from Help, Export diagnostics.";
}

export function stateText(state: ModelState): string {
  switch (state.kind) {
    case "installed":
      return "Installed";
    case "missing":
      return "Not downloaded";
    case "update_needed":
      return "Update available";
    case "queued":
      return "Waiting";
    case "downloading":
      return "Downloading";
    case "failed":
      return "Download failed";
  }
}

export function tierText(tier: "required" | "recommended" | "offered") {
  return tier === "offered"
    ? "Optional"
    : tier === "required"
      ? "Required"
      : "Recommended";
}

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
