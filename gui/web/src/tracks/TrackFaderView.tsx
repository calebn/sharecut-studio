import { type ReactNode, useId } from "react";
import { useCommitRange } from "../hooks/useCommitRange";
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

export type FaderPresentation = {
  kind: "compact";
  descriptionId: string;
  stagingDb?: number;
  playsAt?: (baseDb: number) => ReactNode;
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
  const input = (
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
      aria-describedby={presentation.descriptionId}
      aria-valuetext={formatGainDb(value)}
      onDoubleClick={() => {
        if (editable) {
          reset();
        }
      }}
      {...range.inputProps}
    />
  );
  const { playsAt, stagingDb } = presentation;
  return (
    <div className="track-fader track-fader--compact">
      {input}
      {playsAt?.(
        trackOutputGainDb({
          gain_db: stagingDb ?? 0,
          fader_db: value,
        }),
      )}
      <output htmlFor={id} className="track-fader-value">
        {formatGainDb(value)}
      </output>
    </div>
  );
}
