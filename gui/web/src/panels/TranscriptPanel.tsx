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
import { isShareProjectKey } from "../shareMode";
import { useDaw } from "../state/useDaw";
import { EditBoundaryMark } from "../transcript/EditBoundaryMark";
import {
  indexBoundaryPlacements,
  type PlacementTurn,
  placeEditBoundaries,
} from "../transcript/editBoundaryPlacement";
import type {
  CombinedUtterance,
  EditBoundaryView,
  Selection,
} from "../types/project";
import { FocusToggle, ToggleButton } from "../ui";
import {
  findActiveUtteranceIndex,
  findTurnIndexForUtterance,
  groupConsecutiveSpeakerTurns,
  isUtteranceActive,
  isWordActive,
  scrollChildIntoParent,
  selectUnmappedUtterances,
  transcriptAnchorTurnIndex,
  transcriptWordAnchor,
  turnKey,
  turnSeekSec,
  wordSeekSec,
  wordsForUtterance,
} from "../utils/transcript";

const LOW_CONFIDENCE = 0.7;
const EMPTY_UTTERANCES: CombinedUtterance[] = [];
const EMPTY_BOUNDARIES: EditBoundaryView[] = [];

type TranscriptIntent = "navigate" | "correct" | "select";

function transcriptWordExists(
  utterances: readonly CombinedUtterance[],
  trackId: string,
  wordIndex: number,
): boolean {
  return utterances.some(
    (u) =>
      u.track_id === trackId &&
      (u.words ?? []).some((w) => w.word_index === wordIndex),
  );
}

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
    playheadSec,
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
    focusMode,
    followingClientId,
    stopFollow,
    transcriptScrollRequest,
    setTranscriptScrollRequest,
    setTranscriptViewAnchor,
  } = useDaw();
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
    setIntentState(next);
  };
  const lastTouchTapRef = useRef<(WordRef & { at: number }) | null>(null);
  const correctedTouchAtRef = useRef(-Infinity);
  const pendingCorrectionRef = useRef<WordRef | null>(null);
  /** Word under the finger at pointerdown (long-press fires on release). */
  const pressedWordRef = useRef<WordRef | null>(null);
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
      !transcriptWordExists(allUtterances, trackId, wordIndex)
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
  const utterances = useMemo(() => {
    // Cut-away reveal is nested under Annotate (clean view stays clean).
    if (transcriptAnnotate && showCutAwayUtterances) {
      return allUtterances;
    }
    return allUtterances.filter((u) => u.mappable !== false);
  }, [allUtterances, showCutAwayUtterances, transcriptAnnotate]);
  const editBoundaries = project?.edit_boundaries ?? EMPTY_BOUNDARIES;
  const turns = useMemo(
    () => groupConsecutiveSpeakerTurns(utterances),
    [utterances],
  );
  const activeIndex = useMemo(
    () => findActiveUtteranceIndex(utterances, playheadSec),
    [utterances, playheadSec],
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
  // always find their element, and focus/selection survive scrolling away.
  const pinnedTurns = useMemo(
    () =>
      [
        activeTurnIndex,
        focusedTurnIndex,
        selectedAnchor ? transcriptAnchorTurnIndex(turns, selectedAnchor) : -1,
        transcriptScrollRequest
          ? transcriptAnchorTurnIndex(turns, transcriptScrollRequest)
          : requestTurnIndex,
      ].filter((i) => i >= 0),
    [
      activeTurnIndex,
      focusedTurnIndex,
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
    measureElement,
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
    if (hold?.follow && hold.sec === playheadSec) {
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
    activeIndex,
    activeTurnStart,
    playheadSec,
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
      sec: playheadSec,
      follow: transcriptFollowPlayhead,
    };
    scrollChildIntoParent(root, el, 0.2);
  }, [
    playheadSec,
    transcriptFollowPlayhead,
    transcriptScrollRequest,
    setTranscriptScrollRequest,
    turns,
  ]);

  if (!allUtterances.length) {
    return <p style={{ color: "var(--text-dim)" }}>No combined transcript.</p>;
  }

  const mappedCount = allUtterances.length - cutAwayCount;
  const dockWordEditor =
    focusMode === "text" &&
    selection?.kind === "transcriptWord" &&
    intent === "correct";

  const intentLabel =
    intent === "correct"
      ? " · correct mode"
      : intent === "select"
        ? " · select mode"
        : "";

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
          <FocusToggle mode="text" label="Transcript" />
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
          {hostEditable && (
            <>
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
            </>
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
      {dockWordEditor && selection?.kind === "transcriptWord" ? (
        <div className="transcript-docked-editor">
          <TranscriptWordInspector
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
            (u) => u.mappable !== false && isUtteranceActive(u, playheadSec),
          );
          const turnAllUnmapped = turn.utterances.every(
            (u) => u.mappable === false,
          );
          let flatWordIndex = 0;
          return (
            <div
              key={turnKey(turn)}
              className={`utterance-turn${turnHasActive ? " active" : ""}${turnAllUnmapped ? " unmapped" : ""}`}
              ref={virtualItem ? measureElement : undefined}
              style={
                virtualItem
                  ? { transform: `translateY(${virtualItem.start}px)` }
                  : undefined
              }
              {...(virtualItem
                ? {
                    role: "listitem",
                    "aria-setsize": turns.length,
                    "aria-posinset": turnIndex + 1,
                  }
                : {})}
              data-index={virtualItem?.index}
              data-turn-index={turnIndex}
              {...presenceAnchorProps(
                presenceAnchor("transcript", "turn", turnIndex),
              )}
            >
              {blockSeek != null ? (
                <button
                  type="button"
                  className="utterance-seek"
                  title={`Seek turn (${blockSeek.toFixed(1)}s)`}
                  onClick={() => seekTurnSoon(blockSeek)}
                >
                  <strong className="utterance-speaker">{turn.speaker}</strong>{" "}
                  <span className="utterance-time">
                    [{labelSec.toFixed(1)}s]
                  </span>
                </button>
              ) : (
                <>
                  <strong className="utterance-speaker">{turn.speaker}</strong>{" "}
                  <span className="utterance-time">
                    [{labelSec.toFixed(1)}s]
                  </span>
                </>
              )}{" "}
              {renderBoundaryMarks(turnIndex, -1, turn.trackId)}
              {turn.utterances.map((u, j) => {
                const flatIndex = turn.startIndex + j;
                const unmapped = u.mappable === false;
                const uttActive =
                  !unmapped && isUtteranceActive(u, playheadSec);
                const words = wordsForUtterance(u);
                const activeWord = words.find(
                  (w) => !unmapped && isWordActive(w, playheadSec),
                );
                return (
                  <span
                    key={`${u.track_id}-${u.start}-${flatIndex}`}
                    ref={bindActiveRef(uttActive && !activeWord)}
                    className={`utterance-seg${uttActive ? " active" : ""}${unmapped ? " unmapped" : ""}`}
                  >
                    {j > 0 ? " " : ""}
                    {words.map((w, wi) => {
                      const afterWordIndex = flatWordIndex;
                      flatWordIndex += 1;
                      const wSeek = wordSeekSec(w);
                      const wActive = !unmapped && isWordActive(w, playheadSec);
                      const sep = wi > 0 ? " " : "";
                      const wordIndex = w.word_index;
                      const selected = wordInRange(
                        selection,
                        u.track_id,
                        wordIndex,
                      );
                      const lowConf =
                        transcriptAnnotate &&
                        w.confidence != null &&
                        w.confidence < LOW_CONFIDENCE;
                      const cutAwayChip =
                        transcriptAnnotate &&
                        showCutAwayUtterances &&
                        w.mappable === false;
                      const chipClass = [
                        "utterance-word",
                        wActive ? "active" : "",
                        w.mappable === false ? "unmapped" : "",
                        w.suppressed ? "suppressed" : "",
                        lowConf ? "low-confidence" : "",
                        selected ? "selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const wordInteractive =
                        ((intent === "correct" || intent === "select") &&
                          wordIndex != null) ||
                        wSeek != null;
                      const wordAnchor = presenceAnchorProps(
                        transcriptWordAnchor(
                          turnIndex,
                          u.track_id,
                          wordIndex,
                          afterWordIndex,
                        ),
                      );
                      const cutAwayTip = cutAwayChip
                        ? capabilityTooltip("daw.view.cutAwayWord")
                        : undefined;
                      const wordInner = wordInteractive ? (
                        <button
                          type="button"
                          ref={bindActiveRef(wActive)}
                          className={chipClass}
                          data-transcript-word
                          data-track-id={u.track_id}
                          data-word-index={wordIndex}
                          {...wordAnchor}
                          title={
                            cutAwayTip ??
                            (intent === "correct"
                              ? wordIndex != null
                                ? "Click: select for Correct · Double-click: seek"
                                : undefined
                              : intent === "select"
                                ? wordIndex != null
                                  ? "Click/drag: select range · Shift+click: extend · Double-click: seek"
                                  : undefined
                                : wSeek != null
                                  ? `Double-click: ${wSeek.toFixed(1)}s`
                                  : undefined)
                          }
                          aria-label={cutAwayTip}
                          onMouseDown={(e) => {
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
                          }}
                          onPointerUp={(e) => {
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
                          }}
                          onMouseEnter={() => {
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
                          }}
                          onClick={(e) => {
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
                          }}
                          onDoubleClick={
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
                                  seekWordNow(wSeek);
                                }
                              : undefined
                          }
                        >
                          {w.text}
                        </button>
                      ) : (
                        <span
                          ref={bindActiveRef(wActive)}
                          className={chipClass}
                          title={cutAwayTip}
                          {...wordAnchor}
                        >
                          {w.text}
                        </span>
                      );
                      return (
                        <span key={`${w.start}-${wi}-${wordIndex ?? wi}`}>
                          {sep}
                          {wordInner}
                          {renderBoundaryMarks(
                            turnIndex,
                            afterWordIndex,
                            turn.trackId,
                          )}
                        </span>
                      );
                    })}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
