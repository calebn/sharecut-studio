import { useMemo, useState } from "react";
import { makeRangeTarget } from "../../../edit/rangeSelection";
import { useDawStore } from "../../../state/dawStore";
import type {
  ScriptCaret,
  ScriptSelection,
  WordsSelection,
} from "../../../system/scriptPieces";
import {
  appliedEditTicks,
  seamTickAtJoin,
} from "../../../timeline/appliedEditTicks";
import type {
  AppliedEditRecord,
  ClipRow,
  EditBoundaryView,
  Selection,
} from "../../../types/project";
import { useStableCallback } from "../../../utils/useStableCallback";
import {
  type ScriptModel,
  scriptReviewSelectionOf,
  wordsTargetOf,
} from "./scriptModel";

const NO_CARETS: readonly ScriptCaret[] = [];
const NO_BOUNDARIES: readonly EditBoundaryView[] = [];

type AppliedSeamSelection = Extract<Selection, { kind: "applied" }>;

function appliedSelectionAtBoundary(
  boundary: EditBoundaryView,
  clipsByTrack: Record<string, ClipRow[]>,
  records: readonly AppliedEditRecord[],
): AppliedSeamSelection | null {
  const trackId = boundary.track_id;
  const clips = clipsByTrack[trackId] ?? [];
  const tick = seamTickAtJoin(appliedEditTicks(records, trackId, clips), {
    sec: boundary.timeline_join_sec,
  });
  return tick ? { kind: "applied", id: tick.recordId, trackId } : null;
}

function appliedSelectionForOpenBoundary(
  selection: Selection,
  boundaries: readonly EditBoundaryView[],
  openJoinId: string | null,
  clipsByTrack: Record<string, ClipRow[]>,
  records: readonly AppliedEditRecord[],
): AppliedSeamSelection | null {
  if (selection?.kind !== "applied" || openJoinId === null) return null;
  for (const boundary of boundaries) {
    if (boundary.right_clip_id !== openJoinId) continue;
    const applied = appliedSelectionAtBoundary(boundary, clipsByTrack, records);
    if (applied?.id === selection.id && applied.trackId === selection.trackId) {
      return applied;
    }
  }
  return null;
}

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
  const clipsByTrack = useDawStore((s) => s.project?.clips.tracks);
  const appliedRecords = useDawStore((s) => s.project?.applied_edits.records);
  const openJoinId = useDawStore((s) => s.openJoinId);
  const selection = useMemo(() => {
    const currentBoundaries = boundaries ?? NO_BOUNDARIES;
    const projectedApplied = appliedSelectionForOpenBoundary(
      stored,
      currentBoundaries,
      openJoinId,
      clipsByTrack ?? {},
      appliedRecords ?? [],
    );
    return scriptReviewSelectionOf(
      model,
      projectedApplied ? null : stored,
      currentBoundaries,
      openJoinId,
    );
  }, [model, stored, boundaries, openJoinId, clipsByTrack, appliedRecords]);
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
    const boundary = state.project?.edit_boundaries?.find((b) => b.id === id);
    const clipId = boundary?.right_clip_id;
    if (!boundary || !clipId || state.joinMutationInFlight) return;
    const applied = appliedSelectionAtBoundary(
      boundary,
      state.project?.clips.tracks ?? {},
      state.project?.applied_edits.records ?? [],
    );
    state.setSelection(applied);
    state.setOpenJoinId(state.openJoinId === clipId ? null : clipId);
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
