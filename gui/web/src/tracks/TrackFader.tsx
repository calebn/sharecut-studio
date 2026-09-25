import { useEffect, useEffectEvent, useRef, useState } from "react";
import { execute } from "../commands/execute";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import { Button } from "../ui";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  formatGainDb,
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
  const { projectPath, guestMode, shareCapabilities } = useDaw();
  const editable = canEditMix(projectPath, guestMode, shareCapabilities);
  const saved = track.fader_db ?? 0;
  const [value, setValue] = useState(saved);
  const inputRef = useRef<HTMLInputElement>(null);
  const draggingRef = useRef(false);

  // Follow the saved value (undo, a collaborator) unless mid-drag.
  useEffect(() => {
    if (!draggingRef.current) {
      setValue(saved);
    }
  }, [saved]);

  const commit = (db: number) => {
    draggingRef.current = false;
    if (db !== saved) {
      void execute(
        "track.setVolume",
        { trackId: track.id, db },
        { skipWhen: true },
      );
    }
  };
  const reset = () => {
    setValue(0);
    commit(0);
  };
  const onNativeChange = useEffectEvent((db: number) => commit(db));

  // React's onChange fires on every input; the native change event is the
  // commit (pointer release or a key step).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    const onChange = () => onNativeChange(Number(el.value));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);

  // A drag released where it started fires no change event; stop ignoring
  // the saved value anyway.
  const endDrag = () => {
    draggingRef.current = false;
  };

  const id = `track-fader-${track.id}`;
  const noteId = `${id}-note`;
  return (
    <div className="track-fader">
      <label htmlFor={id} className="track-fader-label">
        Volume
      </label>
      <input
        ref={inputRef}
        id={id}
        className="track-fader-input"
        type="range"
        min={FADER_MIN_DB}
        max={FADER_MAX_DB}
        step={FADER_STEP_DB}
        value={value}
        disabled={!editable}
        title={
          editable ? "Saved volume. Double-click to reset to 0 dB" : undefined
        }
        aria-describedby={noteId}
        aria-valuetext={formatGainDb(value)}
        onChange={(e) => {
          draggingRef.current = true;
          setValue(Number(e.currentTarget.value));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onBlur={endDrag}
        onDoubleClick={() => {
          if (editable) {
            reset();
          }
        }}
      />
      <output htmlFor={id} className="track-fader-value">
        {formatGainDb(value)}
      </output>
      {editable ? (
        <Button
          className="ui-control--compact"
          aria-label="Reset volume to 0 dB"
          disabled={value === 0}
          onClick={reset}
        >
          Reset
        </Button>
      ) : null}
      <p id={noteId} className="track-fader-note">
        {editable
          ? `Staging gain ${formatGainDb(track.gain_db)}; plays at ${formatGainDb(
              trackOutputGainDb({ gain_db: track.gain_db, fader_db: value }),
            )}`
          : "Only the host and editors can change the volume"}
      </p>
    </div>
  );
}
