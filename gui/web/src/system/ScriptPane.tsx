import {
  type CSSProperties,
  Fragment,
  forwardRef,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUserScrollIntent } from "../hooks/useUserScrollIntent";
import { presenceColorVar } from "../presence/colors";
import { Cover } from "./Cover";
import { PersonAvatar } from "./Person";
import { percentOf } from "./progress";
import { Seam } from "./Seam";
import { type HandlePlace, SelectionHandles } from "./SelectionHandles";
import { Skeleton } from "./Skeleton";
import { StatusRow } from "./StatusRow";
import { Suggestion } from "./Suggestion";
import { SystemIcon } from "./SystemIcon";
import {
  continuesSpeaker,
  pieceEnd,
  pieceStart,
  piecesOf,
  type ScriptCaret,
  type ScriptPiece,
  type ScriptSelection,
  type ScriptSpan,
  type ScriptStatus,
  type ScriptStop,
  type ScriptTurn,
  type ScriptWord,
  stopContaining,
  stopsOf,
  type WordFound,
  type WordsSelection,
  withEditing,
  wordLabel,
} from "./scriptPieces";
import {
  dragEdge,
  edgePosition,
  extendTo,
  type HandleEdge,
  type HandleStep,
  horizontalStep,
  isLeftKey,
  isNavKey,
  isVerticalKey,
  type MarginControl,
  marginStep,
  navigate,
  nearestStop,
  type StopRect,
  selectionSummary,
  spanOf,
  stepEdge,
} from "./scriptSelection";

export type ScriptPaneHandle = {
  /** Scroll the word into view. False when the pane does not show it, so the host should widen its window of turns. */
  scrollToWord: (index: number, block?: ScrollLogicalPosition) => boolean;
};

/**
 * Every callback is optional. A pane without them reads, and a header control
 * whose callback is missing is not drawn, which is how a guest's pane is made.
 *
 * The pane draws the turns it is given and keeps nothing about the rest of the
 * episode, so a host that virtualizes passes a window of turns whose word
 * indices are the episode's. Keyboard moves stop at the window's edge; the
 * host widens the window and uses `scrollToWord` to land on a word.
 */
export type ScriptPaneProps = {
  turns: readonly ScriptTurn[];
  status?: ScriptStatus;
  /** `phone` reads at 17/28 instead of 16/26. */
  layout?: "desktop" | "phone";
  /** The words under the playhead. Two tracks can speak at once. */
  playing?: number | readonly number[];
  selection?: ScriptSelection | null;
  carets?: readonly ScriptCaret[];
  /** Find hits, by word span, and which one is current. */
  matches?: readonly ScriptSpan[];
  currentMatch?: number;
  /** Fix text: the words in this span give way to `renderEditor`'s field. */
  editing?: ScriptSpan | null;
  renderEditor?: (span: ScriptSpan) => ReactNode;
  /** Cut words show struck instead of collapsing into a pill. */
  showCutText?: boolean;
  /** The pane scrolls with the playhead. Off, "Back to playhead" shows. */
  following?: boolean;
  /**
   * A bar between the header and the turns: the Find bar. The host opens it on
   * Mod+F or on `onFind` and keeps its own state; the pane only gives it room.
   */
  findBar?: ReactNode;
  /** Draw the two grips on a words selection. On whenever `onSelect` is given. */
  handles?: boolean;
  /** A guest reads, selects and comments. Fixing and cutting are not offered. */
  guest?: "viewer" | "commenter";
  /** The chip's count when `turns` is only a window of the transcript. */
  unsureCount?: number;
  /** The caret moved: a click, or a plain arrow, Home or End. It sits before word `before`. */
  onCaret?: (before: number) => void;
  /** The selection changed by Shift with a key or a click. */
  onSelect?: (selection: WordsSelection) => void;
  /** The playhead should go to this word. */
  onSeek?: (index: number) => void;
  /** Enter on a word inside the selection: the selection's main verb. */
  onPrimary?: () => void;
  /** Esc with something selected. */
  onClearSelection?: () => void;
  onSeamSelect?: (id: string) => void;
  onSuggestionSelect?: (id: string) => void;
  /** The turn's time was pressed. */
  onSeekTurn?: (turnId: string) => void;
  /** The speaker's name was pressed. The popover anchors to `anchor`. */
  onSpeaker?: (turnId: string, anchor: HTMLElement) => void;
  onFind?: () => void;
  /** Jump to the next word the transcript is unsure of. */
  onNextUnsure?: () => void;
  onShowCutTextChange?: (show: boolean) => void;
  onFollowChange?: (follow: boolean) => void;
  onBackToPlayhead?: () => void;
  /** The reader scrolled by hand: wheel, touch, scrollbar or paging key. The host turns follow off. */
  onUserScroll?: () => void;
};

type FoundSpan = ScriptSpan & { current: boolean };

