import { useCallback, useRef } from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

type Snapshot = { fromEnd: number; focusShown: boolean };

function focusedWithin(host: HTMLElement): HTMLElement | null {
  const focused = document.activeElement;
  return focused instanceof HTMLElement && host.contains(focused)
    ? focused
    : null;
}

function isShown(host: HTMLElement, target: HTMLElement): boolean {
  const box = host.getBoundingClientRect();
  const top = box.top + host.clientTop;
  const rect = target.getBoundingClientRect();
  return rect.top >= top && rect.bottom <= top + host.clientHeight;
}

function snapshotOf(host: HTMLElement): Snapshot {
  const focused = focusedWithin(host);
  return {
    fromEnd: host.scrollHeight - host.clientHeight - host.scrollTop,
    focusShown: focused !== null && isShown(host, focused),
  };
}

/**
 * Keeps the focused control of a scrolling host on screen when the host
 * resizes. A host that was showing it and now is not first keeps its distance
 * from the end, as a clamped resize does, then scrolls the control into view
 * if that is not enough. Returns a callback ref for the scroller.
 */
export function useKeepFocusInView(): (
  node: HTMLElement | null,
) => (() => void) | undefined {
  const hostRef = useRef<HTMLElement | null>(null);
  const snapshot = useRef<Snapshot>({ fromEnd: 0, focusShown: false });

  useResizeObserver(hostRef, () => {
    const host = hostRef.current;
    if (!host) return;
    const focused = focusedWithin(host);
    if (focused && snapshot.current.focusShown && !isShown(host, focused)) {
      host.scrollTop =
        host.scrollHeight - host.clientHeight - snapshot.current.fromEnd;
      if (!isShown(host, focused)) {
        focused.scrollIntoView?.({ block: "nearest" });
      }
    }
    snapshot.current = snapshotOf(host);
  });

  return useCallback((node: HTMLElement | null) => {
    hostRef.current = node;
    if (!node) return;
    const measure = () => {
      snapshot.current = snapshotOf(node);
    };
    measure();
    node.addEventListener("scroll", measure);
    node.addEventListener("focusin", measure);
    return () => {
      hostRef.current = null;
      node.removeEventListener("scroll", measure);
      node.removeEventListener("focusin", measure);
    };
  }, []);
}
