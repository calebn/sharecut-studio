import type { ReactNode, Ref } from "react";
import { useId } from "react";
import { joinLengthMaxMs } from "../edit/fadeLimits";
import {
  JOIN_GLYPHS,
  JOIN_MODE_SHORT,
  type JoinGlyph,
  joinGlyph,
  joinLengthMs,
  joinModeLabel,
  joinRenderNote,
  joinSeamLabel,
} from "../edit/joinRender";
import { useCommitRange } from "../hooks/useCommitRange";
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
  onLengthCommit: (ms: number) => void;
  onClose: () => void;
  /** Audition row; the live adapter passes InspectorSeekFooter. */
  footer: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
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
  onLengthCommit,
  onClose,
  footer,
  panelRef,
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
  const saved = Math.min(maxMs, Math.max(minMs, joinLengthMs(left, right)));
  const range = useCommitRange({ saved, onCommit: onLengthCommit });
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
              disabled={busy}
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
      {editable && glyph !== "cut" ? (
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
