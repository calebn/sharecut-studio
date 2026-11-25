import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { scrollerOf } from "../../commands/timelineReveal";
import { useDawStore } from "../../state/dawStore";
import type { Selection } from "../../types/project";
import { type AnchorRect, visualViewportBox } from "../../ui/anchoredPlacement";
import { anchorLost, type Pin, pinOf } from "../../ui/anchorPin";
import type { AnchorExclusion } from "../../ui/useAnchoredPanel";
import { useResizeObserver } from "../../ui/useResizeObserver";
import { timelineChromeBottom } from "../../utils/timelineChrome";
import { timelineHeaderOffsetWidth } from "../../utils/timelineViewport";
import { timelineCorner } from "./timelineCorner";

const esc = (value: string) => CSS.escape(value);

function laneOf(root: ParentNode, trackId: string | undefined) {
  return (
    (trackId
      ? root.querySelector<HTMLElement>(
          `.lane-row[data-track-id="${esc(trackId)}"]`,
        )
      : null) ?? root.querySelector<HTMLElement>(".lane-row[data-track-id]")
  );
}

/**
 * What the anchor must stay inside: the scroller it lives in (the timeline's, less
 * its sticky track headers and ruler; the Script pane's for a word), clipped to
 * the visual viewport. An anchor in no scroller answers to the viewport alone.
 */
function pinBox(node: HTMLElement): AnchorRect {
  const vv = visualViewportBox();
  const box = {
    left: vv.left,
    top: vv.top,
    right: vv.left + vv.width,
    bottom: vv.top + vv.height,
  };
  const scroll = scrollerOf(node);
  if (!scroll) return box;
  const rect = scroll.getBoundingClientRect();
  // The client box, so an anchor under a scrollbar is out of it.
  const width = scroll.clientWidth || rect.width;
  const height = scroll.clientHeight || rect.height;
  const timeline = scroll.matches(".timeline-scroll");
  // The ruler and marker lane are sticky: markers in them never scroll up under
  // the chrome, so only an anchor in a lane answers to the chrome's bottom edge.
  const inChrome = node.closest(".timeline-ruler, .marker-lane") !== null;
  return {
    left: Math.max(
      box.left,
      rect.left + (timeline ? timelineHeaderOffsetWidth(scroll) : 0),
    ),
    top: Math.max(
      box.top,
      rect.top,
      timeline && !inChrome ? timelineChromeBottom(scroll) : 0,
    ),
    right: Math.min(box.right, rect.left + (scroll.clientLeft || 0) + width),
    bottom: Math.min(box.bottom, rect.top + (scroll.clientTop || 0) + height),
  };
}

type Measure = Pin & { readonly lost: boolean };

function measureNode(node: HTMLElement): Measure {
  const rect = node.getBoundingClientRect();
  const box = pinBox(node);
  // Only an anchor inside a scroller can be told from one the page has not
  // drawn yet; every selectable node lives in one.
  const lost = scrollerOf(node) !== null && anchorLost(rect, box);
  return { ...pinOf(rect, box), lost };
}

function findSelectionAnchor(
  root: ParentNode,
  selection: Selection,
): HTMLElement | null {
  if (selection === null) return null;
  const timeline = () =>
    root.querySelector<HTMLElement>(".timeline-area") ??
    root.querySelector<HTMLElement>(".edit-timeline-col");
  switch (selection.kind) {
    case "transcriptRange": {
      const first = Math.min(selection.startWordIndex, selection.endWordIndex);
      // The Edit Script keys a word `track:source:index`; the guest transcript
      // puts its turn's ordinal in front.
      const key = esc(
        `${selection.trackId}:${selection.sourceId ?? ""}:${first}`,
      );
      return (
        root.querySelector<HTMLElement>(
          `.sys-script-word[data-word-key="${key}"], .sys-script-word[data-word-key$=":${key}"]`,
        ) ?? laneOf(root, selection.trackId)
      );
    }
    case "range": {
      for (const id of selection.target.track_ids) {
        const overlay = root.querySelector<HTMLElement>(
          `.lane-row[data-track-id="${esc(id)}"] .lane-inner > .range-overlay`,
        );
        if (overlay) return overlay;
      }
      return laneOf(root, selection.target.track_ids[0]);
    }
    case "clip": {
      const ids = selection.ids ?? [selection.id];
      for (const id of ids) {
        const block = root.querySelector<HTMLElement>(
          `[data-clip-id="${esc(id)}"]`,
        );
        if (block) return block;
      }
      return laneOf(root, selection.trackId);
    }
    case "pending":
      return (
        root.querySelector<HTMLElement>(
          `[data-pending-id="${esc(selection.id)}"]`,
        ) ?? laneOf(root, selection.trackId)
      );
    case "comment":
      return (
        root.querySelector<HTMLElement>(
          `[data-hit-kind="comment"][data-hit-id="${esc(selection.id)}"]`,
        ) ?? timeline()
      );
    case "seam":
    case "bleedAttenuation":
    case "track":
    case "envelope":
    case "envelopePoint":
      return laneOf(root, selection.trackId) ?? timeline();
    default:
      return timeline();
  }
}

