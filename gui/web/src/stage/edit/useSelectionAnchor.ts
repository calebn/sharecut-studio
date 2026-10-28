import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "../../state/dawStore";
import type { Selection } from "../../types/project";

const esc = (value: string) => CSS.escape(value);

/** The lane of `trackId`, or the first lane when the track has none on screen. */
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
 * The element the Action bar floats beside for `selection`: the first selected
 * word chip, the range's overlay, the clip block, the pending edit's mark, and
 * for a kind with no mark of its own (a chapter, a track) its lane or the
 * timeline. Null when none is on screen. Pure over the DOM it is given.
 */
export function findSelectionAnchor(
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
      return (
        root.querySelector<HTMLElement>(
          `[data-transcript-word][data-track-id="${esc(selection.trackId)}"][data-word-index="${first}"]`,
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
    case "applied":
    case "bleedAttenuation":
    case "track":
    case "envelope":
    case "envelopePoint":
      return laneOf(root, selection.trackId) ?? timeline();
    default:
      return timeline();
  }
}

export type SelectionAnchor = {
  readonly ref: RefObject<HTMLElement | null>;
  /** A value that changes when the anchor moves without a scroll or resize. */
  readonly moves: string;
  /** False while the anchor is off screen (scrolled or zoomed away) or absent. */
  readonly visible: boolean;
};

/**
 * Finds and follows the selection's anchor. The node is looked up again when
 * the selection or the project changes and whenever the workspace's elements
 * come or go (a zoom or a scroll that remounts marks, the Script showing or
 * hiding); the bar hides while the node is clipped out of view and returns
 * with it. Scroll itself is not read: the placement hook listens for it.
 */
export function useSelectionAnchor(
  root: HTMLElement | null,
  selection: Selection,
  enabled: boolean,
): SelectionAnchor {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const { project, zoomPxPerSec } = useDawStore(
    useShallow((s) => ({ project: s.project, zoomPxPerSec: s.zoomPxPerSec })),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the project and zoom replace the marks the lookup finds
  useLayoutEffect(() => {
    const resolve = () => {
      const found =
        enabled && root ? findSelectionAnchor(root, selection) : null;
      ref.current = found;
      setNode((prev) => (prev === found ? prev : found));
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
  }, [root, selection, enabled, project, zoomPxPerSec]);

  useLayoutEffect(() => {
    if (!node || !node.isConnected) {
      setVisible(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1);
        if (last) setVisible(last.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return {
    ref,
    moves: String(zoomPxPerSec),
    visible: enabled && node !== null && visible,
  };
}
