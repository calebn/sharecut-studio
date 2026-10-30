import { type RefObject, useMemo, useRef, useState } from "react";
import { setTrackMetaCommand } from "../../../api";
import { runMoveSpeakerLaneSpan } from "../../../commands/speakerMoveLaneSpan";
import { redisplayDrafts } from "../../../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../../../document/cursor";
import { revertOptimisticIfUnchanged } from "../../../document/optimisticRevert";
import { useDawStore } from "../../../state/dawStore";
import type { PickerPerson } from "../../../system/PersonPicker";
import { errorMessage } from "../../../utils/apiError";
import { siblingSplitLanes } from "../../../utils/speakerSplit";
import { useStableCallback } from "../../../utils/useStableCallback";
import type { ScriptModel } from "./scriptModel";

const COLORS = 8;

/** Rename one track's speaker as one undo step, showing it at once and putting it back if the host refuses. */
async function renameSpeaker(trackId: string, name: string) {
  const state = useDawStore.getState();
  const previous = state.projectEditBasis();
  const path = state.projectPath;
  if (!previous)
    throw new Error("The project is not open, so the name did not change.");
  const seqAtStart = currentDocumentSeq();
  const sending = setTrackMetaCommand(path, trackId, { speaker: name });
  redisplayDrafts();
  const optimistic = useDawStore.getState().project;
  try {
    const result = await sending;
    if (result.queued && useDawStore.getState().projectPath === path) {
      useDawStore
        .getState()
        .announceStatus("Track metadata change queued. Still sending.");
    }
  } catch (error) {
    if (optimistic) {
      revertOptimisticIfUnchanged(previous, seqAtStart, path, optimistic);
    }
    throw error;
  }
}

export type ScriptSpeakerOpen = {
  turnId: string;
  currentId: string;
  people: readonly PickerPerson[];
  anchor: RefObject<HTMLElement | null>;
};

export type ScriptSpeaker = {
  /** Left out when the viewer may not change speakers. */
  onSpeaker: ((turnId: string, anchor: HTMLElement) => void) | undefined;
  open: ScriptSpeakerOpen | null;
  onPick: (id: string) => Promise<string | undefined>;
  onRename: (id: string, name: string) => Promise<string | undefined>;
  onClose: () => void;
};

/**
 * The speaker popover. It lists the turn's speaker and the sibling lanes of
 * the same split recording, so a pick moves that turn between lanes
 * (`runMoveSpeakerLaneSpan`, which refuses with its own reason when the move
 * is not allowed) and a rename is one track at a time. Both are offered to
 * whoever may add media, as the old panel did. Turning `enabled` off closes
 * the popover for good.
 * Focus goes back to the margin name the popover opened from.
 */
export function useScriptSpeaker(
  model: ScriptModel,
  enabled: boolean,
  say: (message: string) => void,
): ScriptSpeaker {
  const [turn, setTurn] = useState<string | null>(null);
  // A popover opened before the right was lost must not come back with it.
  if (!enabled && turn !== null) setTurn(null);
  const anchor = useRef<HTMLElement | null>(null);
  const tracks = useDawStore((s) => s.project?.tracks);

  const open = useMemo<ScriptSpeakerOpen | null>(() => {
    const found = turn ? model.turns.find((t) => t.id === turn) : undefined;
    if (!found || !tracks || !enabled) return null;
    const lanes = [
      ...tracks.filter((track) => track.id === found.speakerId),
      ...siblingSplitLanes(tracks, found.speakerId),
    ];
    return {
      turnId: found.id,
      currentId: found.speakerId,
      people: lanes.map((track) => ({
        id: track.id,
        name: track.speaker || track.id,
        colorIndex: Math.max(tracks.indexOf(track), 0) % COLORS,
      })),
      anchor,
    };
  }, [turn, model.turns, tracks, enabled]);

  const onSpeaker = useStableCallback((turnId: string, el: HTMLElement) => {
    anchor.current = el;
    setTurn(turnId);
  });
  const onClose = useStableCallback(() => {
    const el = anchor.current;
    setTurn(null);
    queueMicrotask(() => {
      if (el?.isConnected) el.focus();
    });
  });
  const onRename = useStableCallback(async (id: string, name: string) => {
    try {
      await renameSpeaker(id, name);
    } catch (error) {
      return errorMessage(error);
    }
    say(`Speaker renamed to ${name}`);
    return undefined;
  });
  const onPick = useStableCallback(async (id: string) => {
    const found = model.turns.find((t) => t.id === turn);
    // Words an applied cut took out, and words with no project index, are not moved.
    const refs = (found?.words ?? []).flatMap((word) => {
      const ref = model.refs[word.index];
      return ref && ref.wordIndex !== null && !model.isCut(word.index)
        ? [{ ...ref, wordIndex: ref.wordIndex }]
        : [];
    });
    const first = refs[0];
    if (!first) return "Nothing to move.";
    useDawStore.getState().setSelection({
      kind: "transcriptRange",
      trackId: first.trackId,
      sourceId: first.sourceId,
      startWordIndex: Math.min(...refs.map((ref) => ref.wordIndex)),
      endWordIndex: Math.max(...refs.map((ref) => ref.wordIndex)),
    });
    const result = await runMoveSpeakerLaneSpan(id);
    return result.status === "disabled" ? result.reason : undefined;
  });

  return {
    onSpeaker: enabled ? onSpeaker : undefined,
    open,
    onPick,
    onRename,
    onClose,
  };
}