/** A turn's margin controls in reading order, the stop its words begin at and the stop before it. */
type TurnMargin = {
  controls: readonly MarginControl[];
  first: number;
  before: number | undefined;
};

type HandlePlaces = { start: HandlePlace; end: HandlePlace };

type Live = {
  stops: readonly ScriptStop[];
  stopPos: ReadonlyMap<number, number>;
  margin: ReadonlyMap<string, TurnMargin>;
  marginAt: ReadonlyMap<number, string>;
  selection: ScriptSelection | null;
  ownCaret: number | undefined;
  props: Pick<
    ScriptPaneProps,
    | "onCaret"
    | "onSelect"
    | "onSeek"
    | "onPrimary"
    | "onClearSelection"
    | "onSeamSelect"
    | "onSuggestionSelect"
    | "onSeekTurn"
    | "onSpeaker"
  >;
};

/** Handlers with one identity for the pane's life, so a playhead tick leaves every memoized piece alone. */
type Actions = {
  register: (start: number, el: HTMLElement | null) => void;
  registerMargin: (
    turnId: string,
    control: MarginControl,
    el: HTMLElement | null,
  ) => void;
  marginKey: (
    event: KeyboardEvent<HTMLElement>,
    turnId: string,
    control: MarginControl,
  ) => void;
  click: (index: number, shift: boolean) => void;
  key: (event: KeyboardEvent<HTMLElement>, start: number) => void;
  seam: (id: string) => void;
  suggestion: (id: string) => void;
  seekTurn: (turnId: string) => void;
  speaker: (turnId: string, anchor: HTMLElement) => void;
};

const NO_CARETS: readonly ScriptCaret[] = [];
const NO_NUMBERS: readonly number[] = [];
const NO_FOUND: readonly FoundSpan[] = [];
const NO_MATCHES: readonly ScriptSpan[] = [];
const READY: ScriptStatus = { kind: "ready" };

const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

const within = (span: ScriptSpan | null, index: number) =>
  span !== null && index >= span.start && index <= span.end;

const overlaps = (span: ScriptSpan | null, from: number, to: number) =>
  span !== null && span.start <= to && span.end >= from;

const focusable = (el: HTMLElement | undefined) =>
  el?.matches("button") ? el : el?.querySelector<HTMLElement>("button");

const rectOf = (el: HTMLElement | undefined): StopRect | null => {
  if (!el) return null;
  const r = el.getClientRects()[0] ?? el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
};

/** Where the grips go, in the body's own scrolling space: the start's first line and the end's last. Null while an end is not drawn. */
function placeHandles(
  body: HTMLElement | null,
  startEl: HTMLElement | undefined,
  endEl: HTMLElement | undefined,
): HandlePlaces | null {
  if (!body || !startEl || !endEl) return null;
  const origin = body.getBoundingClientRect();
  const first = startEl.getClientRects()[0] ?? startEl.getBoundingClientRect();
  const lines = endEl.getClientRects();
  const last = lines[lines.length - 1] ?? endEl.getBoundingClientRect();
  const at = (r: DOMRect, x: number) => ({
    x: x - origin.left + body.scrollLeft,
    y: r.top - origin.top + body.scrollTop,
    height: r.height,
  });
  return { start: at(first, first.left), end: at(last, last.right) };
}

const samePlace = (a: HandlePlaces | null, b: HandlePlaces | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    (["start", "end"] as const).every(
      (edge) =>
        a[edge].x === b[edge].x &&
        a[edge].y === b[edge].y &&
        a[edge].height === b[edge].height,
    ));

/** For each range, the items that touch it. One shared empty list when none do, so untouched turns keep their props. */
function slicePerRange<T>(
  items: readonly T[],
  ranges: readonly { lo: number; hi: number }[],
  touches: (item: T, lo: number, hi: number) => boolean,
  none: readonly T[],
): (readonly T[])[] {
  return ranges.map(({ lo, hi }) => {
    const hit = items.filter((item) => touches(item, lo, hi));
    return hit.length > 0 ? hit : none;
  });
}

