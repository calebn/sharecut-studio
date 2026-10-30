import {
  type CSSProperties,
  Fragment,
  forwardRef,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useUserScrollIntent } from "../hooks/useUserScrollIntent";
import { presenceColorVar } from "../presence/colors";
import { useResizeObserver } from "../ui/useResizeObserver";
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
  type FixTextVia,
  isDoubleTap,
  type ScriptGesture,
  type ScriptGestureEnd,
} from "./scriptGesture";
import {
  continuesSpeaker,
  linkCuts,
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
  extendTo,
  type HandleEdge,
  horizontalStep,
  isLeftKey,
  isNavKey,
  isVerticalKey,
  type MarginControl,
  marginStep,
  navigate,
  nearestStop,
  type StopRects,
  selectionSummary,
  selectionText,
  spanOf,
  stepEdge,
} from "./scriptSelection";
import { type GestureControl, useScriptGestures } from "./useScriptGestures";

function scrollWithin(
  body: HTMLElement,
  el: HTMLElement,
  block: ScrollLogicalPosition,
) {
  const box = body.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const top = rect.top - box.top + body.scrollTop;
  const bottom = top + rect.height;
  const view = body.clientHeight;
  const from = body.scrollTop;
  let to = from;
  if (block === "center") to = top - (view - rect.height) / 2;
  else if (block === "start") to = top;
  else if (block === "end") to = bottom - view;
  else if (top < from) to = top;
  else if (bottom > from + view) to = bottom - view;
  if (to !== from) body.scrollTop = Math.max(0, to);
}

export type ScriptPaneHandle = {
  /** Scroll the word into view. False when the pane does not show it, so the host should widen its window of turns. */
  scrollToWord: (index: number, block?: ScrollLogicalPosition) => boolean;
  /** Put focus on the header's Find button, where the Find bar's focus goes when it closes or finishes a bulk verb. False when the pane draws no such button. */
  focusFind: () => boolean;
  /** Put focus on the word's stop, where Fix text hands it back when it closes. False when the pane does not show the word. */
  focusWord: (index: number) => boolean;
};

/**
 * Every callback is optional. A pane without them reads, and a header control
 * whose callback is missing is not drawn, which is how a guest's pane is made.
 *
 * The pane draws the turns it is given and keeps nothing about the rest of the
 * episode, so a host that virtualizes passes a window of turns whose word
 * indices are the episode's. Keyboard moves stop at the window's edge; the
 * host widens the window and uses `scrollToWord` to land on a word.
 *
 * Keys. The pane owns the keys it handles on its words, cut pills, suggested
 * runs and margin controls: the arrows, Home and End (alone, with Shift, and
 * Alt+Shift+Left or Right), Enter, F2 on a word when `onFixText` is given, and
 * Esc when something is selected and `onClearSelection` is given, or while a
 * drag runs. It calls `preventDefault()` and `stopPropagation()` on them, so
 * the window keymap never sees them: no playhead nudge on an arrow, no Home to
 * the start, no second Esc. Every other key, typing included, and any chord
 * with Ctrl or Cmd, reaches the keymap untouched. The host must not rebind a
 * key in that list for a script-focused context; when the list changes, the
 * keymap rows stay as they are.
 *
 * Pointer gestures (design-system element 14, `useScriptGestures`). The body
 * owns the browser's text selection (off) and the pointer: a mouse drag, a
 * touch long press then drag, Shift-click, a click that selects a word and a
 * double-click or double-tap that asks for Fix text. They need `onSelect`.
 *
 * Live region. The pane has the one polite region of the script. It says the
 * selection when it changes (once, on release, while a grip is dragged),
 * says "Selection cleared" when it clears, and speaks `findStatus`.
 */
