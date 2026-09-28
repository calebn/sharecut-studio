import { formatRulerTime } from "../utils/time";
import type { TranscriptIntent } from "./transcriptModeCopy";

/** Seek time in a word tooltip: m:ss.s, the ruler's tenth-of-a-second form. */
export function wordSeekLabel(sec: number): string {
  return formatRulerTime(sec, 0.1);
}

/** Tooltip for a transcript word chip: what click and double-click do in this intent. */
export function wordInteractionTip(opts: {
  intent: TranscriptIntent;
  wordIndex: number | null | undefined;
  seekSec: number | null | undefined;
  inlineEditable: boolean;
}): string | undefined {
  const { intent, wordIndex, seekSec, inlineEditable } = opts;
  if (intent === "correct") {
    return wordIndex != null
      ? "Click to select for Correct · Double-click to seek"
      : undefined;
  }
  if (intent === "select") {
    return wordIndex != null
      ? "Click or drag to select a range · Shift+click to extend · Double-click to seek"
      : undefined;
  }
  if (seekSec == null) {
    return undefined;
  }
  if (inlineEditable) {
    return `Click to seek to ${wordSeekLabel(seekSec)} · Double-click to fix text`;
  }
  return `Double-click to seek to ${wordSeekLabel(seekSec)}`;
}