type SelectionAnchor = {
  readonly ref: RefObject<HTMLElement | null>;
  readonly exclusion: AnchorExclusion;
  readonly moves: readonly unknown[];
  readonly clearTop: () => number;
  /** Where the pinned bar's room begins: the right edge of the sticky track headers, 0 while attached. */
  readonly clearStart: () => number;
  /** False until the anchor is found and while its node is detached. */
  readonly present: boolean;
  /** True while the anchor has scrolled wholly out of its box. */
  readonly pinned: boolean;
  /** Where to place a bar against: fresh on every call, never off screen. */
  readonly rect: () => AnchorRect | null;
  /** Layout has not yet located the anchor for the new selection. */
  readonly resolving: boolean;
  /** The anchor is found and inside its box; the Inspector card hides otherwise. */
  readonly visible: boolean;
};

export function useSelectionAnchor(
  root: HTMLElement | null,
  selection: Selection,
  enabled: boolean,
  /** The box the bar may use when it must clear the header; the root by default. */
  within: HTMLElement | null = root,
): SelectionAnchor {
  const ref = useRef<HTMLElement | null>(null);
  const excludeRef = useRef<HTMLElement | null>(null);
  const withinRef = useRef<HTMLElement | null>(null);
  const [state, setState] = useState({ pinned: false, lost: false });
  const [located, setLocated] = useState<{
    node: HTMLElement | null;
    selection: Selection;
  }>({ node: null, selection: null });
  const { node } = located;
  const [excluded, setExcluded] = useState<HTMLElement | null>(null);
  const { project, zoomPxPerSec } = useDawStore(
    useShallow((s) => ({ project: s.project, zoomPxPerSec: s.zoomPxPerSec })),
  );

  useLayoutEffect(() => {
    const resolve = () => {
      const found =
        enabled && root ? findSelectionAnchor(root, selection) : null;
      ref.current = found;
      const header =
        selection?.kind === "transcriptRange" &&
        found?.matches(".sys-script-word")
          ? (found
              .closest(".sys-script")
              ?.querySelector<HTMLElement>(".sys-script-header") ?? null)
          : null;
      excludeRef.current = header;
      withinRef.current = within;
      setExcluded(header);
      setLocated((was) =>
        was.node === found && was.selection === selection
          ? was
          : { node: found, selection },
      );
    };
    resolve();
    if (!enabled || !root || typeof MutationObserver === "undefined") return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        resolve();
      });
    });
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [root, within, selection, enabled, project, zoomPxPerSec]);

  const moves = useMemo(
    () => [zoomPxPerSec, node, selection, excluded, root],
    [zoomPxPerSec, node, selection, excluded, root],
  );

  // The pin is the bounds math; the observer and the scroll listeners only say
  // when to redo it, since the observer's root (the window) misses the sticky
  // ruler and track headers.
  const remeasure = useCallback(() => {
    const next =
      node?.isConnected === true
        ? measureNode(node)
        : { pinned: false, lost: false };
    setState((was) =>
      was.pinned === next.pinned && was.lost === next.lost
        ? was
        : { pinned: next.pinned, lost: next.lost },
    );
  }, [node]);
  useLayoutEffect(() => {
    remeasure();
    if (!node || !node.isConnected) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        remeasure();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(remeasure, { threshold: 0 });
    observer?.observe(node);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [node, moves, remeasure]);
  // A scroller that moves or resizes with no window event (a column toggle,
  // the Inspector opening) changes the box without a scroll.
  useResizeObserver(
    () => (node ? scrollerOf(node) : null),
    remeasure,
    node !== null,
  );

  const exclusion = useMemo<AnchorExclusion>(
    () => ({
      elements: () => [excludeRef.current, timelineCorner(root)],
      withinRef,
    }),
    [root],
  );

  const clearTop = useCallback(() => {
    const scroll = ref.current?.closest(".timeline-scroll");
    return scroll ? timelineChromeBottom(scroll) : 0;
  }, []);

  const clearStart = useCallback(() => {
    const el = ref.current;
    if (!el?.isConnected || !measureNode(el).pinned) return 0;
    const scroll = el.closest<HTMLElement>(".timeline-scroll");
    const header = scroll?.querySelector<HTMLElement>(".track-headers");
    return header ? header.getBoundingClientRect().right : 0;
  }, []);

  const rect = useCallback(() => {
    const el = ref.current;
    if (!el?.isConnected) return null;
    const measured = measureNode(el);
    return measured.lost ? null : measured.rect;
  }, []);

  const present = enabled && node !== null && node.isConnected && !state.lost;
  const pinned = state.pinned;
  return {
    ref,
    clearTop,
    clearStart,
    exclusion,
    moves,
    rect,
    present,
    pinned,
    resolving: enabled && located.selection !== selection,
    visible: present && !pinned,
  };
}
