import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
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
import { type ScriptModel, type ScriptWordRef } from "./scriptModel";

export const FIX_ACROSS_TRACKS =
  "Fix text works on one speaker at a time. Select words from one speaker.";
export const FIX_CUT_TEXT = "Text that was cut out cannot be fixed.";
export const FIX_MOVED = "That text changed. Close this and try again.";
export const FIX_OFF = "Fix text is not available now.";

export type ScriptFixTextProps = {
  editing: ScriptSpan | null;
  renderEditor: (span: ScriptSpan) => ReactNode;
  /** Left out when the viewer may not fix text. */
  onFixText: ((span: ScriptSpan, via: AskedVia) => void) | undefined;
};

/**
 * The words Fix text opened on, named by the project and not by window index,
 * so a word added or removed earlier cannot move the field onto other words.
 */
type Pinned = {
  first: ScriptWordRef & { wordIndex: number };
  last: ScriptWordRef & { wordIndex: number };
};

/**
 * The field open on the last Script, so a shell change that remounts the Script
 * (a rotation to another layout) keeps it, as the old panel's store-held state did.
 */
let held: { projectPath: string; pin: Pinned } | null = null;

/** Drop the held field; for tests that start from a clean Script. */
export function forgetHeldFixText(): void {
  held = null;
}

const addressable = (
  ref: ScriptWordRef | undefined,
): ref is ScriptWordRef & { wordIndex: number } =>
  ref !== undefined && ref.wordIndex !== null;

/**
 * Fix text on the Script (Enter, F2 or double-click on words). It is the
 * host's own and an Editor guest's is not offered, as in the old panel: only a
 * host with its words settled may correct them. A phrase is one correction on
 * one track, so a span across tracks is refused before the field opens, and so
 * is one that holds cut-out words. Commit sends the words the field opened with
 * as the expected text; a refusal keeps the field open with the reason under
 * it. When Tab fixes the text, the jump to the next unsure word is announced
 * together with the fix and focus follows the jump.
 */
export function useScriptFixText(
  model: ScriptModel,
  texts: readonly string[],
  pane: RefObject<ScriptPaneHandle | null>,
  enabled: boolean,
  say: (message: string) => void,
  onTab: (note: string) => number | undefined,
): ScriptFixTextProps {
  const [pinned, setPinnedState] = useState<Pinned | null>(() => {
    const path = useDawStore.getState().projectPath;
    return held?.projectPath === path ? held.pin : null;
  });
  const setPinned = (pin: Pinned | null) => {
    held = pin
      ? { projectPath: useDawStore.getState().projectPath, pin }
      : null;
    setPinnedState(pin);
  };
  // A field opened before the right was lost must not come back with it. A
  // Script that mounts before its words settle keeps the field it was handed.
  const wasEnabled = useRef(enabled);
  if (enabled) wasEnabled.current = true;
  if (!enabled && wasEnabled.current && pinned !== null) setPinned(null);
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;
  const focusAfter = useRef<{ index: number; tries: number } | null>(null);

  const editing = useMemo<ScriptSpan | null>(() => {
    if (!pinned) return null;
    const start = model.indexOf(pinned.first, "first");
    const end = model.indexOf(pinned.last, "last");
    return start === undefined || end === undefined || end < start
      ? null
      : { start, end };
  }, [pinned, model]);

  const close = (focusIndex: number) => {
    focusAfter.current = { index: focusIndex, tries: 0 };
    setPinned(null);
  };
  // The editor's span unmounts, so the host puts focus back on a word. A word
  // the pane does not draw yet gets one more render to arrive.
  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (editing !== null || want === null) return;
    if (pane.current?.focusWord(want.index) || want.tries >= 2) {
      focusAfter.current = null;
    } else {
      want.tries += 1;
    }
  });

  const onFixText = useStableCallback((span: ScriptSpan) => {
    const refs = model.refs.slice(span.start, span.end + 1);
    const first = refs[0];
    const last = refs[refs.length - 1];
    const announce = (message: string) =>
      useDawStore.getState().announceStatus(message, { tone: "error" });
    let cut = false;
    for (let at = span.start; at <= span.end; at++) cut ||= model.isCut(at);
    if (cut) {
      announce(FIX_CUT_TEXT);
      return;
    }
    const lane = (ref: ScriptWordRef) => `${ref.trackId}:${ref.sourceId}`;
    if (
      !addressable(first) ||
      !addressable(last) ||
      refs.some((ref) => lane(ref) !== lane(first))
    ) {
      announce(FIX_ACROSS_TRACKS);
      return;
    }
    setPinned({ first, last });
  });

  const commit = useStableCallback(
    async (
      pin: Pinned,
      text: string | null,
      via: FixTextVia,
      original: string,
    ): Promise<void | string> => {
      const where = model.indexOf(pin.first, "first") ?? 0;
      if (text === null) {
        close(where);
        return;
      }
      if (!enabledNow.current) return FIX_OFF;
      // The words are still where the field opened on them.
      if (editing === null) return FIX_MOVED;
      try {
        await submitWordCorrection(
          useDawStore.getState().projectPath,
          pin.first.trackId,
          pin.first.wordIndex,
          pin.last.wordIndex,
          text,
          original,
          pin.first.sourceId,
        );
      } catch (reason) {
        const message = errorMessage(reason);
        say(`Text not fixed. ${message}`);
        return message;
      }
      const done = `Text fixed: ${text}`;
      // The right was lost while the correction was sent: it is written, but the
      // Script no longer moves the reader.
      if (!enabledNow.current) {
        say(done);
        return;
      }
      if (via === "tab") {
        const landed = onTab(done);
        close(landed ?? where);
        return;
      }
      say(done);
      close(where);
    },
  );

  // The Fix text command (F2, the verb) asks for the words it was run on.
  const request = useDawStore((s) => s.transcriptInlineEditRequest);
  useEffect(() => {
    if (!request) return;
    const store = useDawStore.getState();
    store.setTranscriptInlineEditRequest(null);
    if (!enabledNow.current || request.projectPath !== store.projectPath)
      return;
    const lane = {
      trackId: request.trackId,
      sourceId: request.sourceId ?? null,
    };
    const start = model.indexOf(
      { ...lane, wordIndex: request.wordIndex },
      "first",
    );
    const end = model.indexOf(
      { ...lane, wordIndex: request.endWordIndex ?? request.wordIndex },
      "last",
    );
    if (start === undefined || end === undefined || end < start) return;
    onFixText({ start, end });
  }, [request, model, onFixText]);

  const renderEditor = (span: ScriptSpan) => {
    const count = span.end - span.start + 1;
    const value = texts.slice(span.start, span.end + 1).join(" ");
    const pin = pinned;
    return (
      <FixTextField
        value={value}
        label={count === 1 ? "Fix text" : `Fix text, ${count} words`}
        onDone={(text, via, original) =>
          pin ? commit(pin, text, via, original) : Promise.resolve(FIX_MOVED)
        }
      />
    );
  };

  return {
    editing: enabled ? editing : null,
    renderEditor,
    onFixText: enabled ? onFixText : undefined,
  };
}
