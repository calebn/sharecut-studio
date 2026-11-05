import { fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetentView } from "./hitRouting";
import { TimelinePhysicalOverlays } from "./TimelinePhysicalOverlays";
import { visibleBox } from "./visibleBox";

const detent: DetentView = {
  x: 250,
  boundary: { sec: 10, label: "the playhead" },
};
let laneRect: DOMRect;
let scrollRect: DOMRect;

function Frame({
  current = detent,
  nodeKey = "first",
  lanes = true,
  scroller = true,
  onCommit,
}: {
  current?: DetentView | null;
  nodeKey?: string;
  lanes?: boolean;
  scroller?: boolean;
  onCommit?: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    onCommit?.();
  });
  return (
    <>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        Recommit {revision}
      </button>
      {scroller ? (
        <div
          key={`scroll-${nodeKey}`}
          ref={scrollerRef}
          data-testid="measurement-scroller"
        />
      ) : null}
      {lanes ? (
        <div
          key={`lanes-${nodeKey}`}
          ref={lanesRef}
          data-testid="measurement-lanes"
        />
      ) : null}
      <TimelinePhysicalOverlays
        scrollerRef={scrollerRef}
        lanesRef={lanesRef}
        chooser={null}
        create={null}
        detent={current}
        router={null}
        phone={false}
      />
    </>
  );
}

function mark() {
  const node = document.querySelector<HTMLElement>(".detent-mark");
  expect(node).not.toBeNull();
  if (!node) throw new Error("Expected a visible detent mark");
  return node;
}

beforeEach(() => {
  laneRect = new DOMRect(50, 100, 600, 200);
  scrollRect = new DOMRect(20, 30, 800, 500);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function measure() {
  return vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === "measurement-lanes"
        ? laneRect
        : scrollRect;
    });
}

describe("TimelinePhysicalOverlays physical input ownership", () => {
  it("settles its own numeric update and samples every unrelated parent commit", () => {
    const reads = measure();
    render(<Frame />);
    expect(mark().style.top).toBe("100px");
    expect(reads).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Recommit 0" }));
    expect(reads).toHaveBeenCalledTimes(6);
    laneRect = new DOMRect(50, 140, 600, 200);
    fireEvent.click(screen.getByRole("button", { name: "Recommit 1" }));
    expect(mark().style.top).toBe("140px");
    expect(reads).toHaveBeenCalledTimes(10);
  });

  it("uses current detent authority while retained numeric bounds are corrected after reopening", () => {
    measure();
    const observe = vi.fn(() => {
      const node = document.querySelector<HTMLElement>(".detent-mark");
      return node ? { left: node.style.left, top: node.style.top } : null;
    });
    const { rerender } = render(<Frame onCommit={observe} />);
    expect(mark().style.top).toBe("100px");
    rerender(<Frame current={null} onCommit={observe} />);
    expect(document.querySelector(".detent-mark")).toBeNull();
    laneRect = new DOMRect(50, 160, 600, 200);
    rerender(<Frame current={{ ...detent, x: 300 }} onCommit={observe} />);
    expect(observe.mock.results.at(-1)?.value).toEqual({
      left: "300px",
      top: "100px",
    });
    expect(mark().style.left).toBe("300px");
    expect(mark().style.top).toBe("160px");
  });

  it("accepts equal-number replacement nodes without replacing the visible mark", () => {
    const reads = measure();
    const { rerender } = render(<Frame />);
    const source = screen.getByTestId("measurement-lanes");
    const visible = mark();
    expect(reads).toHaveBeenCalledTimes(4);
    rerender(<Frame nodeKey="replacement" />);
    expect(screen.getByTestId("measurement-lanes")).not.toBe(source);
    expect(mark()).toBe(visible);
    expect(reads).toHaveBeenCalledTimes(8);
  });

  it("keeps lanes-first, fractional, inverted and actually missing source bounds", () => {
    measure();
    laneRect = new DOMRect(50, -0.5, 600, 100.75);
    const { rerender } = render(<Frame />);
    expect(mark().style.top).toBe("0px");
    expect(mark().style.height).toBe("100.25px");
    laneRect = Object.defineProperties(new DOMRect(50, 200.5, 600, 0), {
      top: { value: 200.5 },
      bottom: { value: 100.25 },
    });
    rerender(<Frame />);
    expect(mark().style.top).toBe("200.5px");
    expect(mark().style.height).toBe("0px");
    vi.stubGlobal("innerHeight", 400);
    laneRect = new DOMRect(50, 500, 600, 20);
    rerender(<Frame />);
    expect(visibleBox(screen.getByTestId("measurement-lanes"))).toMatchObject({
      top: 500,
      bottom: 400,
    });
    expect(mark().style.top).toBe("500px");
    expect(mark().style.height).toBe("0px");
    scrollRect = new DOMRect(20, 31.25, 800, 68.25);
    rerender(<Frame lanes={false} />);
    expect(mark().style.top).toBe("31.25px");
    expect(mark().style.height).toBe("68.25px");
    rerender(<Frame lanes={false} scroller={false} />);
    expect(mark().style.top).toBe("0px");
    expect(mark().style.height).toBe(`${window.innerHeight}px`);
  });
});
