import { useDawStore } from "../state/dawStore";
import {
  isRangeStep,
  selectedWordsMessage,
  stepWordSpan,
} from "../utils/rangeSelect";
import { findTranscriptWord } from "../utils/transcript";
import { registerCommand } from "./execute";
import type { ExecuteResult } from "./types";

/**
 * `transcript.extendRange`: move one edge of the selected word range by one
 * word. The touch route to the range a mouse drag makes, and a plain button
 * for keyboards and screen readers. It only changes the selection.
 */
export function registerTranscriptRangeCommands(): void {
  registerCommand("transcript.extendRange", (args): ExecuteResult => {
    const s = useDawStore.getState();
    const selection = s.selection;
    if (!s.project || selection?.kind !== "transcriptRange") {
      return { status: "disabled", reason: "Select transcript words first" };
    }
    if (!isRangeStep(args)) {
      return { status: "disabled", reason: "Choose which edge to move" };
    }
    const project = s.project;
    const result = stepWordSpan(
      selection,
      args,
      (wordIndex) =>
        findTranscriptWord(
          project,
          selection.trackId,
          wordIndex,
          selection.sourceId,
        ) !== null,
    );
    if (!result.ok) {
      return { status: "disabled", reason: result.reason };
    }
    s.setSelection({
      kind: "transcriptRange",
      trackId: selection.trackId,
      ...(selection.sourceId != null ? { sourceId: selection.sourceId } : {}),
      ...result.span,
    });
    s.announceStatus(selectedWordsMessage(result.span), { toast: false });
    return { status: "ok" };
  });
}
