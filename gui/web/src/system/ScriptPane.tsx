import {
  type CSSProperties,
  Fragment,
  forwardRef,
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isScrollKey,
  USER_SCROLL_INTENT_MS,
  useUserScrollIntent,
} from "../hooks/useUserScrollIntent";
import { presenceAnchorProps } from "../presence/anchors";
import { presenceColorVar } from "../presence/colors";
import {
  TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
  TRANSCRIPT_SUSPECT_HALLUCINATION_TIP,
} from "../transcript/transcriptModeCopy";
import { useResizeObserver } from "../ui/useResizeObserver";
import type { CoachHint } from "./CoachTip";
import { CoachTipBubble } from "./CoachTipBubble";
import { Cover } from "./Cover";
import { placeHandleHint } from "./handleHintPlace";
import { PersonAvatar } from "./Person";
import { percentOf } from "./progress";
import { Seam, type SeamRoll } from "./Seam";
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
  type FindHit,
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
  sentenceSpan,
  spanOf,
  stepEdge,
} from "./scriptSelection";
import { type GestureControl, useScriptGestures } from "./useScriptGestures";

type ReadingDirection = "up" | "down";
type ReadingReference = Readonly<{
  element: HTMLElement;
  top: number;
  height: number;
}>;
type ReadingSample = Readonly<{
  top: number;
  maximum: number;
  width: number;
  height: number;
  observedAt: number;
  reference: ReadingReference | null;
}>;
type ReadingEvidence = Readonly<{
  sourceAt: number;
  observedAt: number;
  kind: "pending" | "moving";
}>;
type ReadingDirections = Record<ReadingDirection, ReadingEvidence | null>;
type ReadingContact = Readonly<{
  identifier: number;
  previousY: number;
  evidence: ReadingDirections;
}>;
type ReadingScrollOwnership = Readonly<{
  physical: ReadingSample | null;
  sources: Record<"wheel" | "key" | "endedTouch", ReadingDirections>;
  touch: ReadingContact | null;
  scrollbar: { pointerId: number | null; evidence: ReadingDirections };
}>;
type ReadingInput =
  | { kind: "direction"; source: "wheel" | "key"; direction: ReadingDirection }
  | { kind: "reject-wheel" }
  | { kind: "touch-start"; identifier: number; y: number }
  | { kind: "touch-move"; identifier: number; y: number; blocked: boolean }
  | { kind: "touch-end"; identifier: number }
  | { kind: "touch-cancel" }
  | { kind: "scrollbar-start"; pointerId: number }
  | { kind: "scrollbar-end" | "scrollbar-cancel"; pointerId: number }
  | { kind: "none" };
type ReadingBoundary =
  | { kind: "input"; input: ReadingInput }
  | { kind: "scroll" | "geometry" };
const NO_READING_EVIDENCE: ReadingDirections = { up: null, down: null };
const EMPTY_READING_OWNERSHIP: ReadingScrollOwnership = {
  physical: null,
  sources: {
    wheel: NO_READING_EVIDENCE,
    key: NO_READING_EVIDENCE,
    endedTouch: NO_READING_EVIDENCE,
  },
  touch: null,
  scrollbar: { pointerId: null, evidence: NO_READING_EVIDENCE },
};

function sampleReadingViewport(
  body: HTMLElement,
  anchor: HTMLElement | undefined,
): ReadingSample {
  const bounds = body.getBoundingClientRect();
  const word = anchor && body.contains(anchor) ? anchor : null;
  const rect = word?.getBoundingClientRect();
  return {
    top: body.scrollTop,
    maximum: Math.max(0, body.scrollHeight - body.clientHeight),
    width: bounds.width,
    height: bounds.height,
    observedAt: performance.now(),
    reference:
      word && rect
        ? {
            element: word,
            top: rect.top - bounds.top + body.scrollTop,
            height: rect.height,
          }
        : null,
  };
}

function acceptReadingPosition(
  state: ReadingScrollOwnership,
  physical: ReadingSample,
): ReadingScrollOwnership {
  return {
    ...EMPTY_READING_OWNERSHIP,
    physical,
    touch: state.touch
      ? { ...state.touch, evidence: NO_READING_EVIDENCE }
      : null,
    scrollbar: { ...state.scrollbar, evidence: NO_READING_EVIDENCE },
  };
}

