import { runPointerCommand } from "../commands/pointer";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import { trackFaderDb } from "../utils/audio";
import { TrackFaderView } from "./TrackFaderView";

export function TrackFader({ track }: { track: TrackView }) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const editable = canEditMix(projectPath, guestMode, shareCapabilities);
  return (
    <TrackFaderView
      trackLabel={track.label || track.id}
      savedDb={trackFaderDb(track)}
      access={
        editable
          ? {
              kind: "edit",
              onCommit: (db) =>
                runPointerCommand("track.setVolume", { trackId: track.id, db }),
            }
          : { kind: "read-only" }
      }
      presentation={{
        kind: "detailed",
        stagingDb: track.gain_db,
        balance:
          track.role === "dialogue"
            ? {
                state:
                  track.balance_stale == null
                    ? "not-measured"
                    : track.balance_stale
                      ? "stale"
                      : "current",
                measuredLufs: track.balance_measured_lufs ?? null,
                ungated: track.balance_ungated ?? false,
              }
            : null,
      }}
    />
  );
}
