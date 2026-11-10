import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrimHint } from "./TrimHint";

const rect = (left: number, top: number, right: number, bottom: number) =>
  ({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  }) as DOMRect;

const boxes = {
  scroller: rect(0, 0, 400, 700),
  clip: rect(100, 300, 400, 352),
  scrollerWidth: 400,
  scrollerHeight: 700,
};

function Harness({ onRelease }: { onRelease?: () => void }) {
  const clip = useRef<HTMLDivElement>(null);
  return (
    <main>
      <div className="timeline-scroll">
        <div ref={clip} className="clip-block" />
      </div>
      <TrimHint
        anchor={clip}
        hint={{
          text: "Drag the edges to trim",
          shown: true,
          onDismiss: vi.fn(),
          onRelease,
        }}
      />
    </main>
  );
}

const note = () => document.querySelector<HTMLElement>("[role=note]")!;
const scroller = () => document.querySelector(".timeline-scroll")!;

describe("TrimHint", () => {
  beforeEach(() => {
    Object.assign(boxes, {
      scroller: rect(0, 0, 400, 700),
      clip: rect(100, 300, 400, 352),
      scrollerWidth: 400,
      scrollerHeight: 700,
    });
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.classList.contains("timeline-scroll")) return boxes.scroller;
        if (this.classList.contains("clip-block")) return boxes.clip;
        if (this.classList.contains("sys-coach-tip"))
          return rect(0, 0, 194, 52);
        return rect(0, 0, 0, 0);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      () => boxes.scrollerWidth,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      () => boxes.scrollerHeight,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("is as wide as 15 rem, or as the window when that is narrower", () => {
    render(<Harness />);
    expect(note().style.maxInlineSize).toBe("240px");
    document.body.innerHTML = "";
    boxes.scrollerWidth = 250;
    render(<Harness />);
    expect(note().style.maxInlineSize).toBe("234px");
  });

  it("goes over the clip a handle's width and a gap past its start when neither side has room", () => {
    boxes.clip = rect(100, 20, 400, 80);
    boxes.scrollerHeight = 100;
    render(<Harness />);
    expect([note().style.left, note().style.top]).toEqual(["112px", "24px"]);
  });

  it("is placed again when the lanes scroll or the window resizes", () => {
    render(<Harness />);
    expect(note().style.left).toBe("100px");
    boxes.clip = rect(150, 300, 400, 352);
    act(() => {
      scroller().dispatchEvent(new Event("scroll"));
    });
    expect(note().style.left).toBe("150px");
    boxes.clip = rect(180, 300, 400, 352);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(note().style.left).toBe("180px");
  });

  it("stays hidden and lets go when no spot shows all of it", () => {
    boxes.clip = rect(100, 20, 400, 40);
    boxes.scrollerHeight = 60;
    const onRelease = vi.fn();
    render(<Harness onRelease={onRelease} />);
    expect(note().style.visibility).toBe("hidden");
    expect(onRelease).toHaveBeenCalled();
  });
});