function advanceReading(
  state: ReadingScrollOwnership,
  boundary: ReadingBoundary,
  sample: ReadingSample,
  restore: boolean,
): { state: ReadingScrollOwnership; effect: "capture" | "restore" | "none" } {
  const previous = state.physical;
  const referencePair =
    previous?.reference &&
    sample.reference &&
    previous.reference.element === sample.reference.element
      ? { previous: previous.reference, current: sample.reference }
      : null;
  const referenceShift = referencePair
    ? referencePair.current.top - referencePair.previous.top
    : 0;
  const contentChanged = Boolean(
    previous &&
      (referencePair
        ? referenceShift !== 0 ||
          referencePair.previous.height !== referencePair.current.height
        : previous.reference ||
          sample.reference ||
          previous.width !== sample.width ||
          previous.height !== sample.height ||
          previous.maximum !== sample.maximum),
  );
  const fresh = (evidence: ReadingEvidence | null) =>
    evidence &&
    sample.observedAt -
      (evidence.kind === "pending" ? evidence.sourceAt : evidence.observedAt) <
      USER_SCROLL_INTENT_MS
      ? evidence
      : null;
  const expire = (evidence: ReadingDirections): ReadingDirections => ({
    up: fresh(evidence.up),
    down: fresh(evidence.down),
  });
  const sources = {
    wheel: expire(state.sources.wheel),
    key: expire(state.sources.key),
    endedTouch: expire(state.sources.endedTouch),
  };
  let touch = state.touch
    ? { ...state.touch, evidence: expire(state.touch.evidence) }
    : null;
  let scrollbar = {
    ...state.scrollbar,
    evidence: expire(state.scrollbar.evidence),
  };
  const projected = previous
    ? Math.min(sample.maximum, Math.max(0, previous.top + referenceShift))
    : sample.top;
  const input =
    boundary.kind === "input" ? boundary.input : { kind: "none" as const };
  const touchDelta =
    input.kind === "touch-move" &&
    !input.blocked &&
    touch?.identifier === input.identifier
      ? touch.previousY - input.y
      : 0;
  const inputDirection =
    input.kind === "direction"
      ? input.direction
      : touchDelta < 0
        ? "up"
        : touchDelta > 0
          ? "down"
          : null;
  const passiveTop = previous
    ? Math.min(sample.maximum, Math.max(0, previous.top))
    : sample.top;
  const physicalDirection =
    sample.top === previous?.top
      ? null
      : sample.top < passiveTop
        ? "up"
        : sample.top > passiveTop
          ? "down"
          : null;
  const direction =
    physicalDirection === null
      ? null
      : inputDirection !== null &&
          inputDirection === physicalDirection &&
          sample.top !== projected
        ? inputDirection
        : sample.top === previous?.top
          ? null
          : sample.top < projected
            ? "up"
            : sample.top > projected
              ? "down"
              : null;
  const admit = (evidence: ReadingDirections, toward: ReadingDirection) => {
    if (
      direction === toward ||
      (toward === "up" ? sample.top > 0 : sample.top < sample.maximum)
    ) {
      evidence[toward] = {
        kind: "pending",
        sourceAt: sample.observedAt,
        observedAt: sample.observedAt,
      };
    }
  };
  const releasedScrollbar =
    !contentChanged &&
    input.kind === "scrollbar-end" &&
    input.pointerId === scrollbar.pointerId;
  switch (input.kind) {
    case "direction":
      admit(sources[input.source], input.direction);
      break;
    case "reject-wheel":
      for (const toward of ["up", "down"] as const)
        if (sources.wheel[toward]?.kind === "moving")
          sources.wheel[toward] = null;
      break;
    case "touch-start":
      touch = {
        identifier: input.identifier,
        previousY: input.y,
        evidence: { ...NO_READING_EVIDENCE },
      };
      break;
    case "touch-move":
      if (!touch || touch.identifier !== input.identifier) {
        touch = null;
      } else {
        const delta = touch.previousY - input.y;
        touch.previousY = input.y;
        if (input.blocked) touch.evidence = { ...NO_READING_EVIDENCE };
        else if (delta !== 0) admit(touch.evidence, delta < 0 ? "up" : "down");
      }
      break;
    case "touch-end":
      if (touch?.identifier === input.identifier) {
        for (const toward of ["up", "down"] as const) {
          const evidence = touch.evidence[toward];
          if (evidence) sources.endedTouch[toward] = evidence;
        }
      }
      touch = null;
      break;
    case "touch-cancel":
      touch = null;
      break;
    case "scrollbar-start":
      scrollbar = {
        pointerId: input.pointerId,
        evidence: { ...NO_READING_EVIDENCE },
      };
      admit(scrollbar.evidence, "up");
      admit(scrollbar.evidence, "down");
      break;
    case "scrollbar-end":
    case "scrollbar-cancel":
      if (scrollbar.pointerId === input.pointerId) {
        scrollbar.pointerId = null;
        if (input.kind === "scrollbar-cancel")
          scrollbar.evidence = { ...NO_READING_EVIDENCE };
        else
          for (const toward of ["up", "down"] as const)
            if (scrollbar.evidence[toward]?.kind === "pending")
              scrollbar.evidence[toward] = null;
      }
      break;
    case "none":
      break;
    default:
      return input satisfies never;
  }
  const evidence = [
    ...Object.values(sources),
    contentChanged ? NO_READING_EVIDENCE : scrollbar.evidence,
    ...(touch ? [touch.evidence] : []),
  ];
  const scrollbarActive = !contentChanged && scrollbar.pointerId !== null;
  const supported =
    direction !== null &&
    (evidence.some((facts) => {
      const fact = facts[direction];
      return fact && (fact.kind === "pending" || !contentChanged);
    }) ||
      scrollbarActive ||
      releasedScrollbar);
  if (direction) {
    for (const facts of evidence) {
      for (const toward of ["up", "down"] as const) {
        const fact = facts[toward];
        if (!fact || (contentChanged && fact.kind === "moving")) continue;
        if (toward === direction && supported)
          facts[toward] = {
            ...fact,
            kind: "moving",
            observedAt: sample.observedAt,
          };
        else if (fact.kind === "moving") facts[toward] = null;
      }
    }
    if (supported && scrollbarActive && !scrollbar.evidence[direction])
      scrollbar.evidence[direction] = {
        kind: "moving",
        sourceAt: sample.observedAt,
        observedAt: sample.observedAt,
      };
  }
  const geometry =
    boundary.kind === "geometry" ||
    contentChanged ||
    Boolean(
      previous &&
        (previous.width !== sample.width ||
          previous.height !== sample.height ||
          (previous.top !== sample.top && sample.top === projected)),
    );
  return {
    state: {
      physical: sample,
      sources,
      touch,
      scrollbar,
    },
    effect: supported ? "capture" : restore && geometry ? "restore" : "none",
  };
}

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

function clipsOverflow(overflow: string) {
  return /^(auto|scroll|hidden|clip|overlay)$/.test(overflow);
}

function readingObservationTargets(body: HTMLElement): Element[] {
  const targets: Element[] = [body];
  for (let owner = body.parentElement; owner; owner = owner.parentElement) {
    const style = getComputedStyle(owner);
    if (clipsOverflow(style.overflowX) || clipsOverflow(style.overflowY))
      targets.push(owner);
  }
  return targets;
}

