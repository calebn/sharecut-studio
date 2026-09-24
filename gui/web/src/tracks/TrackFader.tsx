import { useEffect, useEffectEvent, useRef, useState } from "react";
import { execute } from "../commands/execute";
import { canEditMix } from "../shareMode";
import { useDaw } from "../state/useDaw";
import type { TrackView } from "../types/project";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  formatDb,
} from "./trackMix";

/**
 * A track's saved volume (``fader_db``) on top of its staging gain. The thumb
 * moves locally while dragging; the native ``change`` event (release, or each
 * arrow-key step) sends one SetTrackFader. Double-click resets to 0 dB.
 * Only the host and editors can change it; other guests see it read-only.
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

  const id = `track-fader-${track.id}`;
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
          editable
            ? "Saved volume. Double-click to reset to 0 dB"
            : "Only the host and editors can change the volume"
        }
        aria-valuetext={formatDb(value)}
        onChange={(e) => {
          draggingRef.current = true;
          setValue(Number(e.currentTarget.value));
        }}
        onDoubleClick={() => {
          if (editable) {
            setValue(0);
            commit(0);
          }
        }}
      />
      <output htmlFor={id} className="track-fader-value">
        {formatDb(value)}
      </output>
      <p className="track-fader-note">
        Staging gain {formatDb(track.gain_db)}; plays at{" "}
        {formatDb(track.gain_db + value)}
      </p>
    </div>
  );
}
