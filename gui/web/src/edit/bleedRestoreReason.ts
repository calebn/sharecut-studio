import type { BleedAttenuationRegion } from "./bleedAttenuation";
import type { ClipBleedAction, ClipBleedRead } from "./clipBleedSession";

export const CHECKING = "Checking automatic regions…";
export function bleedBusyLabel(
  action: ClipBleedAction | undefined,
): string | null {
  if (action?.state === "saving") return "Saving Restore choice…";
  if (action?.state === "undoing") return "Undoing Restore choice…";
  return null;
}

const REFRESH_FIRST = "Refresh regions before restoring audio.";

export function bleedRestoreReason({
  busyLabel,
  read,
  stale,
  permissionReason,
  selected,
}: {
  busyLabel: string | null;
  read: ClipBleedRead;
  stale: boolean;
  permissionReason: string | undefined;
  selected: BleedAttenuationRegion<unknown> | undefined;
}): string | undefined {
  if (busyLabel) return busyLabel;
  if (read.state === "loading") return CHECKING;
  if (read.state === "error") return REFRESH_FIRST;
  if (read.inspection.regions.length === 0)
    return "There are no automatic regions to restore. Refresh regions to check again.";
  if (stale) return "This region changed. Refresh regions and select it again.";
  if (permissionReason !== undefined) return permissionReason;
  if (!selected) return "Select one automatic region below.";
  if (selected.restore.state === "unavailable") return selected.restore.reason;
  if (selected.restore.state === "saved")
    return "A Restore choice already covers this interval.";
  return undefined;
}
