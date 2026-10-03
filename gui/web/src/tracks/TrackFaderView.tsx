import { useId } from "react";
import { useCommitRange } from "../hooks/useCommitRange";
import { Button } from "../ui/Button";
import {
  FADER_MAX_DB,
  FADER_MIN_DB,
  FADER_STEP_DB,
  formatGainDb,
  trackOutputGainDb,
} from "../utils/audio";

export type FaderAccess =
  | { kind: "edit"; onCommit: (db: number) => void }
  | { kind: "read-only"; onCommit?: never };

export type BalancePresentation = Readonly<{
  state: "not-measured" | "stale" | "current";
  measuredLufs: number | null;
  ungated: boolean;
}>;

export type FaderPresentation = {
  kind: "detailed";
  stagingDb: number;
  balance: BalancePresentation | null;
};

export type TrackFaderViewProps = {
  trackLabel: string;
  savedDb: number;
  access: FaderAccess;
  presentation: FaderPresentation;
};

export function TrackFaderView({
  trackLabel,
  savedDb,
  access,
  presentation,
}: TrackFaderViewProps) {
  const editable = access.kind === "edit";
  const range = useCommitRange({
    saved: savedDb,
    onCommit: (db) => {
      if (access.kind === "edit") {
        access.onCommit(db);
      }
    },
  });
  const { value } = range;
  const reset = () => range.commitValue(0);
  const id = useId();
  const noteId = `${id}-note`;
  const { stagingDb, balance } = presentation;

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
        aria-label={`Volume ${trackLabel}`}
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
              range.input?.focus();
            }}
          >
            Reset
          </Button>
        ) : null}
      </span>
      <p id={noteId} className="track-fader-note">
        {editable ? "" : "Only the host and editors can change the volume. "}
        Staging gain {formatGainDb(stagingDb)}; plays at{" "}
        {formatGainDb(
          trackOutputGainDb({ gain_db: stagingDb, fader_db: value }),
        )}
      </p>
      {balance ? (
        <p className="track-fader-note">
          Balance{" "}
          {balance.state === "not-measured" ? "not measured" : balance.state}
          {balance.measuredLufs == null
            ? ""
            : ` · ${balance.measuredLufs.toFixed(1)} LUFS${balance.ungated ? " · ungated" : ""}`}
        </p>
      ) : null}
    </div>
  );
}
