import {
  type ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  FixTextField,
  type FixTextVia,
} from "../../../stages/edit/FixTextField";
import { useDawStore } from "../../../state/dawStore";
import type { ScriptPaneHandle } from "../../../system/ScriptPane";
import type { FixTextVia as AskedVia } from "../../../system/scriptGesture";
import type { ScriptSpan } from "../../../system/scriptPieces";
import { submitWordCorrection } from "../../../transcript/wordCorrection";
import { errorMessage } from "../../../utils/apiError";
import { useStableCallback } from "../../../utils/useStableCallback";
import { type ScriptModel, wordsTargetOf } from "./scriptModel";

export const FIX_ACROSS_TRACKS =
  "Fix text works on one speaker at a time. Select words from one speaker.";

export type ScriptFixTextProps = {
  editing: ScriptSpan | null;
  renderEditor: (span: ScriptSpan) => ReactNode;
  /** Left out when the viewer may not fix text. */
  onFixText: ((span: ScriptSpan, via: AskedVia) => void) | undefined;
};

/**
 * Fix text on the Script (Enter, F2 or double-click on words). It is the
 * host's own and an Editor guest's is not offered, as in the old panel: only a
 * host with its words loaded may correct them. A phrase is one correction on
 * one track, so a span across tracks is refused before the field opens.
 * Commit sends the words the field opened with as the expected text; a refusal
 * keeps the field open with the reason under it.
 */
export function useScriptFixText(
  model: ScriptModel,
  texts: readonly string[],
  pane: RefObject<ScriptPaneHandle | null>,
  enabled: boolean,
  say: (message: string) => void,
  onTab: () => void,
): ScriptFixTextProps {
  const [open, setOpen] = useState<ScriptSpan | null>(null);
  const editing = enabled ? open : null;
  const focusAfter = useRef<number | null>(null);

  const close = (span: ScriptSpan) => {
    focusAfter.current = span.start;
    setOpen(null);
  };
  // The editor's span unmounts, so the host puts focus back on the word.
  useLayoutEffect(() => {
    if (editing !== null || focusAfter.current === null) return;
    const at = focusAfter.current;
    focusAfter.current = null;
    pane.current?.focusWord(at);
  });

  const onFixText = useStableCallback((span: ScriptSpan) => {
    const target = wordsTargetOf(model, {
      kind: "words",
      anchor: span.start,
      head: span.end,
    });
    if (target?.kind !== "track") {
      useDawStore
        .getState()
        .announceStatus(FIX_ACROSS_TRACKS, { tone: "error" });
      return;
    }
    setOpen(span);
  });

  const commit = async (
    span: ScriptSpan,
    text: string | null,
    via: FixTextVia,
    original: string,
  ): Promise<void | string> => {
    if (text === null) {
      close(span);
      return;
    }
    const target = wordsTargetOf(model, {
      kind: "words",
      anchor: span.start,
      head: span.end,
    });
    if (target?.kind !== "track") return FIX_ACROSS_TRACKS;
    try {
      await submitWordCorrection(
        useDawStore.getState().projectPath,
        target.trackId,
        target.startWordIndex,
        target.endWordIndex,
        text,
        original,
        target.sourceId,
      );
    } catch (reason) {
      const message = errorMessage(reason);
      say(`Text not fixed. ${message}`);
      return message;
    }
    say(`Text fixed: ${text}`);
    close(span);
    if (via === "tab") onTab();
  };

  const renderEditor = (span: ScriptSpan) => {
    const count = span.end - span.start + 1;
    const value = texts.slice(span.start, span.end + 1).join(" ");
    return (
      <FixTextField
        value={value}
        label={count === 1 ? "Fix text" : `Fix text, ${count} words`}
        onDone={(text, via, original) => commit(span, text, via, original)}
      />
    );
  };

  return {
    editing,
    renderEditor,
    onFixText: enabled ? onFixText : undefined,
  };
}
