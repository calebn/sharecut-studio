import type { ReactNode, Ref } from "react";
import { useId } from "react";
import { joinLengthMaxMs } from "../edit/fadeLimits";
import {
  JOIN_GLYPHS,
  JOIN_MODE_SHORT,
  type JoinGlyph,
  joinGlyph,
  joinModeLabel,
  joinRenderNote,
  joinSeamLabel,
} from "../edit/joinRender";
import type { ClipRow } from "../types/project";
import {
  CloseButton,
  InlineError,
  SegmentedControl,
  ToggleButton,
} from "../ui";

export interface JoinPopoverViewProps {
  id: string;
  /** Committed rows either side of the seam (left may be rolled by a live roll). */
  left: ClipRow;
  right: ClipRow;
  seamSec: number;
  /** TrackView.fade_max_ms (null = uncapped). */
  trackFadeMaxMs: number | null;
  editable: boolean;
  busy: boolean;
  error: string | null;
  onModeChange: (mode: JoinGlyph) => void;
  onClose: () => void;
  /** Audition row; the live adapter passes InspectorSeekFooter. */
  footer: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
  lengthControl: {
    value: number;
    inputProps: React.InputHTMLAttributes<HTMLInputElement> & {
      ref: Ref<HTMLInputElement>;
    };
  };
}

/** Props-only join popover: mode toggles, a length slider and the audition footer. */
export function JoinPopoverView({
  id,
  left,
  right,
  seamSec,
  trackFadeMaxMs,
  editable,
  busy,
  error,
  onModeChange,
  onClose,
  footer,
  panelRef,
  lengthControl,
}: JoinPopoverViewProps) {
  const titleId = useId();
  const lengthId = useId();
  const glyph = joinGlyph(right);
  const minMs = glyph === "crossfade" ? 1 : 0;
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
    <div
      ref={panelRef}
      id={id}
      className="join-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <div className="join-popover-header">
        <h2 id={titleId} className="join-popover-title">
          {joinSeamLabel(glyph, seamSec)}
        </h2>
        <CloseButton onClick={onClose} />
      </div>
      {editable ? (
        <SegmentedControl label="Join mode" className="join-popover-modes">
          {JOIN_GLYPHS.map((m) => (
            <ToggleButton
              key={m}
              quiet
              pressed={glyph === m}
              disabled={busy || (m === "crossfade" && maxMs < 1)}
              title={joinModeLabel(m)}
              onClick={() => {
                if (m !== glyph) {
                  onModeChange(m);
                }
              }}
            >
              {JOIN_MODE_SHORT[m]}
            </ToggleButton>
          ))}
        </SegmentedControl>
      ) : (
        <p className="join-popover-mode">{joinModeLabel(right.join_in_mode)}</p>
      )}
      {editable && glyph !== "cut" && maxMs >= minMs ? (
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
      {glyph === "crossfade" && left.fade_out_ms !== right.fade_in_ms ? (
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
      <InlineError message={error} role="alert" />
      {footer}
    </div>
  );
}