function elementClipped(element: HTMLElement, includeViewport: boolean) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const ring =
    style.outlineStyle === "none"
      ? 0
      : Math.max(
          0,
          (Number.parseFloat(style.outlineWidth) || 0) +
            (Number.parseFloat(style.outlineOffset) || 0),
        );
  let top = includeViewport ? 0 : Number.NEGATIVE_INFINITY;
  let left = includeViewport ? 0 : Number.NEGATIVE_INFINITY;
  let bottom = includeViewport ? window.innerHeight : Number.POSITIVE_INFINITY;
  let right = includeViewport ? window.innerWidth : Number.POSITIVE_INFINITY;
  for (let owner = element.parentElement; owner; owner = owner.parentElement) {
    const overflow = getComputedStyle(owner);
    const clipsY = clipsOverflow(overflow.overflowY);
    const clipsX = clipsOverflow(overflow.overflowX);
    if (!clipsX && !clipsY) continue;
    const box = owner.getBoundingClientRect();
    if (clipsY) {
      const edge = box.top + owner.clientTop;
      top = Math.max(top, edge);
      bottom = Math.min(bottom, edge + owner.clientHeight);
    }
    if (clipsX) {
      const edge = box.left + owner.clientLeft;
      left = Math.max(left, edge);
      right = Math.min(right, edge + owner.clientWidth);
    }
  }
  return (
    rect.top - ring < top - 0.5 ||
    rect.bottom + ring > bottom + 0.5 ||
    rect.left - ring < left - 0.5 ||
    rect.right + ring > right + 0.5
  );
}

export type ScriptPaneHandle = {
  /** Scroll the word into view. False when the pane does not show it, so the host should widen its window of turns. */
  scrollToWord: (index: number, block?: ScrollLogicalPosition) => boolean;
  /** Put focus on the header's Find button, where the Find bar's focus goes when it closes or finishes a bulk verb. False when the pane draws no such button. */
  focusFind: () => boolean;
  /** Put focus on the word's stop, where Fix text hands it back when it closes. False when the pane does not show the word. */
  focusWord: (index: number) => boolean;
};

export type ScriptPaneReadingPosition =
  | {
      kind: "word";
      index: number;
      offset: number;
      fallbackTop: number;
      /** Only explicit focus captures may reveal a still-focused word; omission preserves manual reading. */
      intent?: "focus";
      /** Captured ordinals are valid only in this immutable transcript snapshot. */
      turns?: readonly ScriptTurn[];
    }
  | { kind: "scroll"; top: number };

export type ScriptPaneReadingPositionBinding = {
  getPosition: () => ScriptPaneReadingPosition | null;
  capture: (position: ScriptPaneReadingPosition) => void;
  restore: boolean;
};

export type ScriptGuest = "viewer" | "commenter" | "suggester";

const GUEST_SCRIPT_LABEL: Record<ScriptGuest, string> = {
  viewer: "Read only",
  commenter: "Read only · you can comment",
  suggester: "You can comment and suggest edits",
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
 * touch long press then drag, Shift-click, a click that selects a word, a
 * triple-click that selects its sentence and a double-tap that asks for
 * Fix text. They need `onSelect`.
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
  /** Find hits, by their word indices, and which one is current. */
  matches?: readonly FindHit[];
  currentMatch?: number;
  /** What the pane's live region says about the search: the Find bar's count, for example "3 of 12" or "No matches". */
  findStatus?: string;
  /** Changes when the user steps to a match, so identical status text ("1 of 1") is spoken again. */
  findStatusKey?: number;
  /**
   * Fix text: the words in this span give way to `renderEditor`'s field. A
   * span that crosses turns gets one field, drawn in the first turn it
   * touches and given the whole span the field replaces; the later turns
   * show nothing there.
   */
  editing?: ScriptSpan | null;
  renderEditor?: (span: ScriptSpan) => ReactNode;
  /**
   * Rolls a cut's seam from its pill: drag either edge, or Alt with an arrow
   * key. `limits` is null for a cut whose clips do not abut. `id` is the cut's id.
   */
  seamRoll?: {
    limits: (id: string) => { minMs: number; maxMs: number } | null;
    commit: (id: string, deltaMs: number) => void;
  };
  /** Cut words show struck instead of collapsing into a pill. */
  showCutText?: boolean;
  /** The pane scrolls with the playhead. Off, "Back to playhead" shows. */
  following?: boolean;
  /** Optional reader location owned by the host across pane lifetimes. */
  readingPosition?: ScriptPaneReadingPositionBinding;
  /**
   * A bar between the header and the turns: the Find bar. The host opens it on
   * Mod+F or on `onFind` and keeps its own state; the pane only gives it room.
   */
  findBar?: ReactNode;
  /** Draw the two grips on a words selection. On whenever `onSelect` is given. */
  handles?: boolean;
  /** The one-time tip beside the end grip. Drawn only while the grips are. */
  handleHint?: CoachHint;
  /** Names what the guest's link may do in the header. It gates nothing: the callbacks do. */
  guest?: ScriptGuest;
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
   * double-tap on a word. Typing never asks. Without this
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
  /** Jump back to the previous unsure word (Alt+Up on a word; Alt+Down goes to the next). */
  onPreviousUnsure?: () => void;
  onShowCutTextChange?: (show: boolean) => void;
  onFollowChange?: (follow: boolean) => void;
  onBackToPlayhead?: () => void;
  /** The reader scrolled by hand: wheel, touch, scrollbar or paging key. The host turns follow off. */
  onUserScroll?: () => void;
};

type FoundHit = FindHit & { current: boolean };

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
    | "seamRoll"
    | "onSuggestionSelect"
    | "onSeekTurn"
    | "onSpeaker"
    | "onNextUnsure"
    | "onPreviousUnsure"
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
  roll: (id: string) => SeamRoll | undefined;
  suggestion: (id: string) => void;
  seekTurn: (turnId: string) => void;
  speaker: (turnId: string, anchor: HTMLElement) => void;
};

const NO_CARETS: readonly ScriptCaret[] = [];
const NO_NUMBERS: readonly number[] = [];
const NO_FOUND: readonly FoundHit[] = [];
const NO_MATCHES: readonly FindHit[] = [];
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

/**
 * Under the end grip's knob, above the start grip's, or pinned inside what is
 * on screen. It hangs off the pane, not inside the scrolling body, so a body
 * only a few lines tall (a landscape tablet) does not clip it. With no room
 * at all it frees the slot unseen, so it is neither shown nor used up.
 */
