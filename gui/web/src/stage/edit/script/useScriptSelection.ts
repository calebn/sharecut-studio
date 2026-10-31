import { useMemo, useState } from "react";
import { makeRangeTarget } from "../../../edit/rangeSelection";
import { useDawStore } from "../../../state/dawStore";
import type {
  ScriptCaret,
  ScriptSelection,
  WordsSelection,
} from "../../../system/scriptPieces";
import type { EditBoundaryView } from "../../../types/project";
import { useStableCallback } from "../../../utils/useStableCallback";
import {
  type ScriptModel,
  scriptReviewSelectionOf,
  wordsTargetOf,
} from "./scriptModel";

const NO_CARETS: readonly ScriptCaret[] = [];
const NO_BOUNDARIES: readonly EditBoundaryView[] = [];

export type ScriptSelectionProps = {
  selection: ScriptSelection | null;
  carets: readonly ScriptCaret[];
  /** Left out when the viewer may not select: the pane then reads only. */
  onSelect: ((selection: WordsSelection) => void) | undefined;
  onCaret: (before: number) => void;
  onClearSelection: () => void;
  /** Left out with `onSelect`: a seam is picked by someone who may select. */
  onSeamSelect: ((id: string) => void) | undefined;
  onSuggestionSelect: ((id: string) => void) | undefined;
};

/**
 * The pane's selection and caret against the store. The store is written only
 * from these handlers, never from an effect. Words on one track become a
 * `transcriptRange`; words across tracks become a `range` over that time on
 * every track they touch, which the pane draws back as its first to last word.
 */
export function useScriptSelection(
  model: ScriptModel,
  mayRange: boolean,
  /** The window edge hook: told where a settled selection or caret lands. */
  reached: (index: number) => void,
): ScriptSelectionProps {
  const stored = useDawStore((s) => s.selection);
  const [caret, setCaret] = useState<number | undefined>(undefined);
  const boundaries = useDawStore((s) => s.project?.edit_boundaries);
  const openJoinId = useDawStore((s) => s.openJoinId);
  const selection = useMemo(
    () =>
      scriptReviewSelectionOf(
        model,
        stored,
        boundaries ?? NO_BOUNDARIES,
        openJoinId,
      ),
    [model, stored, boundaries, openJoinId],
  );
  const carets = useMemo(
    () => (caret === undefined || selection ? NO_CARETS : [{ before: caret }]),
    [caret, selection],
  );

  const onSelect = useStableCallback((next: WordsSelection) => {
    reached(next.head);
    const target = wordsTargetOf(model, next);
    if (!target) return;
    // A click selects the one word and keeps the caret there, as the old panel
    // did: the caret shows again when the selection is cleared, and Shift
    // extends from it. A longer selection replaces the caret.
    if (next.anchor !== next.head) setCaret(undefined);
    const { setSelection, project } = useDawStore.getState();
    if (target.kind === "track") {
      setSelection({
        kind: "transcriptRange",
        trackId: target.trackId,
        sourceId: target.sourceId,
        startWordIndex: target.startWordIndex,
        endWordIndex: target.endWordIndex,
      });
      return;
    }
    const range = project
      ? makeRangeTarget(
          project,
          [{ start: target.start, end: target.end }],
          target.trackIds,
        )
      : null;
    if (range) setSelection({ kind: "range", target: range });
  });
  const onCaret = useStableCallback((before: number) => {
    reached(before);
    setCaret(before);
  });
  const onClearSelection = useStableCallback(() => {
    const { setSelection, setOpenJoinId } = useDawStore.getState();
    setSelection(null);
    setOpenJoinId(null);
  });
  // A seam is the join the timeline opens by its right clip (the join
  // popover), and a suggestion is the pending edit the timeline selects.
  const onSeamSelect = useStableCallback((id: string) => {
    const state = useDawStore.getState();
    const clipId = state.project?.edit_boundaries?.find(
      (b) => b.id === id,
    )?.right_clip_id;
    if (!clipId || state.joinMutationInFlight) return;
    state.setSelection(null);
    state.setOpenJoinId(clipId);
  });
  const onSuggestionSelect = useStableCallback((id: string) => {
    const { project, setSelection, setOpenJoinId } = useDawStore.getState();
    const edit = project?.pending_edits.find((e) => e.id === id);
    if (!edit) return;
    setOpenJoinId(null);
    setSelection({ kind: "pending", id, trackId: edit.track_id });
  });

  return {
    selection,
    carets,
    onSelect: mayRange ? onSelect : undefined,
    onCaret,
    onClearSelection,
    onSeamSelect: mayRange ? onSeamSelect : undefined,
    onSuggestionSelect: mayRange ? onSuggestionSelect : undefined,
  };
}
