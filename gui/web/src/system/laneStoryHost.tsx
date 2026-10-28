import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useResizeObserver } from "../ui/useResizeObserver";

const FALLBACK_WIDTH = 360;

/**
 * Gives `children` the width of the box they sit in, the way the lanes host
 * measures its viewport and hands one width to the ruler and the marker lane.
 */
export function Measured({
  children,
}: {
  children: (width: number) => ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    setWidth(box.current?.clientWidth || FALLBACK_WIDTH);
  }, []);
  useResizeObserver(box, (entries) => {
    const last = entries[entries.length - 1];
    if (last) setWidth(Math.floor(last.contentRect.width));
  });
  return (
    <div ref={box} style={measured}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

const measured: CSSProperties = {
  boxSizing: "border-box",
  inlineSize: "100%",
  maxInlineSize: "100%",
  padding: 0,
};

/** A stand-in for the lanes under the marker lane, so a stray hit area shows. */
export function LanesBelow({ width }: { width: number }) {
  return (
    <div
      data-testid="lanes-below"
      style={{
        inlineSize: width,
        blockSize: "4.5rem",
        background: "var(--color-timeline-lane)",
      }}
    />
  );
}
