import { useId } from "react";
import type { PreviewMode } from "../utils/playRange";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { ToggleButton } from "./ToggleButton";

export interface InspectorSeekFooterViewProps {
  seekLabel?: string;
  playLabel?: string;
  showPlay?: boolean;
  previewMode?: PreviewMode;
  onPreviewModeChange?: (mode: PreviewMode) => void;
  suggestDisabled?: boolean;
  suggestDisabledReason?: string | null;
  /** Seek and play buttons: quiet links (default) or full buttons. */
  actionVariant?: "link" | "default";
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
 * Props-only seek + play-around footer for modifier inspectors. The live
 * `InspectorSeekFooter` adapter supplies DAW-store seek and audition callbacks.
 */
export function InspectorSeekFooterView({
  seekLabel = "Seek",
  playLabel = "Play around",
  showPlay = true,
  previewMode,
  onPreviewModeChange,
  suggestDisabled = false,
  suggestDisabledReason,
  actionVariant = "link",
  onSeek,
  onPlay,
}: InspectorSeekFooterViewProps) {
  const reasonId = useId();
  return (
    <div className="modifier-footer-actions">
      <Button variant={actionVariant} onClick={onSeek}>
        {seekLabel}
      </Button>
      {showPlay ? (
        <Button variant={actionVariant} onClick={onPlay}>
          {playLabel}
        </Button>
      ) : null}
      {onPreviewModeChange && suggestDisabled && suggestDisabledReason ? (
        <span id={reasonId} className="sr-only">
          {suggestDisabledReason}
        </span>
      ) : null}
      {onPreviewModeChange ? (
        <SegmentedControl label="Preview mode" className="preview-modes">
          {PREVIEW_MODES.map((m) => {
            const blocked = m.id !== "current" && suggestDisabled;
            return (
              <ToggleButton
                key={m.id}
                quiet
                pressed={previewMode === m.id}
                disabled={blocked}
                title={
                  blocked ? (suggestDisabledReason ?? undefined) : undefined
                }
                aria-describedby={
                  blocked && suggestDisabledReason ? reasonId : undefined
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
  );
}
