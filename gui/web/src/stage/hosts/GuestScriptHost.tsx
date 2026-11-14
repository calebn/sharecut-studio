import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import type { ShownTranscript } from "../../document/shownTranscript";
import {
  markScriptRange,
  TRANSCRIPT_REFRESHING,
} from "../../edit/rangeSelection";
import { useShortViewport } from "../../hooks/useShortViewport";
import { useViewportClass } from "../../hooks/useViewportClass";
import { rangeEditMode } from "../../shareMode";
import { GuestScript } from "../../stages/guest/GuestScript";
import { lastStartedWordAt } from "../../stages/guest/guestLogic";
import {
  type GuestReading,
  useGuestReading,
} from "../../stages/guest/useGuestReading";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import type { WordsSelection } from "../../system/scriptPieces";
import { isHostRole } from "../../utils/can";
import { scriptGuestOf } from "../edit/script/scriptGuest";
import { useScriptSelection } from "../edit/script/useScriptSelection";
import { playerPlacementOf } from "../frame/playerPlacement";
import { GuestSelectionBar } from "./GuestSelectionBar";
import {
  guestScriptModelOf,
  guestScriptOf,
  playingWordsAt,
  touchesHeld,
} from "./guestScript";
import {
  followSelection,
  type RememberedSelection,
  selectionEndOf,
} from "./guestSelection";

const NOOP = () => {};
const HELD_NOTICE_GAP_MS = 250;

export type GuestScriptHostProps = {
  reading?: GuestReading;
  shown: ShownTranscript;
};

function GuestScriptHostAdapter({
  reading: providedReading,
  shown,
}: GuestScriptHostProps) {
  const reading = useGuestReading(providedReading);
  const { guestMode, projectPath, capabilities } = useDawStore(
    useShallow((s) => ({
      guestMode: s.guestMode,
      projectPath: s.projectPath,
      capabilities: s.shareCapabilities,
    })),
  );
  const shell = useViewportClass();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const short = useShortViewport();
  const role = stageRoleOf(guestMode);
  const script = useMemo(() => guestScriptOf(shown.rows), [shown.rows]);
  const { turns, wordStarts, words, empty } = script;
  const rangeMode = rangeEditMode(projectPath, capabilities);
  const mayRange = rangeMode !== "none";
  const model = useMemo(() => guestScriptModelOf(script), [script]);
  const range = useScriptSelection(model, mayRange, NOOP);
  const selectRange = range.onSelect;
  const remembered = useRef<RememberedSelection | null>(null);
  const lastNotice = useRef(Number.NEGATIVE_INFINITY);
  const heldNotice = useCallback(() => {
    // One tap reaches both the seek and the select path: say it once.
    const now = performance.now();
    if (now - lastNotice.current < HELD_NOTICE_GAP_MS) return;
    lastNotice.current = now;
    useDawStore
      .getState()
      .announceStatus(TRANSCRIPT_REFRESHING, { tone: "error" });
  }, []);
  const remember = useCallback(
    (selection: WordsSelection) => {
      const stored = useDawStore.getState().selection;
      const anchor = selectionEndOf(script, selection.anchor);
      const head = selectionEndOf(script, selection.head);
      remembered.current =
        stored && anchor && head ? { stored, anchor, head } : null;
    },
    [script],
  );
  // Remembered only when the store took the selection: a write that changed
  // nothing must not pair an older selection with this gesture's ends.
  const write = useCallback(
    (selection: WordsSelection) => {
      const prior = useDawStore.getState().selection;
      selectRange?.(selection);
      const taken = useDawStore.getState().selection;
      if (taken === prior) return;
      // The object the store holds is the one marked and the one remembered.
      markScriptRange(taken);
      remember(selection);
    },
    [selectRange, remember],
  );
  const onSelect = useCallback(
    (selection: WordsSelection) => {
      if (touchesHeld(script, selection)) {
        heldNotice();
        return;
      }
      write(selection);
    },
    [script, write, heldNotice],
  );
  // An edit renumbers words: a selection of ours follows its words or goes.
  // It writes with no gesture, so it never announces and waits for live words.
  useEffect(() => {
    const mine = remembered.current;
    if (!mine) return;
    const state = useDawStore.getState();
    if (state.selection !== mine.stored) {
      remembered.current = null;
      return;
    }
    const next = followSelection(mine, script);
    if (next.kind === "clear") {
      remembered.current = null;
      state.setSelection(null);
    } else if (next.kind === "move") {
      write({ kind: "words", anchor: next.anchor, head: next.head });
    }
  }, [script, write]);
  // The Script gives way to a cover mid-refresh: the words come back under new
  // numbers with nothing watching the selection, so it goes with the Script.
  const refreshingNow = useRef(shown.refreshing);
  useEffect(() => {
    refreshingNow.current = shown.refreshing;
  }, [shown.refreshing]);
  useEffect(
    () => () => {
      const mine = remembered.current;
      const state = useDawStore.getState();
      if (mine && refreshingNow.current && state.selection === mine.stored)
        state.setSelection(null);
    },
    [],
  );
  const positionKey = useDawStore(
    useCallback(
      (s: { playheadSec: number }) =>
        `${playingWordsAt(words, s.playheadSec).join(",")}|${lastStartedWordAt(wordStarts, s.playheadSec) ?? ""}`,
      [words, wordStarts],
    ),
  );
  const { playing, playheadWord } = useMemo(() => {
    const [now = "", last = ""] = positionKey.split("|");
    return {
      playing: now === "" ? [] : now.split(",").map(Number),
      playheadWord: last === "" ? undefined : Number(last),
    };
  }, [positionKey]);
  // The phone Listen layout keeps the Script at any height, the keyboard's included.
  const listening =
    playerPlacementOf({ stage: "review", shell, role, short }) === "dock";
  const hidden = isHostRole(role) ? false : (short && !listening) || !mayRange;
  const wasHidden = useRef(hidden);
  useEffect(() => {
    const turnedOff = hidden && !wasHidden.current;
    wasHidden.current = hidden;
    if (!turnedOff) return;
    const { selection, setSelection } = useDawStore.getState();
    if (selection?.kind === "transcriptRange" || selection?.kind === "range")
      setSelection(null);
  }, [hidden]);
  if (isHostRole(role) || (short && !listening)) return null;
  return (
    <div ref={setRoot} className="stage-host-guest-script">
      <GuestScript
        guest={scriptGuestOf(projectPath, guestMode, rangeMode)}
        layout={shell === "phone" ? "phone" : "desktop"}
        turns={turns}
        wordStarts={wordStarts}
        playing={playing}
        playheadWord={playheadWord}
        reading={reading}
        empty={empty}
        refreshing={shown.refreshing}
        onSeek={(seconds) => void seekTransport(seconds)}
        onHeldWord={heldNotice}
        selection={mayRange ? range.selection : undefined}
        onSelect={range.onSelect ? onSelect : undefined}
        onClearSelection={mayRange ? range.onClearSelection : undefined}
      />
      {mayRange ? (
        <GuestSelectionBar root={root} phone={shell === "phone"} />
      ) : null}
    </div>
  );
}

export const GuestScriptHost = memo(GuestScriptHostAdapter);