function HandleHint({
  hint,
  places,
  body,
}: {
  hint: CoachHint;
  places: HandlePlaces;
  body: RefObject<HTMLElement | null>;
}) {
  const bubble = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const { onRelease } = hint;
  const place = useCallback(() => {
    const el = body.current;
    const tip = bubble.current;
    const pane = el?.closest<HTMLElement>(".sys-script");
    if (!el || !tip || !pane) return;
    const rem = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    );
    const paneBox = pane.getBoundingClientRect();
    const bodyBox = el.getBoundingClientRect();
    // The grips in the pane's own space: the body's offset in, its scroll out.
    const dy = bodyBox.top - paneBox.top - el.scrollTop;
    const dx = bodyBox.left - paneBox.left - el.scrollLeft;
    const band = (b: { y: number; height: number }) => ({
      y: b.y + dy,
      height: b.height,
    });
    const top = placeHandleHint({
      start: band(places.start),
      end: band(places.end),
      view: {
        top: Math.max(0, -paneBox.top),
        height:
          Math.min(paneBox.bottom, window.innerHeight) -
          Math.max(paneBox.top, 0),
      },
      tipHeight: tip.offsetHeight,
      reach: 1.25 * rem,
      gap: 0.25 * rem,
    });
    if (top === null) {
      setAt(null);
      onRelease?.();
      return;
    }
    const left = Math.max(
      0,
      Math.min(places.end.x + dx, pane.clientWidth - tip.offsetWidth),
    );
    setAt((prev) =>
      prev && prev.top === top && prev.left === left ? prev : { top, left },
    );
  }, [places, body, onRelease]);
  useLayoutEffect(place, [place]);
  useEffect(() => {
    const el = body.current;
    el?.addEventListener("scroll", place, { passive: true });
    return () => el?.removeEventListener("scroll", place);
  }, [body, place]);
  return (
    <CoachTipBubble
      ref={bubble}
      className="sys-coach-tip--at"
      text={hint.text}
      onClose={hint.onDismiss}
      style={{
        insetInlineStart: "auto",
        left: `${at?.left ?? 0}px`,
        insetBlockStart: `${at?.top ?? 0}px`,
        visibility: at === null ? "hidden" : undefined,
      }}
    />
  );
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
      findStatusKey,
      editing,
      renderEditor,
      showCutText = false,
      following = true,
      readingPosition,
      findBar,
      handles = true,
      handleHint,
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
      seamRoll,
      onSuggestionSelect,
      onSeekTurn,
      onSpeaker,
      onFind,
      onNextUnsure,
      onPreviousUnsure,
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
    const { handlers: scrollHandlers, isUserScroll } = useUserScrollIntent();
    const readingOwnership = useRef<ReadingScrollOwnership>(
      EMPTY_READING_OWNERSHIP,
    );
    const attachBody = useCallback((body: HTMLDivElement | null) => {
      if (bodyRef.current !== body)
        readingOwnership.current = EMPTY_READING_OWNERSHIP;
      bodyRef.current = body;
    }, []);
    const readingPositionRef = useRef(readingPosition);
    const selectionViewport = useRef<"idle" | "active">("idle");
    const internalFocus = useRef(false);
    const focusInternally = useCallback(
      (element: HTMLElement | null | undefined, options?: FocusOptions) => {
        const previous = internalFocus.current;
        internalFocus.current = true;
        try {
          if (options) element?.focus(options);
          else element?.focus();
        } finally {
          internalFocus.current = previous;
        }
      },
      [],
    );
    useLayoutEffect(() => {
      const resumesFollowing =
        readingPositionRef.current?.restore && !readingPosition?.restore;
      readingPositionRef.current = readingPosition;
      if (!readingPosition) {
        readingOwnership.current = EMPTY_READING_OWNERSHIP;
      } else if (resumesFollowing) {
        const body = bodyRef.current;
        if (body?.isConnected)
          readingOwnership.current = acceptReadingPosition(
            readingOwnership.current,
            sampleReadingViewport(body, undefined),
          );
      }
    }, [readingPosition]);
    const findButton = useRef<HTMLButtonElement>(null);
    const layoutCache = useRef<Measured | null>(null);
    const [dragging, setDragging] = useState(false);
    /** The words a handle drag started from, put back by Esc. Null when the grip was taken with no words selected, or once Esc cancelled the drag; either way the rest of the drag is ignored. */
    const grabbed = useRef<WordsSelection | null>(null);
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
          (match, lo, hi) =>
            match.indices.some((index) => index >= lo && index <= hi),
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
      const saved = readingPosition?.restore
        ? readingPosition.getPosition()
        : null;
      if (
        saved?.kind === "word" &&
        saved.intent === "focus" &&
        (!saved.turns || saved.turns === turns) &&
        stopPos.has(saved.index)
      )
        return saved.index;
      return (
        stopContaining(stops, ownCaret)?.start ??
        stopContaining(stops, playingList[0])?.start ??
        stops[0]?.start ??
        -1
      );
    }, [
      focused,
      stopPos,
      stops,
      ownCaret,
      playingList,
      readingPosition,
      turns,
    ]);

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
          seamRoll,
          onSuggestionSelect,
          onSeekTurn,
          onSpeaker,
          onNextUnsure,
          onPreviousUnsure,
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

    const sampleReading = useCallback((body: HTMLElement) => {
      const position = readingPositionRef.current?.getPosition();
      const anchor =
        position?.kind === "word" &&
        (!position.turns || position.turns === live.current.turns)
          ? registry.current.get(position.index)
          : undefined;
      return sampleReadingViewport(body, anchor);
    }, []);

    const serializeReadingPosition = useCallback((preferredIndex?: number) => {
      const body = bodyRef.current;
      const binding = readingPositionRef.current;
      if (!body || !binding || !body.isConnected) return;
      const bounds = body.getBoundingClientRect();
      const publish = (
        position: ScriptPaneReadingPosition,
        element?: HTMLElement,
        rect?: DOMRect,
      ) => {
        const state = readingOwnership.current;
        if (state.physical)
          readingOwnership.current = {
            ...state,
            physical: {
              ...state.physical,
              reference:
                element && rect
                  ? {
                      element,
                      top: rect.top - bounds.top + body.scrollTop,
                      height: rect.height,
                    }
                  : null,
            },
          };
        binding.capture(position);
      };
      const preferred =
        preferredIndex === undefined
          ? undefined
          : {
              index: preferredIndex,
              element: registry.current.get(preferredIndex),
            };
      const preferredRect = preferred?.element?.getBoundingClientRect();
      if (
        preferred?.element &&
        body.contains(preferred.element) &&
        preferredRect &&
        preferredRect.top < bounds.bottom &&
        preferredRect.bottom > bounds.top
      ) {
        const position: ScriptPaneReadingPosition = {
          kind: "word",
          index: preferred.index,
          intent: "focus",
          offset: preferredRect.top - bounds.top,
          fallbackTop: body.scrollTop,
          turns: live.current.turns,
        };
        publish(position, preferred.element, preferredRect);
        return;
      }
      const stops = live.current.stops;
      let low = 0;
      let high = stops.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const word = registry.current.get(stops[middle].start);
        if (!word || !body.contains(word)) {
          low = middle + 1;
          continue;
        }
        if (word.getBoundingClientRect().bottom <= bounds.top) low = middle + 1;
        else high = middle;
      }
      const stop = stops[low];
      const word = stop ? registry.current.get(stop.start) : undefined;
      const rect = word?.getBoundingClientRect();
      if (stop && rect && rect.top < bounds.bottom) {
        const position: ScriptPaneReadingPosition = {
          kind: "word",
          index: stop.start,
          offset: rect.top - bounds.top,
          fallbackTop: body.scrollTop,
          turns: live.current.turns,
        };
        publish(position, word, rect);
        return;
      }
      const position: ScriptPaneReadingPosition = {
        kind: "scroll",
        top: body.scrollTop,
      };
      publish(position);
    }, []);

    const captureReadingPosition = useCallback(
      (preferredIndex?: number) => {
        const body = bodyRef.current;
        if (!body?.isConnected || !readingPositionRef.current) return;
        readingOwnership.current = acceptReadingPosition(
          readingOwnership.current,
          sampleReading(body),
        );
        serializeReadingPosition(preferredIndex);
      },
      [serializeReadingPosition, sampleReading],
    );

    const focusStop = useCallback(
      (start: number, preventScroll = false) => {
        setFocused(start);
        const word = focusable(registry.current.get(start));
        focusInternally(word, { preventScroll });
        if (!preventScroll && readingPositionRef.current?.restore) {
          captureReadingPosition(start);
        }
      },
      [captureReadingPosition, focusInternally],
    );

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
        start: (anchor, gesture) => {
          const accepted =
            live.current.props.onSelectionStart?.(anchor, gesture) !== false;
          selectionViewport.current = accepted ? "active" : "idle";
          if (accepted) captureReadingPosition();
          return accepted;
        },
        draft: (next) =>
          setDraft((prev) =>
            prev?.anchor === next?.anchor && prev?.head === next?.head
              ? prev
              : next,
          ),
        change: (anchor, head, gesture) => {
          captureReadingPosition();
          live.current.props.onSelectionChange?.(anchor, head, gesture);
        },
        end: (anchor, head, gesture, committed) => {
          setDraft(null);
          const now = live.current;
          captureReadingPosition();
          selectionViewport.current = "idle";
          now.props.onSelectionEnd?.(anchor, head, { ...gesture, committed });
          if (!committed) return;
          goalX.current = null;
          caretRef.current = anchor;
          const reached = stopContaining(now.stops, head);
          if (reached) focusStop(reached.start, true);
          now.props.onSelect?.({ kind: "words", anchor, head });
        },
        scrolled: () => {
          captureReadingPosition();
          live.current.props.onUserScroll?.();
        },
      }),
      [captureReadingPosition, measure, focusStop],
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
          focusInternally(focusable(registry.current.get(index)), {
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
          const mouse = gestures.lastKind.current === "mouse";
          if (mouse) {
            if (event.detail >= 3) {
              const turn = now.turns.find((t) =>
                t.words.some((word) => word.index === index),
              );
              const sentence = turn && sentenceSpan(turn.words, index);
              if (sentence) {
                now.props.onSelect?.({
                  kind: "words",
                  anchor: sentence.start,
                  head: sentence.end,
                });
              }
            }
            return;
          }
          const at = Date.now();
          const double = isDoubleTap(lastTap.current, index, at);
          lastTap.current = double ? null : { index, at };
          if (double) {
            now.props.onFixText?.({ start: index, end: index }, "double-tap");
          }
        },
        key: (event, start) => {
          if (event.ctrlKey || event.metaKey) return;
          const now = live.current;
          if (event.altKey) {
            const jump =
              !event.shiftKey && event.key === "ArrowDown"
                ? now.props.onNextUnsure
                : !event.shiftKey && event.key === "ArrowUp"
                  ? now.props.onPreviousUnsure
                  : undefined;
            if (jump) {
              handled(event);
              jump();
              return;
            }
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
        roll: (id) => {
          const rolls = live.current.props.seamRoll;
          return rolls?.limits(id)
            ? {
                limits: () => rolls.limits(id),
                onCommit: (ms) => rolls.commit(id, ms),
              }
            : undefined;
        },
        suggestion: (id) => live.current.props.onSuggestionSelect?.(id),
        seekTurn: (turnId) => live.current.props.onSeekTurn?.(turnId),
        speaker: (turnId, anchor) =>
          live.current.props.onSpeaker?.(turnId, anchor),
      };
    }, [measure, focusStop, focusInternally, gestures]);

    useImperativeHandle(
      ref,
      () => ({
        scrollToWord: (index, block = "nearest") => {
          const stop = stopContaining(live.current.stops, index);
          const el = stop ? registry.current.get(stop.start) : undefined;
          const body = bodyRef.current;
          if (el && body) {
            const before = body.scrollTop;
            scrollWithin(body, el, block);
            if (readingPositionRef.current && body.scrollTop !== before)
              readingOwnership.current = acceptReadingPosition(
                readingOwnership.current,
                sampleReading(body),
              );
          }
          return el !== undefined;
        },
        focusFind: () => {
          findButton.current?.focus();
          return findButton.current !== null;
        },
        focusWord: (index) => {
          const stop = stopContaining(live.current.stops, index);
          const el = stop ? focusable(registry.current.get(stop.start)) : null;
          focusInternally(el);
          return el != null;
        },
      }),
      [focusInternally, sampleReading],
    );

    const bodyShown = status.kind !== "empty" && status.kind !== "loading";
    const restoreReadingPosition = useCallback(() => {
      if (selectionViewport.current !== "idle" || grabbed.current !== null) {
        captureReadingPosition();
        return;
      }
      const body = bodyRef.current;
      const position = readingPositionRef.current?.getPosition();
      if (!body || !position) return;
      const before = body.scrollTop;
      let focusedAnchor: HTMLElement | null = null;
      let target =
        position.kind === "scroll" ? position.top : position.fallbackTop;
      if (
        position.kind === "word" &&
        (!position.turns || position.turns === live.current.turns)
      ) {
        const anchor = registry.current.get(position.index);
        if (anchor && body.contains(anchor)) {
          const pane = body.getBoundingClientRect();
          const word = anchor.getBoundingClientRect();
          let offset = position.offset;
          if (
            position.intent === "focus" &&
            anchor.contains(document.activeElement)
          ) {
            focusedAnchor = anchor;
            const top = Math.max(0, -pane.top);
            const bottom = Math.min(
              body.clientHeight,
              pane.height,
              window.innerHeight - pane.top,
            );
            offset = Math.max(top, Math.min(offset, bottom - word.height));
          }
          target = body.scrollTop + word.top - pane.top - offset;
        }
      }
      const maximum = Math.max(0, body.scrollHeight - body.clientHeight);
      const next =
        body.scrollHeight > 0
          ? Math.min(maximum, Math.max(0, target))
          : Math.max(0, target);
      if (next !== body.scrollTop) {
        body.scrollTop = next;
      }
      if (focusedAnchor && elementClipped(focusedAnchor, true)) {
        focusedAnchor.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "instant",
        });
      }
      let focusAccepted = false;
      if (focusedAnchor && position.kind === "word") {
        const offset =
          focusedAnchor.getBoundingClientRect().top -
          body.getBoundingClientRect().top;
        if (Math.abs(offset - position.offset) > 0.5) {
          focusAccepted = true;
        }
      }
      if (before !== body.scrollTop)
        readingOwnership.current = acceptReadingPosition(
          readingOwnership.current,
          sampleReading(body),
        );
      if (focusAccepted && position.kind === "word")
        serializeReadingPosition(position.index);
    }, [captureReadingPosition, serializeReadingPosition, sampleReading]);
    const reconcileViewport = useCallback(
      (boundary: ReadingBoundary) => {
        const body = bodyRef.current;
        const binding = readingPositionRef.current;
        if (!body?.isConnected) {
          readingOwnership.current = EMPTY_READING_OWNERSHIP;
          return;
        }
        if (!binding) {
          if (boundary.kind === "scroll" && isUserScroll())
            live.current.props.onUserScroll?.();
          return;
        }
        const sample = sampleReading(body);
        const result = advanceReading(
          readingOwnership.current,
          boundary,
          sample,
          binding.restore,
        );
        readingOwnership.current = result.state;
        if (selectionViewport.current !== "idle" || grabbed.current !== null) {
          if (result.state.touch)
            readingOwnership.current = {
              ...result.state,
              touch: { ...result.state.touch, evidence: NO_READING_EVIDENCE },
            };
          serializeReadingPosition();
          return;
        }
        if (result.effect === "capture") {
          serializeReadingPosition();
          live.current.props.onUserScroll?.();
        } else if (result.effect === "restore") restoreReadingPosition();
      },
      [
        serializeReadingPosition,
        restoreReadingPosition,
        isUserScroll,
        sampleReading,
      ],
    );
    useLayoutEffect(() => {
      if (readingPosition) reconcileViewport({ kind: "geometry" });
    }, [bodyShown, turns, readingPosition, reconcileViewport]);
    useLayoutEffect(() => {
      const body = bodyRef.current;
      const binding = readingPositionRef.current;
      if (!bodyShown || !body || !binding?.restore || !binding.getPosition())
        return;
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        active !== document.documentElement &&
        !body.parentElement?.contains(active) &&
        !active.contains(body)
      )
        return;
      if (elementClipped(body, false)) {
        body.scrollIntoView({
          block: "nearest",
          inline: "nearest",
          behavior: "instant",
        });
      }
    }, [bodyShown]);
    const [readingTargets] = useState<Element[]>(() => []);
    useLayoutEffect(() => {
      const body = bodyRef.current;
      readingTargets.splice(
        0,
        readingTargets.length,
        ...(readingPosition && body?.isConnected
          ? readingObservationTargets(body)
          : []),
      );
    });
    useResizeObserver(
      readingTargets,
      (entries) => {
        if (entries.some((entry) => readingTargets.includes(entry.target)))
          reconcileViewport({ kind: "geometry" });
      },
      readingPosition != null,
    );
    const readingBound = readingPosition != null;
    useEffect(() => {
      if (!readingBound) return;
      const restore = () => reconcileViewport({ kind: "geometry" });
      document.fonts?.addEventListener("loadingdone", restore);
      window.addEventListener("resize", restore);
      return () => {
        document.fonts?.removeEventListener("loadingdone", restore);
        window.removeEventListener("resize", restore);
      };
    }, [readingBound, reconcileViewport]);

    useEffect(() => {
      if (!readingBound) return;
      const endScrollbar = (event: globalThis.PointerEvent) => {
        if (readingOwnership.current.scrollbar.pointerId !== event.pointerId)
          return;
        reconcileViewport({
          kind: "input",
          input: {
            kind:
              event.type === "pointercancel"
                ? "scrollbar-cancel"
                : "scrollbar-end",
            pointerId: event.pointerId,
          },
        });
      };
      const cancelScrollbar = () => {
        const pointerId = readingOwnership.current.scrollbar.pointerId;
        if (pointerId === null) return;
        reconcileViewport({
          kind: "input",
          input: { kind: "scrollbar-cancel", pointerId },
        });
      };
      const hideScrollbar = () => {
        if (document.hidden) cancelScrollbar();
      };
      window.addEventListener("blur", cancelScrollbar);
      document.addEventListener("visibilitychange", hideScrollbar);
      window.addEventListener("pointerup", endScrollbar);
      window.addEventListener("pointercancel", endScrollbar);
      return () => {
        window.removeEventListener("blur", cancelScrollbar);
        document.removeEventListener("visibilitychange", hideScrollbar);
        window.removeEventListener("pointerup", endScrollbar);
        window.removeEventListener("pointercancel", endScrollbar);
      };
    }, [readingBound, reconcileViewport]);

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
      let active = true;
      let latestFocus: FocusEvent | null = null;
      const onFocusIn = (event: FocusEvent) => {
        latestFocus = event;
        inside.current = true;
        if (!(event.target instanceof HTMLElement)) return;
        const stop = event.target.closest<HTMLElement>("[data-stop]");
        if (!stop) return;
        const index = Number(stop.dataset.stop);
        setFocused(index);
        if (internalFocus.current || !readingPositionRef.current?.restore)
          return;
        const target = event.target;
        queueMicrotask(() => {
          if (
            !active ||
            latestFocus !== event ||
            bodyRef.current !== body ||
            !body.isConnected ||
            document.activeElement !== target ||
            registry.current.get(index) !== stop ||
            !body.contains(stop) ||
            !readingPositionRef.current?.restore
          )
            return;
          captureReadingPosition(index);
        });
      };
      const onFocusOut = (event: FocusEvent) => {
        const el = event.target;
        if (!(el instanceof HTMLElement)) return;
        // Removing the focused element can fire this too; only a live element means focus left.
        queueMicrotask(() => {
          if (el.isConnected && !body.contains(document.activeElement))
            inside.current = false;
        });
      };
      inside.current = body.contains(document.activeElement);
      body.addEventListener("keyup", onKeyUp);
      body.addEventListener("focusin", onFocusIn);
      body.addEventListener("focusout", onFocusOut);
      return () => {
        active = false;
        body.removeEventListener("keyup", onKeyUp);
        body.removeEventListener("focusin", onFocusIn);
        body.removeEventListener("focusout", onFocusOut);
      };
    }, [bodyShown, captureReadingPosition]);

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
      focusInternally(focusable(registry.current.get(heir.start)));
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
      if (!findStatus) return;
      setSpoken((previous) =>
        previous === findStatus ? `${findStatus}\u00a0` : findStatus,
      );
    }, [findStatus, findStatusKey]);

    const handlesShown =
      handles &&
      onSelect !== undefined &&
      span !== null &&
      bodyShown &&
      !selecting;
    // The grips can go while one is held (the selection is lost), and then no release comes.
    const gripsPresent = handlesShown && places !== null;
    useEffect(() => {
      if (!gripsPresent) {
        grabbed.current = null;
        setDragging(false);
      }
      return () => {
        grabbed.current = null;
      };
    }, [gripsPresent]);
    const hintShown = handleHint?.shown ?? false;
    const releaseHint = handleHint?.onRelease;
    useEffect(() => {
      if (hintShown && span === null) releaseHint?.();
    }, [hintShown, span, releaseHint]);
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

    useEffect(() => {
      if (!dragging) return;
      const cancel = (event: globalThis.KeyboardEvent) => {
        if (event.key !== "Escape" || grabbed.current === null) return;
        event.preventDefault();
        event.stopPropagation();
        live.current.props.onSelect?.(grabbed.current);
        grabbed.current = null;
      };
      window.addEventListener("keydown", cancel, true);
      return () => window.removeEventListener("keydown", cancel, true);
    }, [dragging]);

    const dragHandle = (edge: HandleEdge, point: { x: number; y: number }) => {
      const now = live.current;
      const body = bodyRef.current;
      if (!body || grabbed.current === null) return;
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

    // On a phone the header would hold only the caption and the follow pin:
    // the Role chip says what the link allows, and scrolling stops following
    // (Back to playhead returns). A Viewer keeps the caption, as one line.
    const phoneGuest = guest !== undefined && layout === "phone";
    const readable =
      status.kind === "ready" ||
      status.kind === "transcribing" ||
      status.kind === "outOfDate";
    const showHeader = readable && !phoneGuest;
    const captionOnly = readable && phoneGuest && guest === "viewer";
    const guestLabelId = useId();
    const describedBy =
      guest && (showHeader || captionOnly) ? guestLabelId : undefined;

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
            primary={
              status.onTranscribe
                ? {
                    label: "Transcribe this episode",
                    onClick: status.onTranscribe,
                  }
                : undefined
            }
          >
            {status.onTranscribe
              ? "Transcribe this episode to edit it by reading."
              : "This episode has no transcript yet."}
          </Cover>
        </section>
      );
    }

    const unsureShown = unsureCount ?? unsure;

    return (
      <section
        className="sys-script"
        aria-label="Script"
        aria-describedby={describedBy}
        data-layout={layout}
      >
        {captionOnly && guest ? (
          <p id={guestLabelId} className="sys-script-caption">
            {GUEST_SCRIPT_LABEL[guest]}
          </p>
        ) : null}
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
                  onClick={() => {
                    if (following) captureReadingPosition();
                    onFollowChange(!following);
                  }}
                >
                  <SystemIcon name="pin" size={16} />
                </button>
              ) : null}
            </div>
            {guest ? (
              <span id={guestLabelId} className="sys-script-guest">
                {GUEST_SCRIPT_LABEL[guest]}
              </span>
            ) : null}
            <div className="sys-script-notice">
              {status.kind === "transcribing" ? (
                <StatusRow
                  density="inline"
                  state="running"
                  title="Transcribing"
                  detail={
                    status.progress === undefined
                      ? undefined
                      : `${percentOf(status.progress)}%`
                  }
                  valueText={
                    status.progress === undefined
                      ? undefined
                      : `${percentOf(status.progress)} percent`
                  }
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
            role="presentation"
            data-selecting={selecting ? "" : undefined}
            ref={attachBody}
            onCopy={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("input, textarea")
              ) {
                return;
              }
              const text = selectionText(
                live.current.turns,
                live.current.selection,
                live.current.showCutText,
              );
              if (text === "") return;
              event.clipboardData.setData("text/plain", text);
              event.preventDefault();
            }}
            {...(readingPosition == null ? scrollHandlers : {})}
            onWheel={
              readingPosition == null
                ? scrollHandlers.onWheel
                : (event) => {
                    reconcileViewport({
                      kind: "input",
                      input:
                        event.ctrlKey || event.defaultPrevented
                          ? { kind: "reject-wheel" }
                          : event.deltaY === 0
                            ? { kind: "none" }
                            : {
                                kind: "direction",
                                source: "wheel",
                                direction: event.deltaY < 0 ? "up" : "down",
                              },
                    });
                  }
            }
            onKeyDown={
              readingPosition == null
                ? scrollHandlers.onKeyDown
                : (event) => {
                    const editable =
                      event.target instanceof Element &&
                      event.target.closest(
                        "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
                      );
                    reconcileViewport({
                      kind: "input",
                      input:
                        !event.defaultPrevented &&
                        !editable &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey &&
                        isScrollKey(
                          event.key,
                          event.target === event.currentTarget,
                        )
                          ? {
                              kind: "direction",
                              source: "key",
                              direction:
                                event.key === "PageUp" ||
                                event.key === "Home" ||
                                event.key === "ArrowUp" ||
                                (event.key === " " && event.shiftKey)
                                  ? "up"
                                  : "down",
                            }
                          : { kind: "none" },
                    });
                  }
            }
            onPointerDown={
              readingPosition == null
                ? scrollHandlers.onPointerDown
                : (event) => {
                    if (
                      event.target !== event.currentTarget ||
                      !event.isPrimary ||
                      event.pointerType === "touch" ||
                      event.button !== 0 ||
                      event.defaultPrevented
                    )
                      return;
                    reconcileViewport({
                      kind: "input",
                      input: {
                        kind: "scrollbar-start",
                        pointerId: event.pointerId,
                      },
                    });
                  }
            }
            onTouchStart={
              readingPosition == null
                ? scrollHandlers.onTouchStart
                : (event) => {
                    const contact =
                      event.touches.length === 1 && !event.defaultPrevented
                        ? event.touches[0]
                        : null;
                    reconcileViewport({
                      kind: "input",
                      input: contact
                        ? {
                            kind: "touch-start",
                            identifier: contact.identifier,
                            y: contact.clientY,
                          }
                        : { kind: "touch-cancel" },
                    });
                  }
            }
            onTouchMove={
              readingPosition == null
                ? scrollHandlers.onTouchMove
                : (event) => {
                    const contact =
                      event.touches.length === 1 ? event.touches[0] : null;
                    reconcileViewport({
                      kind: "input",
                      input: contact
                        ? {
                            kind: "touch-move",
                            identifier: contact.identifier,
                            y: contact.clientY,
                            blocked:
                              event.defaultPrevented ||
                              selectionViewport.current !== "idle" ||
                              grabbed.current !== null,
                          }
                        : { kind: "touch-cancel" },
                    });
                  }
            }
            onTouchEnd={
              readingPosition == null
                ? scrollHandlers.onTouchEnd
                : (event) => {
                    const contact =
                      event.changedTouches.length === 1 &&
                      event.touches.length === 0
                        ? event.changedTouches[0]
                        : null;
                    reconcileViewport({
                      kind: "input",
                      input: contact
                        ? { kind: "touch-end", identifier: contact.identifier }
                        : { kind: "touch-cancel" },
                    });
                  }
            }
            onTouchCancel={
              readingPosition == null
                ? undefined
                : () => {
                    reconcileViewport({
                      kind: "input",
                      input: { kind: "touch-cancel" },
                    });
                  }
            }
            onScroll={() => reconcileViewport({ kind: "scroll" })}
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
                onGrab={() => {
                  captureReadingPosition();
                  const now = live.current.selection;
                  grabbed.current =
                    now?.kind === "words"
                      ? { kind: "words", anchor: now.anchor, head: now.head }
                      : null;
                  setDragging(true);
                }}
                onRelease={() => {
                  grabbed.current = null;
                  setDragging(false);
                }}
              />
            ) : null}
          </div>
        )}
        {handlesShown && places && handleHint?.shown ? (
          <HandleHint hint={handleHint} places={places} body={bodyRef} />
        ) : null}
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
  found: readonly FoundHit[];
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
      for (const index of hit.indices) {
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
      <PersonAvatar person={turn.speaker} size={20} drawn={interactive} />
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
      {...(word.anchor ? presenceAnchorProps(word.anchor) : {})}
      data-state={word.mark?.kind === "suggested" ? undefined : word.mark?.kind}
      data-playing={playing ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-unsure={word.lowConfidence ? "" : undefined}
      data-hallucination={word.hallucination ? "" : undefined}
      data-locked={word.locked ? "" : undefined}
      title={
        [
          word.locked && TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
          word.hallucination && TRANSCRIPT_SUSPECT_HALLUCINATION_TIP,
        ]
          .filter(Boolean)
          .join("\n") || undefined
      }
      data-restored={word.restored ? "" : undefined}
      data-found={found}
      tabIndex={tabbable ? 0 : -1}
      aria-label={wordLabel(word, { selected, found })}
      aria-current={playing ? "true" : undefined}
      onClick={(event) => actions.click(index, event)}
      onKeyDown={(event) => actions.key(event, index)}
    >
      {word.text}
      {word.locked ? (
        <SystemIcon name="lock" size={8} className="sys-script-lock" />
      ) : null}
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
      data-seam-id={id}
      data-in-selection={inSelection ? "" : undefined}
      ref={(el) => actions.register(start, el)}
    >
      <Seam
        roll={piece.continued ? undefined : actions.roll(id)}
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
