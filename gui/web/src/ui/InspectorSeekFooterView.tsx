import type { PreviewMode } from "../utils/playRange";
import { Button } from "./Button";
import { unavailableReason, useDisabledReasonNote } from "./disabledReason";
import { Icon } from "./Icon";
import { SegmentedControl } from "./SegmentedControl";
import { ToggleButton } from "./ToggleButton";

export interface InspectorSeekFooterViewProps {
  seekLabel?: string;
  playLabel?: string;
  showPlay?: boolean;
  previewMode?: PreviewMode;
  onPreviewModeChange?: (mode: PreviewMode) => void;
  /** Why Suggested and A/B are unavailable; null or undefined leaves them enabled. */
  suggestDisabledReason?: string | null;
  /** Why the play action is unavailable (e.g. guests hear Full mix only); undefined leaves it enabled. */
  playDisabledReason?: string;
  /** Seconds the play action has been preparing; null or undefined when it is not. */
  playBusySec?: number | null;
  /** Seek action; the live adapter moves the DAW playhead. */
  onSeek: () => void;
  /** Play action; the live adapter auditions the range in the chosen preview mode. */
  onPlay: () => void;
}

const PREVIEW_MODES: { id: PreviewMode; label: string }[] = [
  { id: "current", label: "Current" },
  { id: "suggested", label: "Suggested" },
  { id: "ab", label: "A/B" },
];

/**
 * Props-only seek + play-around footer for modifier inspectors. Seek and play
 * are always buttons with an icon (#701). The live `InspectorSeekFooter`
 * adapter supplies DAW-store seek and audition callbacks.
 */
export function InspectorSeekFooterView({
  seekLabel = "Seek",
  playLabel = "Play around",
  showPlay = true,
  previewMode,
  onPreviewModeChange,
  suggestDisabledReason,
  playDisabledReason,
  playBusySec,
  onSeek,
  onPlay,
}: InspectorSeekFooterViewProps) {
  const busy = playBusySec != null;
  const playReason = unavailableReason(playDisabledReason);
  const { note: playNote, describedBy: playDescribedBy } =
    useDisabledReasonNote(busy ? undefined : playReason);
  return (
    <>
      <div className="modifier-footer-actions">
        <Button onClick={onSeek}>
          <Icon name="seek" />
          {seekLabel}
        </Button>
        {showPlay ? (
          <Button
            onClick={playReason ? (event) => event.preventDefault() : onPlay}
            aria-busy={busy || undefined}
            {...(playReason
              ? { "aria-disabled": true, ...playDescribedBy }
              : {})}
          >
            {playBusySec != null ? (
              <span className="pipeline-pulse" aria-hidden="true" />
            ) : (
              <Icon name="play" />
            )}
            {playBusySec != null
              ? `Preparing this preview… ${playBusySec}s`
              : playLabel}
          </Button>
        ) : null}
        {onPreviewModeChange ? (
          <SegmentedControl label="Preview mode" className="preview-modes">
            {PREVIEW_MODES.map((m) => {
              const blocked = m.id !== "current" && !!suggestDisabledReason;
              return (
                <ToggleButton
                  key={m.id}
                  quiet
                  pressed={previewMode === m.id}
                  disabledReason={
                    blocked ? (suggestDisabledReason ?? undefined) : undefined
                  }
                  onClick={() => onPreviewModeChange(m.id)}
                >
                  {m.label}
                </ToggleButton>
              );
            })}
          </SegmentedControl>
        ) : null}
      </div>
      {playNote}
    </>
  );
}