export const ScriptPane = forwardRef<ScriptPaneHandle, ScriptPaneProps>(
  function ScriptPane(
    {
      turns,
      status = READY,
      layout = "desktop",
      playing,
      selection: selectionProp = null,
      carets = NO_CARETS,
      matches = NO_MATCHES,
      currentMatch,
      editing,
      renderEditor,
      showCutText = false,
      following = true,
      findBar,
      handles = true,
      guest,
      unsureCount,
      onCaret,
      onSelect,
      onSeek,
      onPrimary,
      onClearSelection,
      onSeamSelect,
      onSuggestionSelect,
      onSeekTurn,
      onSpeaker,
      onFind,
      onNextUnsure,
      onShowCutTextChange,
      onFollowChange,
      onBackToPlayhead,
      onUserScroll,
    },
    ref,
  ) {
    const [focused, setFocused] = useState<number | null>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const registry = useRef(new Map<number, HTMLElement>());
    const marginRegistry = useRef(new Map<string, HTMLElement>());
    const caretRef = useRef<number | null>(null);
    const goalX = useRef<number | null>(null);
    const editedAt = useRef<number | null>(null);
    const [places, setPlaces] = useState<HandlePlaces | null>(null);
    const inside = useRef(false);
    const scrollIntent = useUserScrollIntent();

    const selKind = selectionProp?.kind;
    const selAnchor =
      selectionProp?.kind === "words" ? selectionProp.anchor : -1;
    const selHead = selectionProp?.kind === "words" ? selectionProp.head : -1;
    const selId =
      selectionProp && selectionProp.kind !== "words" ? selectionProp.id : "";
    const selection = useMemo<ScriptSelection | null>(() => {
      if (selKind === "words") {
        return { kind: "words", anchor: selAnchor, head: selHead };
      }
      return selKind ? { kind: selKind, id: selId } : null;
    }, [selKind, selAnchor, selHead, selId]);
    const span = useMemo(() => spanOf(selection), [selection]);

    const editStart = editing?.start;
    const editEnd = editing?.end;
    const basePieces = useMemo(
      () => turns.map((turn) => piecesOf(turn.words, showCutText)),
      [turns, showCutText],
    );
    const piecesByTurn = useMemo(
      () =>
        basePieces.map((pieces) =>
          withEditing(
            pieces,
            editStart === undefined || editEnd === undefined
              ? null
              : { start: editStart, end: editEnd },
          ),
        ),
      [basePieces, editStart, editEnd],
    );
    const { stops, stopPos, ranges, markTurns } = useMemo(() => {
      const all = piecesByTurn.flatMap(stopsOf);
      const marks = new Map<string, Set<number>>();
      piecesByTurn.forEach((pieces, turnIndex) => {
        for (const piece of pieces) {
          if (piece.kind === "cut" || piece.kind === "suggestion") {
            const name = `${piece.kind}:${piece.id}`;
            marks.set(name, (marks.get(name) ?? new Set()).add(turnIndex));
          }
        }
      });
      return {
        stops: all,
        stopPos: new Map(all.map((stop, at) => [stop.start, at])),
        ranges: piecesByTurn.map((pieces) => ({
          lo: pieces.length > 0 ? pieceStart(pieces[0]) : -1,
          hi: pieces.length > 0 ? pieceEnd(pieces[pieces.length - 1]) : -1,
        })),
        markTurns: marks,
      };
    }, [piecesByTurn]);
    const canSeekTurn = onSeekTurn !== undefined;
    const canSpeaker = onSpeaker !== undefined;
    const { margin, marginAt } = useMemo(() => {
      const byTurn = new Map<string, TurnMargin>();
      const byStop = new Map<number, string>();
      turns.forEach((turn, turnIndex) => {
        if (continuesSpeaker(turn, turns[turnIndex - 1])) return;
        const controls: MarginControl[] = [
          ...(canSpeaker ? (["speaker"] as const) : []),
          ...(canSeekTurn ? (["time"] as const) : []),
        ];
        const first = stopsOf(piecesByTurn[turnIndex])[0]?.start;
        if (controls.length === 0 || first === undefined) return;
        const at = stopPos.get(first) ?? 0;
        byTurn.set(turn.id, {
          controls,
          first,
          before: at > 0 ? stops[at - 1].start : undefined,
        });
        byStop.set(first, turn.id);
      });
      return { margin: byTurn, marginAt: byStop };
    }, [turns, piecesByTurn, stops, stopPos, canSpeaker, canSeekTurn]);
    const unsure = useMemo(
      () =>
        turns.reduce(
          (sum, turn) => sum + turn.words.filter((w) => w.lowConfidence).length,
          0,
        ),
      [turns],
    );

    const playingList = useMemo(
      () =>
        playing === undefined
          ? NO_NUMBERS
          : typeof playing === "number"
            ? [playing]
            : playing,
      [playing],
    );
    const playingByTurn = useMemo(
      () =>
        slicePerRange(
          playingList,
          ranges,
          (index, lo, hi) => index >= lo && index <= hi,
          NO_NUMBERS,
        ),
      [playingList, ranges],
    );
    const selectionByTurn = useMemo(
      () => ranges.map(({ lo, hi }) => (overlaps(span, lo, hi) ? span : null)),
      [span, ranges],
    );
    const ownCaret = useMemo(
      () => carets.find((caret) => caret.person === undefined)?.before,
      [carets],
    );
    const caretsByTurn = useMemo(
      () =>
        slicePerRange(
          carets,
          ranges,
          (caret, lo, hi) => caret.before >= lo && caret.before <= hi,
          NO_CARETS,
        ),
      [carets, ranges],
    );
    const foundByTurn = useMemo(
      () =>
        slicePerRange(
          matches.map((match, at) => ({
            ...match,
            current: at === currentMatch,
          })),
          ranges,
          (match, lo, hi) => match.start <= hi && match.end >= lo,
          NO_FOUND,
        ),
      [matches, currentMatch, ranges],
    );
    const summary = useMemo(
      () => selectionSummary(piecesByTurn.flat(), selection),
      [piecesByTurn, selection],
    );

    const tabStop = useMemo(() => {
      if (focused !== null && stopPos.has(focused)) return focused;
      return (
        stopContaining(stops, ownCaret)?.start ??
        stopContaining(stops, playingList[0])?.start ??
        stops[0]?.start ??
        -1
      );
    }, [focused, stopPos, stops, ownCaret, playingList]);

    const live = useRef<Live>({
      stops,
      stopPos,
      margin,
      marginAt,
      selection,
      ownCaret,
      props: {},
    });
    useLayoutEffect(() => {
      live.current = {
        stops,
        stopPos,
        margin,
        marginAt,
        selection,
        ownCaret,
        props: {
          onCaret,
          onSelect,
          onSeek,
          onPrimary,
          onClearSelection,
          onSeamSelect,
          onSuggestionSelect,
          onSeekTurn,
          onSpeaker,
        },
      };
    });

    const actions = useMemo<Actions>(() => {
      const focusStop = (start: number) => {
        setFocused(start);
        focusable(registry.current.get(start))?.focus({ preventScroll: false });
      };
      const marginAtTop = (turnId: string, index: number) => {
        const entry = live.current.margin.get(turnId);
        const control = entry?.controls[index];
        if (control)
          marginRegistry.current.get(`${control}:${turnId}`)?.focus();
      };
      return {
        register: (start, el) => {
          if (el) registry.current.set(start, el);
          else registry.current.delete(start);
        },
        registerMargin: (turnId, control, el) => {
          const name = `${control}:${turnId}`;
          if (el) marginRegistry.current.set(name, el);
          else marginRegistry.current.delete(name);
        },
        marginKey: (event, turnId, control) => {
          if (
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
          ) {
            return;
          }
          const entry = live.current.margin.get(turnId);
          if (!entry) return;
          const move = marginStep(
            entry.controls,
            entry.controls.indexOf(control),
            event.key,
          );
          if (!move) return;
          event.preventDefault();
          if (move.kind === "control") marginAtTop(turnId, move.at);
          else if (move.kind === "text") focusStop(entry.first);
          else if (entry.before !== undefined) focusStop(entry.before);
        },
        click: (index, shift) => {
          const now = live.current;
          goalX.current = null;
          setFocused(index);
          focusable(registry.current.get(index))?.focus({
            preventScroll: true,
          });
          if (shift) {
            const anchor =
              now.selection?.kind === "words"
                ? now.selection.anchor
                : (now.ownCaret ?? caretRef.current ?? index);
            now.props.onSelect?.(
              extendTo(
                anchor,
                stopContaining(now.stops, index) ?? {
                  start: index,
                  end: index,
                },
              ),
            );
            return;
          }
          caretRef.current = index;
          now.props.onCaret?.(index);
          now.props.onSeek?.(index);
        },
        key: (event, start) => {
          if (event.ctrlKey || event.metaKey) return;
          const now = live.current;
          if (event.altKey) {
            const step = event.shiftKey ? horizontalStep(event.key) : null;
            if (step === null) return;
            event.preventDefault();
            const next = stepEdge(now.stops, now.selection, "start", step);
            if (next) now.props.onSelect?.(next);
            return;
          }
          if (event.key === "Escape") {
            if (!now.selection || !now.props.onClearSelection) return;
            event.preventDefault();
            now.props.onClearSelection();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            if (stopContaining(now.stops, start)?.kind !== "word") return;
            event.preventDefault();
            const selected = spanOf(now.selection);
            if (within(selected, start)) {
              now.props.onPrimary?.();
              return;
            }
            caretRef.current = start;
            now.props.onSelect?.({ kind: "words", anchor: start, head: start });
            now.props.onSeek?.(start);
            return;
          }
          if (!isNavKey(event.key)) return;
          event.preventDefault();
          const at = now.stopPos.get(start);
          if (at === undefined) return;
          const turnId = now.marginAt.get(start);
          if (turnId && isLeftKey(event.key) && !event.shiftKey) {
            marginAtTop(turnId, 0);
            return;
          }
          const vertical = isVerticalKey(event.key)
            ? (() => {
                const rects = now.stops.map((stop) =>
                  rectOf(registry.current.get(stop.start)),
                );
                const here = rects[at];
                return {
                  rects,
                  goalX:
                    goalX.current ?? (here ? (here.left + here.right) / 2 : 0),
                };
              })()
            : undefined;
          const moved = navigate(
            now.stops,
            at,
            event.key,
            event.shiftKey,
            now.selection,
            vertical,
          );
          if (!moved) return;
          goalX.current = vertical?.goalX ?? null;
          focusStop(now.stops[moved.to].start);
          if (moved.selection) {
            now.props.onSelect?.(moved.selection);
          } else if (moved.caret !== undefined) {
            caretRef.current = moved.caret;
            now.props.onCaret?.(moved.caret);
          }
        },
        seam: (id) => live.current.props.onSeamSelect?.(id),
        suggestion: (id) => live.current.props.onSuggestionSelect?.(id),
        seekTurn: (turnId) => live.current.props.onSeekTurn?.(turnId),
        speaker: (turnId, anchor) =>
          live.current.props.onSpeaker?.(turnId, anchor),
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        scrollToWord: (index, block = "nearest") => {
          const stop = stopContaining(live.current.stops, index);
          const el = stop ? registry.current.get(stop.start) : undefined;
          el?.scrollIntoView?.({ block });
          return el !== undefined;
        },
      }),
      [],
    );

    const bodyShown = status.kind !== "empty" && status.kind !== "loading";
    useEffect(() => {
      const body = bodyRef.current;
      if (!body) return;
      const onKeyUp = (event: globalThis.KeyboardEvent) => {
        // Space is Play/Pause everywhere; a button must not also click on it.
        if (
          event.key === " " &&
          event.target instanceof HTMLElement &&
          event.target.closest("[data-stop], [data-margin]")
        ) {
          event.preventDefault();
        }
      };
      const onFocusIn = (event: FocusEvent) => {
        inside.current = true;
        if (!(event.target instanceof HTMLElement)) return;
        const stop = event.target.closest<HTMLElement>("[data-stop]");
        if (stop) setFocused(Number(stop.dataset.stop));
      };
      const onFocusOut = (event: FocusEvent) => {
        const el = event.target;
        if (!(el instanceof HTMLElement)) return;
        // Removing the focused element can fire this too; only a live element means focus left.
        queueMicrotask(() => {
          if (el.isConnected) inside.current = false;
        });
      };
      inside.current = body.contains(document.activeElement);
      body.addEventListener("keyup", onKeyUp);
      body.addEventListener("focusin", onFocusIn);
      body.addEventListener("focusout", onFocusOut);
      return () => {
        body.removeEventListener("keyup", onKeyUp);
        body.removeEventListener("focusin", onFocusIn);
        body.removeEventListener("focusout", onFocusOut);
      };
    }, [bodyShown]);

    useLayoutEffect(() => {
      const closedAt = editStart === undefined ? editedAt.current : null;
      editedAt.current = editStart ?? null;
      const from = closedAt ?? focused;
      if (!inside.current || from === null) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const heir =
        stopContaining(stops, from) ??
        stops.find((stop) => stop.start >= from) ??
        stops[stops.length - 1];
      if (!heir) return;
      focusable(registry.current.get(heir.start))?.focus();
    });

    const handlesShown =
      handles && onSelect !== undefined && span !== null && bodyShown;
    const startStop = span ? stopContaining(stops, span.start) : undefined;
    const endStop = span ? stopContaining(stops, span.end) : undefined;
    const startAt = startStop?.start;
    const endAt = endStop?.start;
    useLayoutEffect(() => {
      const next =
        handlesShown && startAt !== undefined && endAt !== undefined
          ? placeHandles(
              bodyRef.current,
              registry.current.get(startAt),
              registry.current.get(endAt),
            )
          : null;
      setPlaces((prev) => (samePlace(prev, next) ? prev : next));
    }, [handlesShown, startAt, endAt, piecesByTurn, layout]);
    useEffect(() => {
      const body = bodyRef.current;
      if (
        !body ||
        !handlesShown ||
        startAt === undefined ||
        endAt === undefined
      ) {
        return;
      }
      const again = () => {
        const next = placeHandles(
          body,
          registry.current.get(startAt),
          registry.current.get(endAt),
        );
        setPlaces((prev) => (samePlace(prev, next) ? prev : next));
      };
      const observer =
        typeof ResizeObserver === "undefined"
          ? undefined
          : new ResizeObserver(again);
      observer?.observe(body);
      document.fonts?.addEventListener("loadingdone", again);
      return () => {
        observer?.disconnect();
        document.fonts?.removeEventListener("loadingdone", again);
      };
    }, [handlesShown, startAt, endAt]);

    const dragHandle = (edge: HandleEdge, point: { x: number; y: number }) => {
      const now = live.current;
      const at = nearestStop(
        now.stops.map((stop) => rectOf(registry.current.get(stop.start))),
        point.x,
        point.y,
      );
      if (at === null) return;
      const next = dragEdge(now.stops, now.selection, edge, now.stops[at]);
      if (next) now.props.onSelect?.(next);
    };
    const stepHandle = (edge: HandleEdge, step: HandleStep) => {
      const now = live.current;
      const next = stepEdge(now.stops, now.selection, edge, step);
      if (next) now.props.onSelect?.(next);
    };
    const edgeText = (stop: ScriptStop | undefined, side: string) => {
      const what =
        stop?.kind === "word"
          ? turns
              .flatMap((turn) => turn.words)
              .find((w) => w.index === stop.start)?.text
          : stop?.kind === "cut"
            ? "cut"
            : "suggested cut";
      return `${side} ${what ?? ""}`.trim();
    };

    const showHeader =
      status.kind === "ready" ||
      status.kind === "transcribing" ||
      status.kind === "outOfDate";

    if (status.kind === "empty") {
      return (
        <section
          className="sys-script"
          aria-label="Script"
          data-layout={layout}
        >
          <Cover
            size="region"
            glyph="file-plus"
            title="No transcript yet"
            primary={{
              label: "Transcribe this episode",
              onClick: status.onTranscribe,
            }}
          >
            Transcribe this episode to edit it by reading.
          </Cover>
        </section>
      );
    }

    const unsureShown = unsureCount ?? unsure;

    return (
      <section className="sys-script" aria-label="Script" data-layout={layout}>
        {showHeader ? (
          <div className="sys-script-header">
            <div className="sys-script-tools">
              {onFind ? (
                <button
                  type="button"
                  className="sys-script-tool"
                  aria-label="Find in transcript"
                  onClick={onFind}
                >
                  <SystemIcon name="text-search" size={16} />
                </button>
              ) : null}
              {unsureShown > 0 && onNextUnsure ? (
                <button
                  type="button"
                  className="sys-script-tool sys-script-unsure"
                  aria-label={`${unsureShown} unsure ${unsureShown === 1 ? "word" : "words"}, go to the next`}
                  onClick={onNextUnsure}
                >
                  <span aria-hidden="true">? {unsureShown}</span>
                </button>
              ) : null}
              {onShowCutTextChange ? (
                <button
                  type="button"
                  className="sys-script-tool"
                  aria-label="Show cut text"
                  aria-pressed={showCutText}
                  onClick={() => onShowCutTextChange(!showCutText)}
                >
                  <SystemIcon
                    name={showCutText ? "eye" : "eye-off"}
                    size={16}
                  />
                </button>
              ) : null}
              {onFollowChange ? (
                <button
                  type="button"
                  className="sys-script-tool"
                  aria-label="Follow the playhead"
                  aria-pressed={following}
                  onClick={() => onFollowChange(!following)}
                >
                  <SystemIcon name="pin" size={16} />
                </button>
              ) : null}
            </div>
            {guest ? (
              <span className="sys-script-guest">
                {guest === "commenter"
                  ? "Read only · you can comment"
                  : "Read only"}
              </span>
            ) : null}
            <div className="sys-script-notice">
              {status.kind === "transcribing" ? (
                <StatusRow
                  density="inline"
                  state="running"
                  title="Transcribing"
                  detail={`${percentOf(status.progress)}%`}
                  valueText={`${percentOf(status.progress)} percent`}
                  progress={status.progress}
                />
              ) : null}
              {status.kind === "outOfDate" ? (
                <StatusRow
                  density="inline"
                  state="needs-you"
                  title="Transcript out of date"
                  action={{ label: "Update", onAction: status.onUpdate }}
                />
              ) : null}
            </div>
          </div>
        ) : null}
        {findBar}
        {status.kind === "loading" ? (
          <Skeleton
            rows={6}
            elapsedMs={status.elapsedMs}
            onRetry={status.onRetry}
          />
        ) : (
          <div
            className="sys-script-body"
            ref={bodyRef}
            {...scrollIntent.handlers}
            onScroll={() => {
              if (scrollIntent.isUserScroll()) onUserScroll?.();
            }}
          >
            {turns.map((turn, turnIndex) => {
              const { lo, hi } = ranges[turnIndex];
              return (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  pieces={piecesByTurn[turnIndex]}
                  continued={continuesSpeaker(turn, turns[turnIndex - 1])}
                  playing={playingByTurn[turnIndex]}
                  selection={selectionByTurn[turnIndex]}
                  selectedCut={
                    selection?.kind === "cut" &&
                    markTurns.get(`cut:${selection.id}`)?.has(turnIndex)
                      ? selection.id
                      : undefined
                  }
                  selectedSuggestion={
                    selection?.kind === "suggestion" &&
                    markTurns.get(`suggestion:${selection.id}`)?.has(turnIndex)
                      ? selection.id
                      : undefined
                  }
                  carets={caretsByTurn[turnIndex]}
                  found={foundByTurn[turnIndex]}
                  tabStop={tabStop >= lo && tabStop <= hi ? tabStop : -1}
                  renderEditor={
                    editing && overlaps(editing, lo, hi)
                      ? renderEditor
                      : undefined
                  }
                  canSeekTurn={canSeekTurn}
                  canSpeaker={canSpeaker}
                  actions={actions}
                />
              );
            })}
            {status.kind === "transcribing" && status.notYet ? (
              <p className="sys-script-notyet">
                Not transcribed yet · {status.notYet}
              </p>
            ) : null}
            {handlesShown && places ? (
              <SelectionHandles
                start={places.start}
                end={places.end}
                startAt={edgePosition(stops, selection, "start")}
                endAt={edgePosition(stops, selection, "end")}
                count={stops.length}
                startText={edgeText(startStop, "before")}
                endText={edgeText(endStop, "after")}
                onDrag={dragHandle}
                onStep={stepHandle}
              />
            ) : null}
          </div>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {summary}
        </div>
        {!following && playingList.length > 0 && onBackToPlayhead ? (
          <button
            type="button"
            className="sys-script-back"
            onClick={onBackToPlayhead}
          >
            <SystemIcon name="locate-fixed" size={14} />
            Back to playhead
          </button>
        ) : null}
      </section>
    );
  },
);

type TurnProps = {
  turn: ScriptTurn;
  pieces: ScriptPiece[];
  continued: boolean;
  playing: readonly number[];
  selection: ScriptSpan | null;
  selectedCut: string | undefined;
  selectedSuggestion: string | undefined;
  carets: readonly ScriptCaret[];
  found: readonly FoundSpan[];
  tabStop: number;
  renderEditor: ((span: ScriptSpan) => ReactNode) | undefined;
  canSeekTurn: boolean;
  canSpeaker: boolean;
  actions: Actions;
};

const TurnView = memo(function TurnView({
  turn,
  pieces,
  continued,
  playing,
  selection,
  selectedCut,
  selectedSuggestion,
  carets,
  found,
  tabStop,
  renderEditor,
  canSeekTurn,
  canSpeaker,
  actions,
}: TurnProps) {
  const foundAt = (index: number): WordFound | undefined => {
    const hit = found.find((f) => f.start <= index && index <= f.end);
    return hit ? (hit.current ? "current" : "match") : undefined;
  };
  const word = (w: ScriptWord) => (
    <WordView
      word={w}
      selected={within(selection, w.index)}
      playing={playing.includes(w.index)}
      tabbable={w.index === tabStop}
      found={foundAt(w.index)}
      actions={actions}
    />
  );
  const gapSelected = (from: number, to: number) =>
    selection !== null && from >= selection.start && to <= selection.end;

  function renderPiece(piece: ScriptPiece): ReactNode {
    switch (piece.kind) {
      case "word":
        return word(piece.word);
      case "cut":
        return (
          <SeamView
            piece={piece}
            selected={selectedCut === piece.id}
            inSelection={
              selectedCut !== piece.id &&
              overlaps(selection, piece.start, piece.end)
            }
            tabbable={piece.start === tabStop}
            actions={actions}
          />
        );
      case "suggestion":
        return (
          <RunView
            piece={piece}
            selected={
              selectedSuggestion === piece.id ||
              overlaps(selection, piece.start, piece.end)
            }
            playing={playing.some((i) => i >= piece.start && i <= piece.end)}
            tabbable={piece.start === tabStop}
            actions={actions}
          />
        );
      case "muted":
        return (
          <span className="sys-script-muted">
            <SystemIcon name="volume-x" size={14} />
            {piece.words.map((w, at) => (
              <Fragment key={w.index}>
                {at > 0 ? (
                  <Gap
                    selected={gapSelected(piece.words[at - 1].index, w.index)}
                  />
                ) : null}
                {carets.length > 0 ? (
                  <Carets carets={carets} from={w.index} to={w.index} />
                ) : null}
                {word(w)}
              </Fragment>
            ))}
          </span>
        );
      case "editing":
        return (
          <span className="sys-script-editor">
            {renderEditor?.({ start: piece.start, end: piece.end })}
          </span>
        );
    }
  }

  return (
    <div
      role="group"
      className="sys-script-turn"
      aria-label={`${firstName(turn.speaker.name)}, ${turn.time}`}
    >
      <div
        className="sys-script-margin"
        style={
          {
            "--sys-person-color": presenceColorVar(turn.speaker.colorIndex),
          } as CSSProperties
        }
      >
        {continued ? null : (
          <>
            <SpeakerLabel
              turn={turn}
              interactive={canSpeaker}
              actions={actions}
            />
            {canSeekTurn ? (
              <button
                type="button"
                className="sys-script-time"
                tabIndex={-1}
                data-margin="time"
                aria-label={`Play from ${turn.time}`}
                ref={(el) => actions.registerMargin(turn.id, "time", el)}
                onKeyDown={(event) => actions.marginKey(event, turn.id, "time")}
                onClick={() => actions.seekTurn(turn.id)}
              >
                {turn.time}
              </button>
            ) : (
              <span className="sys-script-time">{turn.time}</span>
            )}
          </>
        )}
      </div>
      <p className="sys-script-text">
        {pieces.map((piece, at) => {
          const start = pieceStart(piece);
          const previous = pieces[at - 1];
          return (
            <Fragment key={start}>
              {previous ? (
                <Gap selected={gapSelected(pieceEnd(previous), start)} />
              ) : null}
              {piece.kind === "muted" || carets.length === 0 ? null : (
                <Carets carets={carets} from={start} to={pieceEnd(piece)} />
              )}
              {renderPiece(piece)}
            </Fragment>
          );
        })}
      </p>
    </div>
  );
});

function SpeakerLabel({
  turn,
  interactive,
  actions,
}: {
  turn: ScriptTurn;
  interactive: boolean;
  actions: Actions;
}) {
  const content = (
    <>
      <PersonAvatar person={turn.speaker} size={20} />
      <span className="sys-script-name">{firstName(turn.speaker.name)}</span>
    </>
  );
  return interactive ? (
    <button
      type="button"
      className="sys-script-speaker"
      tabIndex={-1}
      data-margin="speaker"
      aria-label={`${turn.speaker.name}, change speaker`}
      ref={(el) => actions.registerMargin(turn.id, "speaker", el)}
      onKeyDown={(event) => actions.marginKey(event, turn.id, "speaker")}
      onClick={(event) => actions.speaker(turn.id, event.currentTarget)}
    >
      {content}
    </button>
  ) : (
    <span className="sys-script-speaker">{content}</span>
  );
}

type WordProps = {
  word: ScriptWord;
  selected: boolean;
  playing: boolean;
  tabbable: boolean;
  found: WordFound | undefined;
  actions: Actions;
};

const WordView = memo(function WordView({
  word,
  selected,
  playing,
  tabbable,
  found,
  actions,
}: WordProps) {
  const index = word.index;
  return (
    <button
      type="button"
      ref={(el) => actions.register(index, el)}
      className="sys-script-word"
      data-stop={index}
      data-state={word.mark?.kind === "suggested" ? undefined : word.mark?.kind}
      data-playing={playing ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-unsure={word.lowConfidence ? "" : undefined}
      data-restored={word.restored ? "" : undefined}
      data-found={found}
      tabIndex={tabbable ? 0 : -1}
      aria-label={wordLabel(word, { selected, found })}
      aria-current={playing ? "true" : undefined}
      onClick={(event) => actions.click(index, event.shiftKey)}
      onKeyDown={(event) => actions.key(event, index)}
    >
      {word.text}
    </button>
  );
});

const SeamView = memo(function SeamView({
  piece,
  selected,
  inSelection,
  tabbable,
  actions,
}: {
  piece: Extract<ScriptPiece, { kind: "cut" }>;
  selected: boolean;
  /** A run of words is selected across the pill: tinted, but not itself pressed. */
  inSelection: boolean;
  tabbable: boolean;
  actions: Actions;
}) {
  const { start, id } = piece;
  return (
    <span
      className="sys-script-pill"
      data-stop={start}
      data-in-selection={inSelection ? "" : undefined}
      ref={(el) => actions.register(start, el)}
    >
      <Seam
        form="pill"
        removed={piece.removed}
        words={piece.words}
        selected={selected}
        tabIndex={tabbable ? 0 : -1}
        onKeyDown={(event) => actions.key(event, start)}
        onSelect={() => actions.seam(id)}
      />
    </span>
  );
});

const RunView = memo(function RunView({
  piece,
  selected,
  playing,
  tabbable,
  actions,
}: {
  piece: Extract<ScriptPiece, { kind: "suggestion" }>;
  selected: boolean;
  playing: boolean;
  tabbable: boolean;
  actions: Actions;
}) {
  const { start, id } = piece;
  return (
    <button
      type="button"
      ref={(el) => actions.register(start, el)}
      className="sys-script-run"
      data-stop={start}
      data-selected={selected ? "" : undefined}
      data-playing={playing ? "" : undefined}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`Suggested cut: ${piece.text}`}
      aria-pressed={selected}
      aria-current={playing ? "true" : undefined}
      onKeyDown={(event) => actions.key(event, start)}
      onClick={() => actions.suggestion(id)}
    >
      <Suggestion segments={[{ text: piece.text, struck: true }]} />
    </button>
  );
});

const Gap = memo(function Gap({ selected }: { selected: boolean }) {
  return (
    <span className="sys-script-gap" data-selected={selected ? "" : undefined}>
      {" "}
    </span>
  );
});

const Carets = memo(function Carets({
  carets,
  from,
  to,
}: {
  carets: readonly ScriptCaret[];
  from: number;
  to: number;
}) {
  return carets
    .filter((caret) => caret.before >= from && caret.before <= to)
    .map((caret, at) => (
      <span
        key={`${caret.person?.name ?? "own"}-${at}`}
        className="sys-script-caret"
        data-own={caret.person ? undefined : ""}
        style={
          caret.person
            ? ({
                "--sys-person-color": presenceColorVar(caret.person.colorIndex),
              } as CSSProperties)
            : undefined
        }
        aria-hidden={caret.person ? undefined : "true"}
      >
        {caret.person ? (
          <span className="sr-only">{caret.person.name}'s cursor</span>
        ) : null}
      </span>
    ));
});