export type ScriptPaneProps = {
  turns: readonly ScriptTurn[];
  status?: ScriptStatus;
  /** `phone` reads at 17/28 instead of 16/26. */
  layout?: "desktop" | "phone";
  /** The words under the playhead. Two tracks can speak at once. */
  playing?: number | readonly number[];
  playheadWord?: number;
  selection?: ScriptSelection | null;
  carets?: readonly ScriptCaret[];
  /** Find hits, by word span, and which one is current. */
  matches?: readonly ScriptSpan[];
  currentMatch?: number;
  /** What the pane's live region says about the search: the Find bar's count, for example "3 of 12" or "No matches". */
  findStatus?: string;
  /**
   * Fix text: the words in this span give way to `renderEditor`'s field. A
   * span that crosses turns gets one field, drawn in the first turn it
   * touches and given the whole span the field replaces; the later turns
   * show nothing there.
   */
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
  /**
   * The selection changed and is settled: a click, Shift with a key or a click,
   * a grip, or a drag or long press let go. The one callback a host writes the
   * store from. A drag cancelled by Esc calls nothing here.
   */
  onSelect?: (selection: WordsSelection) => void;
  /**
   * A mouse or pen drag has moved past its slop, or a touch has held for the
   * long-press time, from word `anchor` (a window index). Return `false` to
   * refuse it. The pane draws the selection itself while the gesture runs and
   * the `selection` prop stays as it was, so a refused or cancelled gesture
   * needs no undoing.
   */
  onSelectionStart?: (
    anchor: number,
    gesture: ScriptGesture,
  ) => boolean | undefined;
  /** The head moved to another place: a preview, never a store write. */
  onSelectionChange?: (
    anchor: number,
    head: number,
    gesture: ScriptGesture,
  ) => void;
  /**
   * The gesture is over. `committed` is false when Esc, a lost or cancelled
   * pointer, a second finger, a blur or unmounting ended it; true on release,
   * and `onSelect` follows with the same selection.
   */
  onSelectionEnd?: (
    anchor: number,
    head: number,
    gesture: ScriptGestureEnd,
  ) => void;
  /**
   * Fix text was asked for on `span`: Enter or F2 on a selected word, or a
   * double-click or double-tap on a word. Typing never asks. Without this
   * callback Enter on a selected word runs `onPrimary` and F2 reaches the
   * keymap.
   */
  onFixText?: (span: ScriptSpan, via: FixTextVia) => void;
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
  turns: readonly ScriptTurn[];
  showCutText: boolean;
  props: Pick<
    ScriptPaneProps,
    | "onCaret"
    | "onSelect"
    | "onSelectionStart"
    | "onSelectionChange"
    | "onSelectionEnd"
    | "onFixText"
    | "onUserScroll"
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
  click: (index: number, event: { shiftKey: boolean; detail: number }) => void;
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

/** The lines a place occupies, measured into the body's own scrolling space so a scroll does not stale them. */
const fragmentsOf = (
  el: HTMLElement | undefined,
  dx: number,
  dy: number,
): StopRects | null => {
  if (!el) return null;
  const list = Array.from(el.getClientRects());
  const lines = list.length > 0 ? list : [el.getBoundingClientRect()];
  return lines.map((r) => ({
    top: r.top + dy,
    bottom: r.bottom + dy,
    left: r.left + dx,
    right: r.right + dx,
  }));
};

/** Every place's lines, in the body's scrolling space. */
type Measured = (StopRects | null)[];

/** A handled key stops here: the window keymap must not also act on it. */
const handled = (event: KeyboardEvent<HTMLElement>) => {
  event.preventDefault();
  event.stopPropagation();
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
  const rtl = (el: HTMLElement) => getComputedStyle(el).direction === "rtl";
  return {
    start: at(first, rtl(startEl) ? first.right : first.left),
    end: at(last, rtl(endEl) ? last.left : last.right),
  };
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
      playheadWord,
      selection: selectionHost = null,
      carets = NO_CARETS,
      matches = NO_MATCHES,
      currentMatch,
      findStatus,
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
      onSelectionStart,
      onSelectionChange,
      onSelectionEnd,
      onFixText,
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
    const findButton = useRef<HTMLButtonElement>(null);
    const layoutCache = useRef<Measured | null>(null);
    const [dragging, setDragging] = useState(false);
    const [spoken, setSpoken] = useState("");
    const hadSelection = useRef(false);
    const lastTap = useRef<{ index: number; at: number } | null>(null);
    /** The selection a pointer gesture is making; it stands in for the prop until the gesture ends. */
    const [draft, setDraft] = useState<WordsSelection | null>(null);

    const selectionProp = draft ?? selectionHost;
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
      () => linkCuts(turns.map((turn) => piecesOf(turn.words, showCutText))),
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
    const { editTurn, editSlot } = useMemo(() => {
      const slots = piecesByTurn.flatMap((pieces, turn) =>
        pieces.flatMap((piece) =>
          piece.kind === "editing"
            ? [{ turn, start: piece.start, end: piece.end }]
            : [],
        ),
      );
      return {
        editTurn: slots[0]?.turn ?? -1,
        editSlot:
          slots.length > 0
            ? { start: slots[0].start, end: slots[slots.length - 1].end }
            : null,
      };
    }, [piecesByTurn]);
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
      turns,
      showCutText,
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
        turns,
        showCutText,
        props: {
          onCaret,
          onSelect,
          onSelectionStart,
          onSelectionChange,
          onSelectionEnd,
          onFixText,
          onUserScroll,
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

    const measure = useCallback((): Measured => {
      if (layoutCache.current) return layoutCache.current;
      const body = bodyRef.current;
      const origin = body?.getBoundingClientRect();
      const dx = origin && body ? body.scrollLeft - origin.left : 0;
      const dy = origin && body ? body.scrollTop - origin.top : 0;
      const rects = live.current.stops.map((stop) =>
        fragmentsOf(registry.current.get(stop.start), dx, dy),
      );
      layoutCache.current = rects;
      return rects;
    }, []);

    const focusStop = useCallback((start: number, preventScroll = false) => {
      setFocused(start);
      focusable(registry.current.get(start))?.focus({ preventScroll });
    }, []);

    const control = useMemo<GestureControl>(
      () => ({
        wordAt: (target) => {
          const el = target.closest<HTMLElement>("[data-stop]");
          if (!el || !bodyRef.current?.contains(el)) return null;
          const now = live.current;
          const at = now.stopPos.get(Number(el.dataset.stop));
          return at !== undefined && now.stops[at].kind === "word"
            ? now.stops[at].start
            : null;
        },
        stopAt: (x, y) => {
          const body = bodyRef.current;
          if (!body) return null;
          const now = live.current;
          const hit = document
            .elementFromPoint?.(x, y)
            ?.closest<HTMLElement>("[data-stop]");
          if (hit && body.contains(hit)) {
            const at = now.stopPos.get(Number(hit.dataset.stop));
            if (at !== undefined) return now.stops[at];
          }
          const origin = body.getBoundingClientRect();
          const at = nearestStop(
            measure(),
            x - origin.left + body.scrollLeft,
            y - origin.top + body.scrollTop,
          );
          return at === null ? null : (now.stops[at] ?? null);
        },
        anchorFor: (index, shift) => {
          const now = live.current;
          if (!shift) return index;
          return now.selection?.kind === "words"
            ? now.selection.anchor
            : (now.ownCaret ?? caretRef.current ?? index);
        },
        start: (anchor, gesture) =>
          live.current.props.onSelectionStart?.(anchor, gesture) !== false,
        draft: (next) =>
          setDraft((prev) =>
            prev?.anchor === next?.anchor && prev?.head === next?.head
              ? prev
              : next,
          ),
        change: (anchor, head, gesture) =>
          live.current.props.onSelectionChange?.(anchor, head, gesture),
        end: (anchor, head, gesture, committed) => {
          setDraft(null);
          const now = live.current;
          now.props.onSelectionEnd?.(anchor, head, { ...gesture, committed });
          if (!committed) return;
          goalX.current = null;
          caretRef.current = anchor;
          const reached = stopContaining(now.stops, head);
          if (reached) focusStop(reached.start, true);
          now.props.onSelect?.({ kind: "words", anchor, head });
        },
        scrolled: () => live.current.props.onUserScroll?.(),
      }),
      [measure, focusStop],
    );
    const gestures = useScriptGestures(
      bodyRef,
      onSelect !== undefined &&
        status.kind !== "empty" &&
        status.kind !== "loading",
      control,
    );

    const actions = useMemo<Actions>(() => {
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
          handled(event);
          if (move.kind === "control") marginAtTop(turnId, move.at);
          else if (move.kind === "text") focusStop(entry.first);
          else if (entry.before !== undefined) focusStop(entry.before);
        },
        click: (index, event) => {
          if (gestures.consumeClick()) return;
          const shift = event.shiftKey;
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
          now.props.onSelect?.({ kind: "words", anchor: index, head: index });
          const at = Date.now();
          const touch = gestures.lastKind.current === "touch";
          const double = touch
            ? isDoubleTap(lastTap.current, index, at)
            : event.detail === 2;
          lastTap.current = double ? null : { index, at };
          if (double) {
            now.props.onFixText?.(
              { start: index, end: index },
              touch ? "double-tap" : "double-click",
            );
          }
        },
        key: (event, start) => {
          if (event.ctrlKey || event.metaKey) return;
          const now = live.current;
          if (event.altKey) {
            const step = event.shiftKey ? horizontalStep(event.key) : null;
            if (step === null) return;
            handled(event);
            const next = stepEdge(now.stops, now.selection, "start", step);
            if (next) now.props.onSelect?.(next);
            return;
          }
          if (event.key === "Escape") {
            if (!now.selection || !now.props.onClearSelection) return;
            handled(event);
            now.props.onClearSelection();
            return;
          }
          if (event.key === "F2" && !event.shiftKey) {
            if (!now.props.onFixText) return;
            if (stopContaining(now.stops, start)?.kind !== "word") return;
            handled(event);
            const selected = spanOf(now.selection);
            if (selected && within(selected, start)) {
              now.props.onFixText(selected, "f2");
              return;
            }
            caretRef.current = start;
            now.props.onSelect?.({ kind: "words", anchor: start, head: start });
            now.props.onFixText({ start, end: start }, "f2");
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            if (stopContaining(now.stops, start)?.kind !== "word") return;
            handled(event);
            const selected = spanOf(now.selection);
            if (selected && within(selected, start)) {
              if (now.props.onFixText) now.props.onFixText(selected, "enter");
              else now.props.onPrimary?.();
              return;
            }
            caretRef.current = start;
            now.props.onSelect?.({ kind: "words", anchor: start, head: start });
            now.props.onSeek?.(start);
            return;
          }
          if (!isNavKey(event.key)) return;
          handled(event);
          const at = now.stopPos.get(start);
          if (at === undefined) return;
          const turnId = now.marginAt.get(start);
          if (turnId && isLeftKey(event.key) && !event.shiftKey) {
            marginAtTop(turnId, 0);
            return;
          }
          const vertical = isVerticalKey(event.key)
            ? (() => {
                const rects = measure();
                const lines = rects[at];
                const here =
                  event.key === "ArrowDown" ? lines?.at(-1) : lines?.[0];
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
    }, [measure, focusStop, gestures]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToWord: (index, block = "nearest") => {
          const stop = stopContaining(live.current.stops, index);
          const el = stop ? registry.current.get(stop.start) : undefined;
          const body = bodyRef.current;
          if (el && body) scrollWithin(body, el, block);
          return el !== undefined;
        },
        focusFind: () => {
          findButton.current?.focus();
          return findButton.current !== null;
        },
        focusWord: (index) => {
          const stop = stopContaining(live.current.stops, index);
          const el = stop ? focusable(registry.current.get(stop.start)) : null;
          el?.focus();
          return el != null;
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

    // Places are measured once per layout, not once per key or pointer move.
    // biome-ignore lint/correctness/useExhaustiveDependencies: these change what the body lays out
    useLayoutEffect(() => {
      layoutCache.current = null;
    }, [piecesByTurn, layout, carets, bodyShown]);
    const stale = useCallback(() => {
      layoutCache.current = null;
    }, []);
    useResizeObserver(bodyRef, stale, bodyShown);
    useEffect(() => {
      document.fonts?.addEventListener("loadingdone", stale);
      return () => document.fonts?.removeEventListener("loadingdone", stale);
    }, [stale]);

    const selecting = draft !== null;
    useEffect(() => {
      if (dragging || selecting) return;
      if (summary !== "") {
        hadSelection.current = true;
        setSpoken(summary);
      } else if (hadSelection.current) {
        hadSelection.current = false;
        setSpoken("Selection cleared");
      }
    }, [summary, dragging, selecting]);
    useEffect(() => {
      if (findStatus) setSpoken(findStatus);
    }, [findStatus]);

    const handlesShown =
      handles &&
      onSelect !== undefined &&
      span !== null &&
      bodyShown &&
      !selecting;
    // The grips can go while one is held (the selection is lost), and then no release comes.
    useEffect(() => {
      if (!handlesShown) setDragging(false);
    }, [handlesShown]);
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
    const replaceHandles = useCallback(() => {
      if (startAt === undefined || endAt === undefined) return;
      const next = placeHandles(
        bodyRef.current,
        registry.current.get(startAt),
        registry.current.get(endAt),
      );
      setPlaces((prev) => (samePlace(prev, next) ? prev : next));
    }, [startAt, endAt]);
    useResizeObserver(bodyRef, replaceHandles, handlesShown);
    useEffect(() => {
      if (!handlesShown) return;
      document.fonts?.addEventListener("loadingdone", replaceHandles);
      return () =>
        document.fonts?.removeEventListener("loadingdone", replaceHandles);
    }, [handlesShown, replaceHandles]);

    const dragHandle = (edge: HandleEdge, point: { x: number; y: number }) => {
      const now = live.current;
      const body = bodyRef.current;
      if (!body) return;
      const origin = body.getBoundingClientRect();
      const at = nearestStop(
        measure(),
        point.x - origin.left + body.scrollLeft,
        point.y - origin.top + body.scrollTop,
      );
      if (at === null) return;
      const next = dragEdge(now.stops, now.selection, edge, now.stops[at]);
      if (next) now.props.onSelect?.(next);
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
                  ref={findButton}
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
            data-selecting={selecting ? "" : undefined}
            ref={bodyRef}
            onCopy={(event) => {
              const text = selectionText(
                live.current.turns,
                live.current.selection,
                live.current.showCutText,
              );
              if (text === "") return;
              event.clipboardData.setData("text/plain", text);
              event.preventDefault();
            }}
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
                    turnIndex === editTurn ? renderEditor : undefined
                  }
                  editSlot={turnIndex === editTurn ? editSlot : null}
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
                onDrag={dragHandle}
                onGrab={() => setDragging(true)}
                onRelease={() => setDragging(false)}
              />
            ) : null}
          </div>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {spoken}
        </div>
        {!following &&
        (playingList.length > 0 || playheadWord !== undefined) &&
        onBackToPlayhead ? (
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
  editSlot: ScriptSpan | null;
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
  editSlot,
  canSeekTurn,
  canSpeaker,
  actions,
}: TurnProps) {
  const foundWords = useMemo(() => {
    const byWord = new Map<number, WordFound>();
    for (const hit of found) {
      for (let index = hit.start; index <= hit.end; index += 1) {
        if (!byWord.has(index))
          byWord.set(index, hit.current ? "current" : "match");
      }
    }
    return byWord;
  }, [found]);
  const foundAt = (index: number) => foundWords.get(index);
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
        return renderEditor && editSlot ? (
          <span className="sys-script-editor">{renderEditor(editSlot)}</span>
        ) : null;
    }
  }

  return (
    <div
      role="group"
      className="sys-script-turn"
      data-turn-id={turn.id}
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
      <p className="sys-script-text" dir="auto">
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
      data-word-key={word.key}
      data-state={word.mark?.kind === "suggested" ? undefined : word.mark?.kind}
      data-playing={playing ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-unsure={word.lowConfidence ? "" : undefined}
      data-restored={word.restored ? "" : undefined}
      data-found={found}
      tabIndex={tabbable ? 0 : -1}
      aria-label={wordLabel(word, { selected, found })}
      aria-current={playing ? "true" : undefined}
      onClick={(event) => actions.click(index, event)}
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
        continued={piece.continued}
        continues={piece.continues}
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
