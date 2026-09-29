import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { capabilityTooltip } from "../capabilities/copy";
import { DOUBLE_TAP_MS, withinGhostClick } from "../hooks/touchGestureTiming";
import { useLongPress } from "../hooks/useLongPress";
import { useUserScrollIntent } from "../hooks/useUserScrollIntent";
import { useVirtualTurns } from "../hooks/useVirtualTurns";
import { TranscriptWordInspector } from "../inspector/views/TranscriptWordInspector";
import {
  presenceAnchor,
  presenceAnchorProps,
  resolvePresenceAnchor,
} from "../presence/anchors";
import { useProsodyOverlay } from "../prosody/useProsodyOverlay";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { isDetachedWordFailureMoot } from "../transcript/detachedWordFailure";
import { EditBoundaryMark } from "../transcript/EditBoundaryMark";
import {
  indexBoundaryPlacements,
  type PlacementTurn,
  placeEditBoundaries,
} from "../transcript/editBoundaryPlacement";
import { HALLUCINATION_WARNING } from "../transcript/hallucinationWarning";
import { InlineWordEditor } from "../transcript/InlineWordEditor";
import { ignoredRuns, selectionAllIgnored } from "../transcript/ignoredWords";
import {
  isLowConfidenceWord,
  reviewCursorIndex,
  selectLowConfidenceStops,
} from "../transcript/lowConfidence";
import {
  PROMINENT_TIP,
  prominentWordKey,
  prominentWordKeys,
} from "../transcript/prominence";
import {
  type TranscriptTurnSegment,
  TranscriptTurnView,
} from "../transcript/TranscriptTurnView";
import {
  TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
  TRANSCRIPT_CUT_AWAY_WORD_TIP,
  TRANSCRIPT_IGNORED_WORD_TIP,
  TRANSCRIPT_INLINE_SAVING_STATUS,
  TRANSCRIPT_MODE_HINT,
  TRANSCRIPT_NAVIGATE_TOUCH_HINT,
  type TranscriptIntent,
} from "../transcript/transcriptModeCopy";
import { wordInteractionTip } from "../transcript/wordInteractionTip";
import type {
  CombinedUtterance,
  EditBoundaryView,
  Selection,
} from "../types/project";
import { Button, CommandButton, InlineError, ToggleButton } from "../ui";
import {
  findTranscriptWordIn,
  findTurnIndexForUtterance,
  groupConsecutiveSpeakerTurns,
  isMappedUtterance,
  scrollChildIntoParent,
  selectUnmappedUtterances,
  transcriptAnchorTurnIndex,
  transcriptWordAnchor,
  turnKey,
  turnSeekSec,
  visibleTranscriptUtterances,
  wordSeekSec,
  wordsForUtterance,
} from "../utils/transcript";
import {
  activeWordId,
  buildTranscriptActiveIndex,
  parseTranscriptActiveKey,
  transcriptActiveKey,
} from "./transcriptActive";

const EMPTY_UTTERANCES: CombinedUtterance[] = [];
const EMPTY_BOUNDARIES: EditBoundaryView[] = [];

type WordRef = { trackId: string; wordIndex: number };

function wordInRange(
  selection: {
    kind: string;
    trackId?: string;
    wordIndex?: number;
    startWordIndex?: number;
    endWordIndex?: number;
  } | null,
  trackId: string,
  wordIndex: number | undefined,
): boolean {
  if (wordIndex == null || !selection) {
    return false;
  }
  if (selection.kind === "transcriptWord") {
    return selection.trackId === trackId && selection.wordIndex === wordIndex;
  }
  if (selection.kind === "transcriptRange") {
    if (selection.trackId !== trackId) {
      return false;
    }
    const lo = Math.min(
      selection.startWordIndex ?? 0,
      selection.endWordIndex ?? 0,
    );
    const hi = Math.max(
      selection.startWordIndex ?? 0,
      selection.endWordIndex ?? 0,
    );
    return wordIndex >= lo && wordIndex <= hi;
  }
  return false;
}

