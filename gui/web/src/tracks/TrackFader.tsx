import { execute } from "../commands/execute";
import { useCommitRange } from "../hooks/useCommitRange";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import { Button } from "../ui";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  formatGainDb,
  trackFaderDb,
  trackOutputGainDb,
} from "../utils/audio";

/**
 * A track's saved volume (``fader_db``) on top of its staging gain. The thumb
 * moves locally while dragging; each native ``change`` (release, or an arrow
 * key step) runs track.setVolume, which saves the last value of a burst.
 * Double-click or Reset sets 0 dB. Only the host and editors can change it;
 * other guests see it read-only, with the reason under it.
 */
export function TrackFader({ track }: { track: TrackView }) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const editable = canEditMix(projectPath, guestMode, shareCapabilities);
  const saved = trackFaderDb(track);
  const range = useCommitRange({
    saved,
    onCommit: (db) =>
      void execute(
        "track.setVolume",
        { trackId: track.id, db },
        { skipWhen: true },
      ),
  });
  const { value } = range;
  const reset = () => range.commitValue(0);

  const id = `track-fader-${track.id}`;
  const noteId = `${id}-note`;
  return (
    <div className="track-fader">
      <label htmlFor={id} className="track-fader-label">
        Volume
      </label>
      <input
        id={id}
        className="track-fader-input"
        type="range"
        min={FADER_MIN_DB}
        max={FADER_MAX_DB}
        step={FADER_STEP_DB}
        disabled={!editable}
        title={
          editable ? "Saved volume. Double-click to reset to 0 dB" : undefined
        }
        aria-describedby={noteId}
        aria-valuetext={formatGainDb(value)}
        onDoubleClick={() => {
          if (editable) {
            reset();
          }
        }}
        {...range.inputProps}
      />
      <span className="track-fader-end">
        <output htmlFor={id} className="track-fader-value">
          {formatGainDb(value)}
        </output>
        {editable ? (
          <Button
            aria-label="Reset volume to 0 dB"
            disabled={value === 0}
            onClick={() => {
              reset();
              // Reset disables itself at 0 dB; keep keyboard focus nearby.
              range.input?.focus();
            }}
          >
            Reset
          </Button>
        ) : null}
      </span>
      <p id={noteId} className="track-fader-note">
        {editable ? "" : "Only the host and editors can change the volume. "}
        Staging gain {formatGainDb(track.gain_db)}; plays at{" "}
        {formatGainDb(
          trackOutputGainDb({ gain_db: track.gain_db, fader_db: value }),
        )}
      </p>
    </div>
  );
}
