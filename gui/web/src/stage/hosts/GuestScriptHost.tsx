import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { seekTransport } from "../../commands/seek";
import type { ShownTranscript } from "../../document/shownTranscript";
import {
  isScriptRange,
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
  GuestSelectionMemory,
  selectionEndOf,
} from "./guestSelection";

const NOOP = () => {};
const HELD_NOTICE_GAP_MS = 250;

export type GuestScriptHostProps = {
  reading?: GuestReading;
  selectionMemory?: GuestSelectionMemory;
  shown: ShownTranscript;
};

function GuestScriptHostAdapter({
  reading: providedReading,
  selectionMemory,
  shown,
}: GuestScriptHostProps) {
  const reading = useGuestReading(providedReading);
  const { guestMode, projectPath, capabilities, selectedScriptRange } =
    useDawStore(
      useShallow((s) => ({
        guestMode: s.guestMode,
        projectPath: s.projectPath,
        capabilities: s.shareCapabilities,
        selectedScriptRange: isScriptRange(s.selection),
      })),
    );
  const shell = useViewportClass();
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const short = useShortViewport();
  const role = stageRoleOf(guestMode);
  const script = useMemo(() => guestScriptOf(shown.rows), [shown.rows]);
  const [localMemory] = useState(() => new GuestSelectionMemory());
  const remembered = selectionMemory ?? localMemory;
  const [selectionRows, setSelectionRows] = useState(() => {
    const mine = remembered.get();
    return mine && mine.stored === useDawStore.getState().selection
      ? mine.verifiedRows
      : shown.rows;
  });
  const { turns, wordStarts, words, empty } = script;
  const rangeMode = rangeEditMode(projectPath, capabilities);
  const mayRange = rangeMode !== "none";
  const listening =
    playerPlacementOf({ stage: "review", shell, role, short }) === "dock";
  const hidden = !isHostRole(role) && ((short && !listening) || !mayRange);
  const wasHidden = useRef(hidden);
  const model = useMemo(() => guestScriptModelOf(script), [script]);
  const range = useScriptSelection(model, mayRange, NOOP);
  const selectRange = range.onSelect;
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
  const write = useCallback(
    (selection: WordsSelection, verifiedRows: ShownTranscript["rows"]) => {
      const prior = useDawStore.getState().selection;
      selectRange?.(selection);
      const taken = useDawStore.getState().selection;
      if (taken === prior) return false;
      markScriptRange(taken);
      const anchor = selectionEndOf(script, selection.anchor);
      const head = selectionEndOf(script, selection.head);
      remembered.set(
        taken && anchor && head
          ? { stored: taken, anchor, head, verifiedRows }
          : null,
      );
      return true;
    },
    [remembered, script, selectRange],
  );
  const onSelect = useCallback(
    (selection: WordsSelection) => {
      if (touchesHeld(script, selection)) {
        heldNotice();
        return;
      }
      if (write(selection, shown.rows)) setSelectionRows(shown.rows);
    },
    [script, shown.rows, write, heldNotice],
  );
  useLayoutEffect(() => {
    const turnedOff = hidden && !wasHidden.current;
    wasHidden.current = hidden;
    if (!hidden) return;
    const mine = remembered.get();
    remembered.set(null);
    const { selection, setSelection } = useDawStore.getState();
    if (
      (mine && selection === mine.stored) ||
      (turnedOff &&
        (selection?.kind === "transcriptRange" || selection?.kind === "range"))
    )
      setSelection(null);
  }, [hidden, remembered]);
  // Reconcile before React paints a range keyed to the old rows.
  useLayoutEffect(() => {
    const mine = remembered.get();
    if (hidden || !mine) return;
    const state = useDawStore.getState();
    if (state.selection !== mine.stored) {
      remembered.set(null);
      return;
    }
    const next = followSelection(mine, script);
    if (next.kind === "clear") {
      remembered.set(null);
      state.setSelection(null);
      return;
    }
    if (next.kind === "wait") return;
    if (
      next.kind === "move" &&
      !write(
        { kind: "words", anchor: next.anchor, head: next.head },
        mine.verifiedRows,
      )
    )
      return;
    const verified = remembered.get();
    if (verified && !shown.refreshing) {
      if (verified.verifiedRows !== shown.rows)
        remembered.set({ ...verified, verifiedRows: shown.rows });
      if (isScriptRange(verified.stored)) setSelectionRows(shown.rows);
    }
  }, [hidden, remembered, script, shown.rows, shown.refreshing, write]);
  const refreshingNow = useRef(shown.refreshing);
  useLayoutEffect(() => {
    refreshingNow.current = shown.refreshing;
  }, [shown.refreshing]);
  useLayoutEffect(
    () => () => {
      const mine = remembered.get();
      const state = useDawStore.getState();
      if (mine && refreshingNow.current && state.selection === mine.stored) {
        remembered.set(null);
        state.setSelection(null);
      }
    },
    [remembered],
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
        selectionRefreshing={
          mayRange &&
          selectedScriptRange &&
          (selectionRows !== shown.rows ||
            (shown.refreshing && range.selection === null))
        }
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
