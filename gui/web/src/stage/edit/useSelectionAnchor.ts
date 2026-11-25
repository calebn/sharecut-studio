import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "../../state/dawStore";
import type { Selection } from "../../types/project";
import { type AnchorRect, visualViewportBox } from "../../ui/anchoredPlacement";
import { type Pin, pinOf } from "../../ui/anchorPin";
import type { AnchorExclusion } from "../../ui/useAnchoredPanel";
import { timelineChromeBottom } from "../../utils/timelineChrome";
import { scrollerOf } from "../../utils/timelineReveal";
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
  const timeline = scroll.matches(".timeline-scroll");
  return {
    left: Math.max(
      box.left,
      rect.left + (timeline ? timelineHeaderOffsetWidth(scroll) : 0),
    ),
    top: Math.max(
      box.top,
      rect.top,
      timeline ? timelineChromeBottom(scroll) : 0,
    ),
    right: Math.min(box.right, rect.right),
    bottom: Math.min(box.bottom, rect.bottom),
  };
}

const pinOfNode = (node: HTMLElement): Pin =>
  pinOf(node.getBoundingClientRect(), pinBox(node));

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
  /** False until the anchor is found and while its node is detached. */
  readonly present: boolean;
  /** True while the anchor has scrolled wholly out of its box. */
  readonly pinned: boolean;
  /** Where to place a bar against: fresh on every call, never off screen. */
  readonly rect: () => AnchorRect | null;
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
  const [pinned, setPinned] = useState(false);
  const [node, setNode] = useState<HTMLElement | null>(null);
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
      setNode(found);
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
  useLayoutEffect(() => {
    if (!node || !node.isConnected) {
      setPinned(false);
      return;
    }
    const measure = () => setPinned(pinOfNode(node).pinned);
    measure();
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(measure, { threshold: 0 });
    observer?.observe(node);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [node, moves]);

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

  const rect = useCallback(() => {
    const el = ref.current;
    return el?.isConnected ? pinOfNode(el).rect : null;
  }, []);

  const present = enabled && node !== null && node.isConnected;
  return {
    ref,
    clearTop,
    exclusion,
    moves,
    rect,
    present,
    pinned,
    visible: present && !pinned,
  };
}
