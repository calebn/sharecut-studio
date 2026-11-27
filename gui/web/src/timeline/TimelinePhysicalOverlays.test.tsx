import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useLayoutEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChooserView, DetentView, HitRouter } from "./hitRouting";
import type { TimelineChooserProps } from "./TimelineChooser";
import { TimelinePhysicalOverlays } from "./TimelinePhysicalOverlays";
import { visibleBox } from "./visibleBox";

vi.mock("./TimelineChooser", () => ({
  TimelineChooser: ({ bounds, view, router }: TimelineChooserProps) => (
    <button type="button" onClick={router.close}>
      {view.origin.x}: {bounds.left}, {bounds.top}, {bounds.right},{" "}
      {bounds.bottom}
    </button>
  ),
}));

const chooserView: ChooserView = {
  origin: { x: 250, y: 120 },
  hits: [],
  fingerDown: false,
  over: null,
  armed: false,
};

function chooserRouter(): HitRouter {
  return {
    dispose: vi.fn(),
    defers: () => false,
    claimsClick: () => false,
    longPress: vi.fn(),
    choose: vi.fn(),
    openCreate: () => false,
    close: vi.fn(),
    disarm: vi.fn(),
  };
}

const detent: DetentView = {
  x: 250,
  boundary: { sec: 10, label: "the playhead" },
};
let laneRect: DOMRect;
let scrollRect: DOMRect;

function Frame({
  current = detent,
  scrollerKey = "first",
  lanesKey = "first",
  lanes = true,
  scroller = true,
  onCommit,
  chooser = null,
  router = null,
}: {
  current?: DetentView | null;
  scrollerKey?: string;
  lanesKey?: string;
  lanes?: boolean;
  scroller?: boolean;
  onCommit?: () => void;
  chooser?: ChooserView | null;
  router?: HitRouter | null;
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
          key={`scroll-${scrollerKey}`}
          ref={scrollerRef}
          data-testid="measurement-scroller"
        />
      ) : null}
      {lanes ? (
        <div
          key={`lanes-${lanesKey}`}
          ref={lanesRef}
          data-testid="measurement-lanes"
        />
      ) : null}
      <TimelinePhysicalOverlays
        scrollerRef={scrollerRef}
        lanesRef={lanesRef}
        chooser={chooser}
        create={null}
        detent={current}
        router={router}
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

  it.each(["scroller", "lanes"] as const)(
    "accepts a replacement %s without replacing the visible mark",
    (source) => {
      const reads = measure();
      const { rerender } = render(<Frame />);
      const originalScroller = screen.getByTestId("measurement-scroller");
      const originalLanes = screen.getByTestId("measurement-lanes");
      const visible = mark();
      reads.mockClear();
      rerender(
        <Frame
          scrollerKey={source === "scroller" ? "replacement" : undefined}
          lanesKey={source === "lanes" ? "replacement" : undefined}
        />,
      );
      const scroller = screen.getByTestId("measurement-scroller");
      const lanes = screen.getByTestId("measurement-lanes");
      expect(scroller === originalScroller).toBe(source !== "scroller");
      expect(lanes === originalLanes).toBe(source !== "lanes");
      expect(mark()).toBe(visible);
      expect(reads.mock.contexts).toEqual([scroller, lanes, scroller, lanes]);
    },
  );

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

it("measures a chooser only with a router and refreshes its bounds after reopening", () => {
  const read = measure();
  const router = chooserRouter();
  const { rerender } = render(<Frame current={null} chooser={chooserView} />);
  expect(read).not.toHaveBeenCalled();

  rerender(<Frame current={null} chooser={chooserView} router={router} />);
  const first = screen.getByRole("button", { name: "250: 20, 30, 820, 530" });
  fireEvent.click(first);
  expect(router.close).toHaveBeenCalledOnce();

  rerender(<Frame current={null} router={router} />);
  expect(first).not.toBeInTheDocument();
  // Keep right and top identical. A left-only or bottom-only bound change
  // must be enough to publish its own measurement.
  scrollRect = new DOMRect(40, 30, 780, 500);
  rerender(<Frame current={null} chooser={chooserView} router={router} />);
  expect(
    screen.getByRole("button", { name: "250: 40, 30, 820, 530" }),
  ).toBeInTheDocument();

  scrollRect = new DOMRect(40, 30, 780, 410);
  rerender(<Frame current={null} chooser={chooserView} router={router} />);
  expect(
    screen.getByRole("button", { name: "250: 40, 30, 820, 440" }),
  ).toBeInTheDocument();
});

it("settles and refreshes chooser and detent measurements under StrictMode", () => {
  measure();
  const router = chooserRouter();
  const { rerender } = render(
    <StrictMode>
      <Frame chooser={chooserView} router={router} />
    </StrictMode>,
  );
  expect(mark().style.top).toBe("100px");
  expect(
    screen.getByRole("button", { name: "250: 20, 30, 820, 530" }),
  ).toBeInTheDocument();

  laneRect = new DOMRect(50, 150, 600, 200);
  scrollRect = new DOMRect(40, 30, 780, 410);
  rerender(
    <StrictMode>
      <Frame chooser={chooserView} router={router} />
    </StrictMode>,
  );
  expect(mark().style.top).toBe("150px");
  expect(
    screen.getByRole("button", { name: "250: 40, 30, 820, 440" }),
  ).toBeInTheDocument();
});
