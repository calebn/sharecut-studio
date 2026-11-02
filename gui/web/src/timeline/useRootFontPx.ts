import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { makeRemProbe, rootFontPx } from "../ui/rootFont";
import { useResizeObserver } from "../ui/useResizeObserver";

/** The root font size in px. Like the system Ruler it re-reads on a window resize and when a 1rem probe resizes, which is how a text-size change after mount shows. */
export function useRootFontPx(): number {
  const [px, setPx] = useState(rootFontPx);
  const probe = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = makeRemProbe();
    probe.current = el;
    document.body.appendChild(el);
    return () => {
      el.remove();
      probe.current = null;
    };
  }, []);
  useResizeObserver(probe, () => setPx(rootFontPx()));
  useEffect(() => {
    const changed = () => setPx(rootFontPx());
    window.addEventListener("resize", changed);
    return () => window.removeEventListener("resize", changed);
  }, []);
  return px;
}
