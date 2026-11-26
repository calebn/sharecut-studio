import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { makeRemProbe, rootFontPx } from "../ui/rootFont";
import { useResizeObserver } from "../ui/useResizeObserver";
import { DEFAULT_REM_PX } from "./rulerMath";

/**
 * The root font size in px. A window resize (page zoom) or a text-size change
 * after mount re-reads it, through a probe appended to `host`.
 */
export function useRem(host: RefObject<HTMLElement | null>): number {
  const probe = useRef<HTMLElement | null>(null);
  const changed = useRef<(() => void) | null>(null);
  const read = useRef<number | null>(null);
  const subscribe = useCallback((notify: () => void) => {
    const onChange = () => {
      read.current = null;
      notify();
    };
    read.current = null;
    changed.current = onChange;
    window.addEventListener("resize", onChange);
    return () => {
      changed.current = null;
      window.removeEventListener("resize", onChange);
    };
  }, []);
  const snapshot = useCallback(() => (read.current ??= rootFontPx()), []);
  const rem = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_REM_PX);
  useLayoutEffect(() => {
    const el = makeRemProbe();
    probe.current = el;
    host.current?.appendChild(el);
    return () => {
      el.remove();
      probe.current = null;
    };
  }, [host]);
  useResizeObserver(probe, () => changed.current?.());
  return rem;
}
