import { useDaw } from "../state/useDaw";
import type { PreviewMode } from "../utils/playRange";
import {
  playAbRange,
  playSuggestedRange,
  playTimelineRange,
} from "../utils/playRange";
import { Button } from "./Button";
import { SegmentedControl } from "./SegmentedControl";
import { ToggleButton } from "./ToggleButton";

type Props = {
  seekSec: number;
  playStart: number;
  playEnd: number;
  padSec?: number;
  seekLabel?: string;
  playLabel?: string;
  showPlay?: boolean;
  previewMode?: PreviewMode;
  onPreviewModeChange?: (mode: PreviewMode) => void;
  suggestDisabled?: boolean;
  suggestDisabledReason?: string | null;
};

const PREVIEW_MODES: { id: PreviewMode; label: string }[] = [
  { id: "current", label: "Current" },
  { id: "suggested", label: "Suggested" },
  { id: "ab", label: "A/B" },
];

/** Shared seek + play-around footer for modifier inspectors. */
export function InspectorSeekFooter({
  seekSec,
  playStart,
  playEnd,
  padSec,
  seekLabel = "Seek",
  playLabel = "Play around",
  showPlay = true,
  previewMode,
  onPreviewModeChange,
  suggestDisabled = false,
  suggestDisabledReason,
}: Props) {
  const { setPlayheadSec, setPlayUntilSec, setIsPlaying, beginAudition } =
    useDaw((s) => ({
      setPlayheadSec: s.setPlayheadSec,
      setPlayUntilSec: s.setPlayUntilSec,
      setIsPlaying: s.setIsPlaying,
      beginAudition: s.beginAudition,
    }));

  const play = () => {
    const mode = previewMode ?? "current";
    if (mode === "suggested" && !suggestDisabled) {
      playSuggestedRange({
        skipStart: playStart,
        skipEnd: playEnd,
        padSec,
        beginAudition,
      });
      return;
    }
    if (mode === "ab" && !suggestDisabled) {
      playAbRange({
        skipStart: playStart,
        skipEnd: playEnd,
        padSec,
        beginAudition,
      });
      return;
    }
    playTimelineRange({
      start: playStart,
      end: playEnd,
      padSec,
      beginAudition,
      setPlayheadSec,
      setPlayUntilSec,
      setIsPlaying,
    });
  };

  return (
    <div className="modifier-footer-actions">
      <Button variant="link" onClick={() => setPlayheadSec(seekSec)}>
        {seekLabel}
      </Button>
      {showPlay ? (
        <Button variant="link" onClick={play}>
          {playLabel}
        </Button>
      ) : null}
      {onPreviewModeChange && suggestDisabled && suggestDisabledReason ? (
        <span id="preview-mode-skip-reason" className="sr-only">
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
                  blocked && suggestDisabledReason
                    ? "preview-mode-skip-reason"
                    : undefined
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
