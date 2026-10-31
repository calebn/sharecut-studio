import {
  type RefObject,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { useDawStore } from "../../state/dawStore";
import type { Selection } from "../../types/project";

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
      return (
        root.querySelector<HTMLElement>(
          `.sys-script-word[data-word-key="${esc(`${selection.trackId}:${selection.sourceId ?? ""}:${first}`)}"]`,
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

type SelectionAnchor = {
  readonly ref: RefObject<HTMLElement | null>;
  readonly moves: readonly unknown[];
  readonly visible: boolean;
};

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

  const moves = useMemo(
    () => [zoomPxPerSec, node, selection],
    [zoomPxPerSec, node, selection],
  );

  return {
    ref,
    moves,
    visible: enabled && node !== null && visible,
  };
}
