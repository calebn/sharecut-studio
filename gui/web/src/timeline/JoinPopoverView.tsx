import type { Ref } from "react";
import { useId } from "react";
import { joinLengthMaxMs } from "../edit/fadeLimits";
import { joinModeLabel, joinRenderNote } from "../edit/joinRender";
import type { ClipRow, JoinMode } from "../types/project";
import { InlineError, SegmentedControl, ToggleButton } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import { JOIN_MODE_OPTIONS, joinModeOf } from "../utils/editMarkerRegistry";

export interface JoinPopoverViewProps {
  /** Committed rows either side of the seam (left may be rolled by a live roll). */
  left: ClipRow;
  right: ClipRow;
  /** TrackView.fade_max_ms (null = uncapped). */
  trackFadeMaxMs: number | null;
  editable: boolean;
  busy: boolean;
  error: string | null;
  onModeChange: (mode: JoinMode) => void;
  lengthControl: {
    value: number;
    inputProps: React.InputHTMLAttributes<HTMLInputElement> & {
      ref: Ref<HTMLInputElement>;
    };
  };
}

/** Props-only join editor body: mode toggles and a length slider. The `Dialog` around it owns the title, Close and the audition footer. */
export function JoinPopoverView({
  left,
  right,
  trackFadeMaxMs,
  editable,
  busy,
  error,
  onModeChange,
  lengthControl,
}: JoinPopoverViewProps) {
  const lengthId = useId();
  const mode = joinModeOf(right);
  const minMs = mode === "crossfade" ? 1 : 0;
  const maxMs = joinLengthMaxMs(
    {
      durationSec: left.source_end - left.source_start,
      fadeInMs: left.fade_in_ms,
    },
    { durationSec: right.source_end - right.source_start },
    trackFadeMaxMs,
  );
  const range = lengthControl;
  const note = joinRenderNote(right);

  return (
    <>
      {editable ? (
        <SegmentedControl label="Join mode" className="join-popover-modes">
          {JOIN_MODE_OPTIONS.map(({ value: m, short }) => (
            <ToggleButton
              key={m}
              quiet
              pressed={mode === m}
              disabledReason={
                busy
                  ? BUSY_REASON
                  : m === "crossfade" && maxMs < 1
                    ? "These clips are too short to crossfade."
                    : undefined
              }
              title={joinModeLabel(m)}
              onClick={() => {
                if (m !== mode) {
                  onModeChange(m);
                }
              }}
            >
              {short}
            </ToggleButton>
          ))}
        </SegmentedControl>
      ) : (
        <p className="join-popover-mode">{joinModeLabel(right.join_in_mode)}</p>
      )}
      {editable && mode !== "cut" && maxMs >= minMs ? (
        <div className="join-popover-length">
          <label htmlFor={lengthId}>Length</label>
          <input
            id={lengthId}
            type="range"
            min={minMs}
            max={maxMs}
            step={1}
            disabled={busy || maxMs <= minMs}
            aria-valuetext={`${range.value} ms`}
            {...range.inputProps}
          />
          <output htmlFor={lengthId} className="join-popover-length-value">
            {range.value} ms
          </output>
        </div>
      ) : null}
      {mode === "crossfade" && left.fade_out_ms !== right.fade_in_ms ? (
        <p className="ui-field-hint">
          Stored fades {left.fade_out_ms} ms out / {right.fade_in_ms} ms in.
          Length editing sets both fades equally.
        </p>
      ) : null}
      {maxMs < minMs ? (
        <p className="ui-field-hint">
          No positive crossfade length is available.
        </p>
      ) : null}
      {note ? (
        <p className="ui-field-hint" role="status">
          {note}
        </p>
      ) : null}
      <InlineError message={error} />
    </>
  );
}