export function TranscriptPanel() {
  const {
    project,
    projectPath,
    setPlayheadSec,
    selection,
    setSelection,
    transcriptFollowPlayhead,
    setTranscriptFollowPlayhead,
    toggleTranscriptFollowPlayhead,
    transcriptAnnotate,
    toggleTranscriptAnnotate,
    showCutAwayUtterances,
    setShowCutAwayUtterances,
    layoutMode,
    followingClientId,
    stopFollow,
    transcriptScrollRequest,
    setTranscriptScrollRequest,
    setTranscriptViewAnchor,
    pointerKind,
    transcriptInlineCommitPending,
    setTranscriptInlineCommitPending,
    transcriptInlineEditFailure,
    setTranscriptInlineEditFailure,
    transcriptReviewCursor,
    showProsody,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    setPlayheadSec: s.setPlayheadSec,
    selection: s.selection,
    setSelection: s.setSelection,
    transcriptFollowPlayhead: s.transcriptFollowPlayhead,
    setTranscriptFollowPlayhead: s.setTranscriptFollowPlayhead,
    toggleTranscriptFollowPlayhead: s.toggleTranscriptFollowPlayhead,
    transcriptAnnotate: s.transcriptAnnotate,
    toggleTranscriptAnnotate: s.toggleTranscriptAnnotate,
    showCutAwayUtterances: s.showCutAwayUtterances,
    setShowCutAwayUtterances: s.setShowCutAwayUtterances,
    layoutMode: s.layoutMode,
    followingClientId: s.followingClientId,
    stopFollow: s.stopFollow,
    transcriptScrollRequest: s.transcriptScrollRequest,
    setTranscriptScrollRequest: s.setTranscriptScrollRequest,
    setTranscriptViewAnchor: s.setTranscriptViewAnchor,
    pointerKind: s.pointerKind,
    transcriptInlineCommitPending: s.transcriptInlineCommitPending,
    setTranscriptInlineCommitPending: s.setTranscriptInlineCommitPending,
    transcriptInlineEditFailure: s.transcriptInlineEditFailure,
    setTranscriptInlineEditFailure: s.setTranscriptInlineEditFailure,
    transcriptReviewCursor: s.transcriptReviewCursor,
    showProsody: s.layers.showProsody,
  }));
  const prosody = useProsodyOverlay(showProsody);
  const prominentKeys = useMemo(() => prominentWordKeys(prosody), [prosody]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const bindActiveRef = (active: boolean) =>
    active
      ? (el: HTMLElement | null) => {
          activeRef.current = el;
        }
      : undefined;
  const { handlers: scrollIntentHandlers, isUserScroll } =
    useUserScrollIntent();
  /** Playhead at which a scroll request won over follow (until it moves). */
  const followHoldRef = useRef<{ sec: number; follow: boolean } | null>(null);
  const [focusedTurnIndex, setFocusedTurnIndex] = useState(-1);
  /** Last scroll-request target; stays mounted until the list range catches up. */
  const [requestTurnIndex, setRequestTurnIndex] = useState(-1);
  const viewAnchorRafRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const rangeAnchorRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  /** True when mouseenter extended the range during a drag (survives mouseup→click). */
  const dragExtendedRef = useRef(false);
  const [intent, setIntentState] = useState<TranscriptIntent>("navigate");
  const cancelQueuedSeek = () => {
    if (clickTimerRef.current != null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  };
  /** Switching intent drops a single-tap seek queued under the old one. */
  const setIntent = (
    next: TranscriptIntent | ((prev: TranscriptIntent) => TranscriptIntent),
  ) => {
    cancelQueuedSeek();
    setInlineEdit(null);
    setIntentState(next);
  };
  const lastTouchTapRef = useRef<(WordRef & { at: number }) | null>(null);
  const correctedTouchAtRef = useRef(-Infinity);
  const pendingCorrectionRef = useRef<WordRef | null>(null);
  /** Word being edited in place (navigate intent, host, hydrated). */
  const [inlineEdit, setInlineEdit] = useState<WordRef | null>(null);
  /** Word chip to refocus after Enter / Esc closes the inline editor. */
  const inlineFocusRestoreRef = useRef<WordRef | null>(null);
  /** Word under the finger at pointerdown (long-press fires on release). */
  const pressedWordRef = useRef<WordRef | null>(null);
  const lastReviewCursorRef = useRef(transcriptReviewCursor);
  const longPressReleasedRef = useRef(false);
  /** State to restore when a gesture-opened correction closes. */
  const gestureRestoreRef = useRef<{
    intent: TranscriptIntent;
    selection: Selection;
  } | null>(null);
  const hostEditable = !isShareProjectKey(projectPath);
  const wordsHydrated = project?.meta.hydration?.transcript_words !== false;
  /** Touch gestures only open correction where the Correct toggle could. */
  const canCorrect = hostEditable && wordsHydrated;
  const allUtterances = project?.transcript?.utterances ?? EMPTY_UTTERANCES;

  /**
   * Open word correction from a touch gesture. Scoped to the gesture: the
   * previous intent (and Select range) comes back once the sheet closes.
   */
  const openWordCorrection = ({ trackId, wordIndex }: WordRef): boolean => {
    if (
      !canCorrect ||
      !findTranscriptWordIn(allUtterances, trackId, wordIndex)
    ) {
      return false;
    }
    if (intent !== "correct" && gestureRestoreRef.current == null) {
      gestureRestoreRef.current = {
        intent,
        selection: selection?.kind === "transcriptRange" ? selection : null,
      };
    }
    setIntent("correct");
    setSelection({ kind: "transcriptWord", trackId, wordIndex });
    return true;
  };

  const transcriptLongPress = useLongPress(() => {
    const pressed = pressedWordRef.current;
    pressedWordRef.current = null;
    if (pressed) openWordCorrection(pressed);
  });

  useEffect(() => {
    return () => {
      if (clickTimerRef.current != null) {
        window.clearTimeout(clickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const restore = gestureRestoreRef.current;
    if (!restore || selection?.kind === "transcriptWord") {
      return;
    }
    gestureRestoreRef.current = null;
    setIntentState(restore.intent);
    if (restore.selection && selection == null) {
      setSelection(restore.selection);
    }
  }, [selection, setSelection]);

  useEffect(() => {
    if (
      intent !== "correct" &&
      (selection?.kind === "transcriptWord" ||
        selection?.kind === "transcriptRange")
    ) {
      if (intent === "navigate") {
        setSelection(null);
      }
    }
    if (intent === "correct" && selection?.kind === "transcriptRange") {
      setSelection(null);
    }
    if (intent === "select" && selection?.kind === "transcriptWord") {
      setSelection(null);
    }
  }, [intent, selection, setSelection]);

  // A walkthrough step in Correct mode opens its word in the word editor (#634).
  // Only a new cursor acts: entering Correct later does not reselect a stale stop.
  useEffect(() => {
    if (transcriptReviewCursor === lastReviewCursorRef.current) return;
    lastReviewCursorRef.current = transcriptReviewCursor;
    if (!transcriptReviewCursor || intent !== "correct" || !canCorrect) return;
    setSelection({
      kind: "transcriptWord",
      trackId: transcriptReviewCursor.trackId,
      wordIndex: transcriptReviewCursor.wordIndex,
    });
  }, [transcriptReviewCursor, intent, canCorrect, setSelection]);

  useEffect(() => {
    const onUp = () => {
      draggingRef.current = false;
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  const seekTurnSoon = (sec: number) => {
    cancelQueuedSeek();
    // Delay so a double-click can cancel and seek the word instead.
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      setPlayheadSec(sec);
    }, 220);
  };

  const seekWordNow = (sec: number) => {
    cancelQueuedSeek();
    setPlayheadSec(sec);
  };

  const openInlineEdit = (ref: WordRef) => {
    cancelQueuedSeek();
    // One correction at a time: a pending commit keeps its editor open.
    // No client timeout, like every useProjectMutation flow: a stalled request
    // holds the lock until it settles, and the saving status line says why.
    // The lock lives in the DAW store so a tab switch that remounts this
    // panel keeps it.
    if (useDawStore.getState().transcriptInlineCommitPending) return;
    setTranscriptInlineEditFailure(null);
    setInlineEdit(ref);
  };
  const closeInlineEdit = (ref: WordRef, restoreFocus: boolean) => {
    setInlineEdit((cur) => {
      if (
        !cur ||
        cur.trackId !== ref.trackId ||
        cur.wordIndex !== ref.wordIndex
      ) {
        // A replaced editor's late close: leave state and focus alone.
        return cur;
      }
      // Idempotent, so StrictMode's double-invoked updater is harmless.
      inlineFocusRestoreRef.current = restoreFocus ? ref : null;
      return null;
    });
  };

  // Close when editing becomes impossible or the word vanishes (remote edit, rehydrate).
  // findTranscriptWordIn scans the episode's words, but only while an editor is
  // open and when allUtterances changes identity (merge, mutation), never per key.
  useEffect(() => {
    if (
      inlineEdit &&
      (!canCorrect ||
        !findTranscriptWordIn(
          allUtterances,
          inlineEdit.trackId,
          inlineEdit.wordIndex,
        ))
    ) {
      setInlineEdit(null);
    }
  }, [inlineEdit, canCorrect, allUtterances]);

  // A late failure is moot once its word's text changes by any path (inspector
  // Apply, a later inline fix, a remote edit), a failed Suppress / Ignore's flag
  // changes (a retry succeeded), the word is gone, or another project is open
  // (isDetachedWordFailureMoot). Accepted gap: a later fix that leaves the word with the
  // text it had when the failed fix was submitted (an undo back to it, or a
  // casing / whitespace change the mapper normalizes away) keeps the failure
  // up; Dismiss or opening another inline edit clears it.
  useEffect(() => {
    if (
      transcriptInlineEditFailure &&
      isDetachedWordFailureMoot(
        transcriptInlineEditFailure,
        projectPath,
        findTranscriptWordIn(
          allUtterances,
          transcriptInlineEditFailure.trackId,
          transcriptInlineEditFailure.wordIndex,
        ),
      )
    ) {
      setTranscriptInlineEditFailure(null);
    }
  }, [
    transcriptInlineEditFailure,
    allUtterances,
    projectPath,
    setTranscriptInlineEditFailure,
  ]);

  // Keyboard close (Enter / Esc) returns focus to the word chip. Re-query it by
  // data-track-id / data-word-index rather than saving the element (as
  // useDialogModal's restoreFocusRef does): the list virtualizes, so a saved
  // node can be unmounted or remounted by the time the editor closes.
  useEffect(() => {
    const target = inlineFocusRestoreRef.current;
    if (inlineEdit != null || !target) return;
    inlineFocusRestoreRef.current = null;
    const chips =
      listRef.current?.querySelectorAll<HTMLElement>(
        "[data-transcript-word]",
      ) ?? [];
    for (const chip of chips) {
      if (
        chip.dataset.trackId === target.trackId &&
        Number(chip.dataset.wordIndex) === target.wordIndex
      ) {
        chip.focus();
        break;
      }
    }
  }, [inlineEdit]);

  const setRange = (trackId: string, a: number, b: number) => {
    setSelection({
      kind: "transcriptRange",
      trackId,
      startWordIndex: Math.min(a, b),
      endWordIndex: Math.max(a, b),
    });
  };

  const cutAwayCount = useMemo(
    () => selectUnmappedUtterances(allUtterances).length,
    [allUtterances],
  );
  // suppressed-only rows (#758) are view-only and excluded from the toolbar count.
  const mappedCount = useMemo(
    () =>
      allUtterances.filter((u) => isMappedUtterance(u) && !u.suppressed_only)
        .length,
    [allUtterances],
  );
  const utterances = useMemo(
    // Cut-away reveal is nested under Annotate (clean view stays clean).
    () =>
      visibleTranscriptUtterances(
        allUtterances,
        transcriptAnnotate,
        showCutAwayUtterances,
      ),
    [allUtterances, showCutAwayUtterances, transcriptAnnotate],
  );
  const editBoundaries = project?.edit_boundaries ?? EMPTY_BOUNDARIES;
  const turns = useMemo(
    () => groupConsecutiveSpeakerTurns(utterances),
    [utterances],
  );
  // Walkthrough stops (#634): the words that get the low-confidence underline.
  // Memoized in the helper, shared with the Next/Previous commands.
  const reviewStops = selectLowConfidenceStops(
    allUtterances,
    transcriptAnnotate,
    showCutAwayUtterances,
  );
  const reviewPosition = reviewCursorIndex(reviewStops, transcriptReviewCursor);
  // The highlight, selected as one string key rather than the playhead: a
  // tick re-renders the panel only when an utterance or word changes.
  const activeIndexData = useMemo(
    () => buildTranscriptActiveIndex(utterances),
    [utterances],
  );
  const activeKey = useDawStore(
    useCallback(
      (s: { playheadSec: number }) =>
        transcriptActiveKey(activeIndexData, s.playheadSec),
      [activeIndexData],
    ),
  );
  const active = useMemo(
    () => parseTranscriptActiveKey(activeKey),
    [activeKey],
  );
  const activeIndex = active.first;
  // A scroll request holds follow until the playhead moves; wake the follow
  // effect when it does (the highlight alone may not change).
  const [holdRelease, setHoldRelease] = useState(0);
  useEffect(
    () =>
      useDawStore.subscribe((s, prev) => {
        const hold = followHoldRef.current;
        if (
          hold &&
          s.playheadSec !== prev.playheadSec &&
          s.playheadSec !== hold.sec
        ) {
          setHoldRelease((n) => n + 1);
        }
      }),
    [],
  );
  const activeTurnIndex = useMemo(
    () => findTurnIndexForUtterance(turns, activeIndex),
    [activeIndex, turns],
  );
  const selectedAnchor =
    selection?.kind === "transcriptWord"
      ? presenceAnchor(
          "transcript",
          "word",
          selection.trackId,
          selection.wordIndex,
        )
      : selection?.kind === "transcriptRange"
        ? presenceAnchor(
            "transcript",
            "word",
            selection.trackId,
            selection.startWordIndex,
          )
        : null;
  // Pinned turns stay mounted when virtualized: follow and scroll requests
  // always find their element, and focus/selection and an open inline editor
  // survive scrolling away.
  const pinnedTurns = useMemo(
    () =>
      [
        activeTurnIndex,
        focusedTurnIndex,
        selectedAnchor ? transcriptAnchorTurnIndex(turns, selectedAnchor) : -1,
        // The inline editor's turn stays mounted so a commit in flight never
        // remounts a second editor for the same word.
        inlineEdit
          ? transcriptAnchorTurnIndex(
              turns,
              presenceAnchor(
                "transcript",
                "word",
                inlineEdit.trackId,
                inlineEdit.wordIndex,
              ),
            )
          : -1,
        transcriptScrollRequest
          ? transcriptAnchorTurnIndex(turns, transcriptScrollRequest)
          : requestTurnIndex,
      ].filter((i) => i >= 0),
    [
      activeTurnIndex,
      focusedTurnIndex,
      inlineEdit,
      requestTurnIndex,
      selectedAnchor,
      transcriptScrollRequest,
      turns,
    ],
  );
  const {
    virtualized,
    items: virtualItems,
    totalSize,
    slotProps,
  } = useVirtualTurns(listRef, turns, pinnedTurns);
  const renderList = virtualized
    ? virtualItems.map((virtualItem) => ({
        turn: turns[virtualItem.index]!,
        turnIndex: virtualItem.index,
        virtualItem,
      }))
    : turns.map((turn, turnIndex) => ({ turn, turnIndex, virtualItem: null }));
  /** Re-center when rows above the active turn get measured and shift it. */
  const activeTurnStart =
    virtualItems.find((item) => item.index === activeTurnIndex)?.start ?? null;
  const boundaryMarksByTurn = useMemo(() => {
    if (!transcriptAnnotate || editBoundaries.length === 0) {
      return null;
    }
    const placementTurns: PlacementTurn[] = turns.map((turn) => ({
      trackId: turn.trackId,
      words: turn.utterances.flatMap((u) =>
        wordsForUtterance(u).map((w) => ({
          timelineStart: w.timeline_start ?? w.start,
          timelineEnd: w.timeline_end ?? w.end,
        })),
      ),
    }));
    return indexBoundaryPlacements(
      placeEditBoundaries(placementTurns, editBoundaries),
    );
  }, [transcriptAnnotate, editBoundaries, turns]);
  const renderBoundaryMarks = (
    turnIndex: number,
    afterWordIndex: number,
    trackId: string,
  ) => {
    const marks = boundaryMarksByTurn?.get(turnIndex)?.get(afterWordIndex);
    if (!marks?.length) {
      return null;
    }
    const clips = project?.clips.tracks[trackId] ?? [];
    return marks.map((b: EditBoundaryView) => (
      <EditBoundaryMark
        key={b.id}
        boundary={b}
        leftClip={clips.find((c) => c.id === b.left_clip_id) ?? null}
        rightClip={
          b.right_clip_id
            ? (clips.find((c) => c.id === b.right_clip_id) ?? null)
            : null
        }
      />
    ));
  };

  useEffect(() => {
    if (!transcriptFollowPlayhead) {
      followHoldRef.current = null;
      return;
    }
    const hold = followHoldRef.current;
    if (hold?.follow && hold.sec === useDawStore.getState().playheadSec) {
      // A scroll request (e.g. leader jump) wins until the playhead moves.
      return;
    }
    followHoldRef.current = null;
    if (activeIndex < 0) {
      return;
    }
    const root = listRef.current;
    const el = activeRef.current;
    if (!root || !el || !root.contains(el)) {
      return;
    }
    scrollChildIntoParent(root, el, 0.5);
  }, [
    activeKey,
    activeIndex,
    activeTurnStart,
    holdRelease,
    transcriptFollowPlayhead,
    utterances,
  ]);

  const publishViewAnchor = useCallback(() => {
    const list = listRef.current;
    if (!list) {
      return;
    }
    const listTop = list.getBoundingClientRect().top;
    const turnEls = list.querySelectorAll<HTMLElement>(".utterance-turn");
    const n = turnEls.length;
    if (n === 0) {
      return;
    }
    let lo = 0;
    let hi = n - 1;
    let first = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turnEls[mid]!.getBoundingClientRect().bottom > listTop) {
        first = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    const idx = turnEls[first]!.getAttribute("data-turn-index");
    if (idx != null) {
      setTranscriptViewAnchor(presenceAnchor("transcript", "turn", idx));
    }
  }, [setTranscriptViewAnchor]);

  const scheduleViewAnchor = useCallback(() => {
    if (viewAnchorRafRef.current != null) {
      return;
    }
    viewAnchorRafRef.current = window.requestAnimationFrame(() => {
      viewAnchorRafRef.current = null;
      publishViewAnchor();
    });
  }, [publishViewAnchor]);

  useEffect(() => {
    scheduleViewAnchor();
  }, [utterances, activeIndex, scheduleViewAnchor]);

  useEffect(() => {
    if (!transcriptScrollRequest) {
      return;
    }
    // One attempt per request: the target turn is pinned (mounted) in this
    // render, so an unresolvable anchor is dropped instead of retried.
    setTranscriptScrollRequest(null);
    const root = listRef.current;
    if (!root) {
      return;
    }
    const targetTurn = transcriptAnchorTurnIndex(
      turns,
      transcriptScrollRequest,
    );
    setRequestTurnIndex(targetTurn);
    const el =
      resolvePresenceAnchor(root, transcriptScrollRequest) ??
      (targetTurn >= 0
        ? resolvePresenceAnchor(
            root,
            presenceAnchor("transcript", "turn", targetTurn),
          )
        : null);
    if (!el) {
      return;
    }
    followHoldRef.current = {
      sec: useDawStore.getState().playheadSec,
      follow: transcriptFollowPlayhead,
    };
    scrollChildIntoParent(root, el, 0.2);
  }, [
    transcriptFollowPlayhead,
    transcriptScrollRequest,
    setTranscriptScrollRequest,
    turns,
  ]);

  if (!allUtterances.length) {
    return <p style={{ color: "var(--text-dim)" }}>No combined transcript.</p>;
  }

  // The saving status replaces the visible mode hint while an inline fix is
  // pending, so no line is inserted and the list never shifts under the
  // pointer. Only the saving status is live (the visually hidden role=status
  // below), so mode toggles and pointer changes are not announced.
  let toolbarHint = TRANSCRIPT_MODE_HINT[intent];
  if (intent === "navigate" && pointerKind === "coarse") {
    toolbarHint = TRANSCRIPT_NAVIGATE_TOUCH_HINT;
  }
  if (transcriptInlineCommitPending) {
    toolbarHint = TRANSCRIPT_INLINE_SAVING_STATUS;
  }

  const dockWordEditor =
    layoutMode === "text" &&
    selection?.kind === "transcriptWord" &&
    intent === "correct";

  const intentLabel =
    intent === "correct"
      ? " · correct mode"
      : intent === "select"
        ? " · select mode"
        : "";

  const selectionIgnored =
    selection?.kind === "transcriptRange" &&
    selectionAllIgnored(
      project,
      selection.trackId,
      selection.startWordIndex,
      selection.endWordIndex,
    );

  return (
    <div className="transcript-panel">
      <div className="transcript-toolbar">
        <span className="transcript-meta">
          {mappedCount} utterances
          {cutAwayCount > 0 ? ` · ${cutAwayCount} cut away` : ""}
          {turns.length < utterances.length ? ` · ${turns.length} turns` : ""}
          {transcriptFollowPlayhead
            ? " · following playhead"
            : " · scroll unlocked"}
          {intentLabel}
        </span>
        <div className="transcript-toolbar-actions">
          <ToggleButton
            pressed={transcriptAnnotate}
            className="transcript-follow-btn transcript-annotate-btn"
            title={capabilityTooltip("daw.view.transcriptAnnotate", {
              pressed: transcriptAnnotate,
            })}
            aria-label={capabilityTooltip("daw.view.transcriptAnnotate", {
              pressed: transcriptAnnotate,
            })}
            onClick={() => toggleTranscriptAnnotate()}
          >
            Annotate
          </ToggleButton>
          {transcriptAnnotate && cutAwayCount > 0 && (
            <ToggleButton
              pressed={showCutAwayUtterances}
              className="transcript-follow-btn"
              title={capabilityTooltip("daw.view.showCutAway", {
                pressed: showCutAwayUtterances,
              })}
              aria-label={capabilityTooltip("daw.view.showCutAway", {
                pressed: showCutAwayUtterances,
              })}
              onClick={() => setShowCutAwayUtterances(!showCutAwayUtterances)}
            >
              {showCutAwayUtterances ? "Hide cut away" : "Show cut away"}
            </ToggleButton>
          )}
          {transcriptAnnotate && reviewStops.length > 0 && (
            <div
              className="transcript-review-group"
              role="group"
              aria-label="Low-confidence review"
            >
              <CommandButton
                commandId="transcript.prevLowConfidence"
                className="transcript-follow-btn"
                title={capabilityTooltip("daw.transcript.prevLowConfidence")}
                aria-label={capabilityTooltip(
                  "daw.transcript.prevLowConfidence",
                )}
              >
                Previous
              </CommandButton>
              <span className="transcript-review-count">
                {reviewPosition >= 0
                  ? `${reviewPosition + 1}/${reviewStops.length}`
                  : reviewStops.length}{" "}
                low-confidence
              </span>
              <CommandButton
                commandId="transcript.nextLowConfidence"
                className="transcript-follow-btn"
                title={capabilityTooltip("daw.transcript.nextLowConfidence")}
                aria-label={capabilityTooltip(
                  "daw.transcript.nextLowConfidence",
                )}
              >
                Next
              </CommandButton>
            </div>
          )}
          {hostEditable && (
            <div
              className="transcript-mode-group"
              role="group"
              aria-label="Transcript mode"
            >
              <ToggleButton
                pressed={intent === "correct"}
                disabled={!wordsHydrated}
                className="transcript-follow-btn transcript-correct-btn"
                title={
                  wordsHydrated
                    ? capabilityTooltip("daw.transcript.correct", {
                        pressed: intent === "correct",
                      })
                    : "Loading transcript words…"
                }
                aria-label={
                  wordsHydrated
                    ? capabilityTooltip("daw.transcript.correct", {
                        pressed: intent === "correct",
                      })
                    : "Loading transcript words…"
                }
                onClick={() =>
                  setIntent((v) => (v === "correct" ? "navigate" : "correct"))
                }
              >
                Correct
              </ToggleButton>
              <ToggleButton
                pressed={intent === "select"}
                className="transcript-follow-btn"
                title={capabilityTooltip("daw.transcript.select", {
                  pressed: intent === "select",
                })}
                aria-label={capabilityTooltip("daw.transcript.select", {
                  pressed: intent === "select",
                })}
                onClick={() =>
                  setIntent((v) => (v === "select" ? "navigate" : "select"))
                }
              >
                Select
              </ToggleButton>
              {intent === "select" && (
                <CommandButton
                  commandId="transcript.ignoreWords"
                  className="transcript-follow-btn"
                  disabled={
                    !wordsHydrated || selection?.kind !== "transcriptRange"
                  }
                  aria-label={capabilityTooltip("daw.transcript.ignore", {
                    pressed: selectionIgnored,
                  })}
                  title={capabilityTooltip("daw.transcript.ignore", {
                    pressed: selectionIgnored,
                  })}
                >
                  {selectionIgnored ? "Restore" : "Ignore"}
                </CommandButton>
              )}
            </div>
          )}
          <ToggleButton
            pressed={transcriptFollowPlayhead}
            className="transcript-follow-btn"
            title={
              transcriptFollowPlayhead
                ? "Unlock transcript scroll from playhead"
                : "Lock transcript scroll to playhead"
            }
            onClick={() => toggleTranscriptFollowPlayhead()}
          >
            {transcriptFollowPlayhead ? "Follow" : "Unlocked"}
          </ToggleButton>
        </div>
      </div>
      {canCorrect ? (
        <>
          <p className="transcript-mode-hint">{toolbarHint}</p>
          <span className="sr-only" role="status">
            {transcriptInlineCommitPending
              ? TRANSCRIPT_INLINE_SAVING_STATUS
              : ""}
          </span>
        </>
      ) : null}
      {canCorrect &&
      transcriptInlineEditFailure &&
      transcriptInlineEditFailure.projectPath === projectPath ? (
        <div className="transcript-inline-failure">
          <InlineError
            role="alert"
            message={transcriptInlineEditFailure.message}
          />
          <Button
            variant="link"
            onClick={() => setTranscriptInlineEditFailure(null)}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {dockWordEditor && selection?.kind === "transcriptWord" ? (
        <div className="transcript-docked-editor">
          <TranscriptWordInspector
            key={`${selection.trackId}:${selection.wordIndex}`}
            trackId={selection.trackId}
            wordIndex={selection.wordIndex}
            embedded
          />
        </div>
      ) : null}
      <div
        className={`transcript-list${virtualized ? " is-virtualized" : ""}`}
        ref={listRef}
        {...(virtualized
          ? {
              role: "list",
              "aria-label": `Transcript, ${turns.length} turns`,
            }
          : {})}
        {...scrollIntentHandlers}
        onFocus={(e) => {
          const turnEl = (e.target as Element).closest("[data-turn-index]");
          const idx = Number(turnEl?.getAttribute("data-turn-index") ?? -1);
          setFocusedTurnIndex(Number.isInteger(idx) ? idx : -1);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setFocusedTurnIndex(-1);
          }
        }}
        onPointerDown={(event) => {
          scrollIntentHandlers.onPointerDown(event);
          const word =
            canCorrect && event.target instanceof Element
              ? event.target.closest<HTMLElement>("[data-transcript-word]")
              : null;
          const wordIndex = Number(word?.dataset.wordIndex);
          const trackId = word?.dataset.trackId;
          pressedWordRef.current =
            trackId && Number.isInteger(wordIndex)
              ? { trackId, wordIndex }
              : null;
          // Arm only where correction is possible; elsewhere a hold is a tap.
          if (pressedWordRef.current) {
            transcriptLongPress.onPointerDown(event);
          }
        }}
        onClickCapture={transcriptLongPress.onClickCapture}
        onPointerMove={transcriptLongPress.onPointerMove}
        onPointerUpCapture={(event) => {
          longPressReleasedRef.current = transcriptLongPress.onPointerUp(event);
        }}
        onPointerCancel={transcriptLongPress.onPointerCancel}
        onScroll={() => {
          scheduleViewAnchor();
          // Only wheel / touch / scrollbar / scroll-key input unlocks follow;
          // follow centering and virtualizer re-measure writes never do.
          if (!isUserScroll()) {
            return;
          }
          if (transcriptFollowPlayhead) {
            setTranscriptFollowPlayhead(false);
          }
          if (followingClientId) {
            stopFollow("local");
          }
        }}
      >
        {virtualized && (
          <div
            className="transcript-virtual-spacer"
            aria-hidden="true"
            style={{ height: totalSize }}
          />
        )}
        {renderList.map(({ turn, turnIndex, virtualItem }) => {
          const lead = turn.utterances[0];
          const blockSeek = turnSeekSec(turn);
          const labelSec = blockSeek ?? lead.start;
          const turnHasActive = turn.utterances.some(
            (u, j) =>
              isMappedUtterance(u) &&
              active.utterances.has(turn.startIndex + j),
          );
          const turnAllUnmapped = turn.utterances.every(
            (u) => !isMappedUtterance(u),
          );
          let flatWordIndex = 0;
          const segments: TranscriptTurnSegment[] = turn.utterances.map(
            (u, j) => {
              const flatIndex = turn.startIndex + j;
              const unmapped = !isMappedUtterance(u);
              const uttActive = !unmapped && active.utterances.has(flatIndex);
              const words = wordsForUtterance(u);
              const runsByLastPos = hostEditable
                ? new Map(
                    ignoredRuns(u.track_id, words).map((run) => [
                      run.endWordIndex,
                      run,
                    ]),
                  )
                : null;
              const activeWord = words.find(
                (_w, wi) =>
                  !unmapped && active.words.has(activeWordId(flatIndex, wi)),
              );
              return {
                key: `${u.track_id}-${u.start}-${flatIndex}`,
                active: uttActive,
                unmapped,
                suppressedOnly: Boolean(u.suppressed_only),
                activeRef: bindActiveRef(uttActive && !activeWord),
                words: words.map((w, wi) => {
                  const afterWordIndex = flatWordIndex;
                  flatWordIndex += 1;
                  const wSeek = wordSeekSec(w);
                  const wActive =
                    !unmapped && active.words.has(activeWordId(flatIndex, wi));
                  const wordIndex = w.word_index;
                  const selected = wordInRange(
                    selection,
                    u.track_id,
                    wordIndex,
                  );
                  const lowConf =
                    transcriptAnnotate &&
                    !u.suppressed_only &&
                    isLowConfidenceWord(w);
                  const prominent =
                    wordIndex != null &&
                    prominentKeys.has(prominentWordKey(u.track_id, wordIndex));
                  const reviewCurrent =
                    transcriptAnnotate &&
                    wordIndex != null &&
                    transcriptReviewCursor?.trackId === u.track_id &&
                    transcriptReviewCursor.wordIndex === wordIndex;
                  // Suppressed words are already handled; they keep only the strikethrough.
                  const suspectChip =
                    transcriptAnnotate &&
                    Boolean(w.suspect_hallucination) &&
                    !w.suppressed;
                  const cutAwayChip =
                    transcriptAnnotate &&
                    showCutAwayUtterances &&
                    w.mappable === false;
                  const wordInteractive =
                    ((intent === "correct" || intent === "select") &&
                      wordIndex != null) ||
                    wSeek != null;
                  // Same gate as a navigate-mode chip button (wSeek implies mappable):
                  // an untimed word stays plain text; Correct mode still fixes it.
                  const inlineEditable =
                    canCorrect &&
                    intent === "navigate" &&
                    wordIndex != null &&
                    wSeek != null;
                  const editingThis =
                    inlineEditable &&
                    inlineEdit?.trackId === u.track_id &&
                    inlineEdit.wordIndex === wordIndex;
                  const wordAnchor = presenceAnchorProps(
                    transcriptWordAnchor(
                      turnIndex,
                      u.track_id,
                      wordIndex,
                      afterWordIndex,
                    ),
                  );
                  const cutAwayTip = cutAwayChip
                    ? TRANSCRIPT_CUT_AWAY_WORD_TIP
                    : undefined;
                  const suspectTip = suspectChip
                    ? HALLUCINATION_WARNING
                    : undefined;
                  const ignoredTip = w.ignored
                    ? TRANSCRIPT_IGNORED_WORD_TIP
                    : undefined;
                  const lockedTip = w.audibility_locked
                    ? TRANSCRIPT_AUDIBILITY_LOCKED_TIP
                    : undefined;
                  const restoreRun =
                    wordIndex != null
                      ? runsByLastPos?.get(wordIndex)
                      : undefined;
                  const restoreText = restoreRun
                    ? words
                        .filter(
                          (rw) =>
                            rw.word_index != null &&
                            rw.word_index >= restoreRun.startWordIndex &&
                            rw.word_index <= restoreRun.endWordIndex,
                        )
                        .map((rw) => rw.text)
                        .join(" ")
                    : "";
                  const interactionTip = wordInteractive
                    ? wordInteractionTip({
                        intent,
                        wordIndex,
                        seekSec: wSeek,
                        inlineEditable,
                      })
                    : undefined;
                  return {
                    word: w,
                    trackId: u.track_id,
                    active: wActive,
                    unmapped: w.mappable === false,
                    selected,
                    lowConfidence: lowConf,
                    reviewCurrent,
                    suspectHallucination: suspectChip,
                    prominent,
                    interactive: wordInteractive,
                    activeRef: bindActiveRef(wActive),
                    anchorProps: wordAnchor,
                    title:
                      [
                        cutAwayTip ?? interactionTip,
                        suspectTip,
                        ignoredTip,
                        lockedTip,
                        prominent ? PROMINENT_TIP : undefined,
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined,
                    ariaLabel: cutAwayTip,
                    boundaryAfter: renderBoundaryMarks(
                      turnIndex,
                      afterWordIndex,
                      turn.trackId,
                    ),
                    restoreControl: restoreRun ? (
                      <CommandButton
                        commandId="transcript.ignoreWords"
                        args={{
                          trackId: u.track_id,
                          startWordIndex: restoreRun.startWordIndex,
                          endWordIndex: restoreRun.endWordIndex,
                          ignored: false,
                        }}
                        bare
                        className="utterance-restore"
                        aria-label={`Restore ignored: ${restoreText}`}
                        title={`Restore ignored: ${restoreText}`}
                      >
                        Restore
                      </CommandButton>
                    ) : undefined,
                    editor:
                      editingThis && wordIndex != null ? (
                        <InlineWordEditor
                          key={`${u.track_id}:${wordIndex}`}
                          trackId={u.track_id}
                          wordIndex={wordIndex}
                          initialText={w.text}
                          onClose={(restore) =>
                            closeInlineEdit(
                              { trackId: u.track_id, wordIndex },
                              restore,
                            )
                          }
                          onBusyChange={setTranscriptInlineCommitPending}
                        />
                      ) : undefined,
                    buttonProps: wordInteractive
                      ? {
                          onMouseDown: (e) => {
                            if (
                              intent !== "select" ||
                              wordIndex == null ||
                              e.button !== 0
                            ) {
                              return;
                            }
                            // Shift-click extends in onClick — do not reset the anchor.
                            if (e.shiftKey) {
                              return;
                            }
                            e.preventDefault();
                            draggingRef.current = true;
                            dragExtendedRef.current = false;
                            rangeAnchorRef.current = wordIndex;
                            setRange(u.track_id, wordIndex, wordIndex);
                          },
                          onPointerUp: (e) => {
                            // Single taps still act immediately via onClick;
                            // this only spots a second tap on the same word.
                            if (
                              longPressReleasedRef.current ||
                              !canCorrect ||
                              e.pointerType !== "touch" ||
                              wordIndex == null
                            )
                              return;
                            const previous = lastTouchTapRef.current;
                            const now = Date.now();
                            lastTouchTapRef.current = {
                              trackId: u.track_id,
                              wordIndex,
                              at: now,
                            };
                            if (
                              previous?.trackId === u.track_id &&
                              previous.wordIndex === wordIndex &&
                              now - previous.at <= DOUBLE_TAP_MS
                            ) {
                              correctedTouchAtRef.current = now;
                              lastTouchTapRef.current = null;
                              pendingCorrectionRef.current = {
                                trackId: u.track_id,
                                wordIndex,
                              };
                            }
                          },
                          onMouseEnter: () => {
                            if (
                              !draggingRef.current ||
                              intent !== "select" ||
                              wordIndex == null ||
                              rangeAnchorRef.current == null
                            ) {
                              return;
                            }
                            if (wordIndex !== rangeAnchorRef.current) {
                              dragExtendedRef.current = true;
                            }
                            setRange(
                              u.track_id,
                              rangeAnchorRef.current,
                              wordIndex,
                            );
                          },
                          onClick: (e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            const pending = pendingCorrectionRef.current;
                            pendingCorrectionRef.current = null;
                            const recentDoubleTap = withinGhostClick(
                              correctedTouchAtRef.current,
                            );
                            if (
                              pending?.trackId === u.track_id &&
                              pending.wordIndex === wordIndex &&
                              recentDoubleTap
                            ) {
                              openWordCorrection(pending);
                              return;
                            }
                            if (recentDoubleTap) {
                              return;
                            }
                            if (intent === "correct" && wordIndex != null) {
                              cancelQueuedSeek();
                              setSelection({
                                kind: "transcriptWord",
                                trackId: u.track_id,
                                wordIndex,
                              });
                              return;
                            }
                            if (intent === "select" && wordIndex != null) {
                              if (
                                e.shiftKey &&
                                rangeAnchorRef.current != null
                              ) {
                                setRange(
                                  u.track_id,
                                  rangeAnchorRef.current,
                                  wordIndex,
                                );
                                return;
                              }
                              // mouseup clears draggingRef before click; keep drag range.
                              if (dragExtendedRef.current) {
                                dragExtendedRef.current = false;
                                return;
                              }
                              rangeAnchorRef.current = wordIndex;
                              setRange(u.track_id, wordIndex, wordIndex);
                              return;
                            }
                            if (wSeek != null) {
                              seekWordNow(wSeek);
                            }
                          },
                          onDoubleClick:
                            wSeek != null
                              ? (e) => {
                                  e.stopPropagation();
                                  e.preventDefault();
                                  if (
                                    withinGhostClick(
                                      correctedTouchAtRef.current,
                                    )
                                  ) {
                                    return;
                                  }
                                  // Mouse edits inline; touch double-tap already
                                  // opened the Correct sheet (ghost-click guard above).
                                  // Deliberate: the sheet leaves room for the on-screen
                                  // keyboard and keeps Suppress / End index. Both paths
                                  // submit through submitWordCorrection.
                                  if (inlineEditable && wordIndex != null) {
                                    openInlineEdit({
                                      trackId: u.track_id,
                                      wordIndex,
                                    });
                                    return;
                                  }
                                  if (wSeek != null) {
                                    seekWordNow(wSeek);
                                  }
                                }
                              : undefined,
                        }
                      : undefined,
                  };
                }),
              };
            },
          );
          return (
            <TranscriptTurnView
              key={turnKey(turn)}
              speaker={turn.speaker}
              labelSec={labelSec}
              seekSec={blockSeek}
              onSeek={
                blockSeek != null ? () => seekTurnSoon(blockSeek) : undefined
              }
              active={turnHasActive}
              unmapped={turnAllUnmapped}
              suppressedOnly={turn.utterances.every((u) => u.suppressed_only)}
              turnIndex={turnIndex}
              slotProps={virtualItem ? slotProps(virtualItem) : undefined}
              anchorProps={presenceAnchorProps(
                presenceAnchor("transcript", "turn", turnIndex),
              )}
              boundaryBefore={renderBoundaryMarks(turnIndex, -1, turn.trackId)}
              segments={segments}
            />
          );
        })}
      </div>
    </div>
  );
}
