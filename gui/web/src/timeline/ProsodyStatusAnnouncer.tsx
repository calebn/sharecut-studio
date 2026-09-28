import type { ProsodyOverlay } from "../types/prosody";
import { prosodyStatusSummary } from "./prosodyGeometry";

/** The Prosody layer's single live region: lane labels are plain text, so N lanes do not announce N times (#732 review). */
export function ProsodyStatusAnnouncer({
  overlay,
}: {
  overlay: ProsodyOverlay | null;
}) {
  const summary = overlay ? prosodyStatusSummary(overlay.tracks) : null;
  return (
    <div className="sr-only" role="status">
      {summary ?? ""}
    </div>
  );
}
