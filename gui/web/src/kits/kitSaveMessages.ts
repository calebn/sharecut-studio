import { type KitSaveResult, kitSaveRefusal } from "../api";
import { errorMessage } from "../utils/apiError";

export const KIT_SAVE_FAILED = "The kit didn't save. Try again.";

const REFUSALS = {
  kit_name_invalid:
    "A kit name needs at least one letter or digit from a to z.",
  kit_segment_missing:
    "A segment in this kit was removed from the library. Remove it from the list, then save again.",
  kit_busy: "Another action is using the kit library. Try again.",
  kit_write_failed:
    "The kit library couldn't be written to. Check that there is room on the disk, then try again.",
  kit_no_room:
    "There is no room left for the kit. Free some disk space, then try again.",
} as const;

/** The failure line for a refused or failed save; the studio's own words for `kit_invalid`. */
export function kitSaveMessage(error: unknown): string {
  const refusal = kitSaveRefusal(error);
  if (refusal === null || refusal === "kit_invalid") {
    return errorMessage(error, KIT_SAVE_FAILED);
  }
  return REFUSALS[refusal];
}

export function kitSavedMessage(
  name: string,
  result: KitSaveResult,
  count: number,
): string {
  if (result.status === "unchanged") {
    return `${name} already has these segments. Nothing changed.`;
  }
  if (result.status === "new_version") {
    return `Saved a new version of ${name} (v${result.version}). The earlier version is kept.`;
  }
  return `Saved the kit ${name} with ${count} ${count === 1 ? "segment" : "segments"}.`;
}
