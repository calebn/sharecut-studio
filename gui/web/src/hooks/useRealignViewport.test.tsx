import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRealignViewport } from "./useRealignViewport";

class FakeViewport extends EventTarget {
  offsetTop = 0;
  scale = 1;
  move(next: Partial<Pick<FakeViewport, "offsetTop" | "scale">>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event("scroll"));
  }
}

function Probe() {
  useRealignViewport();
  return <input aria-label="Time" />;
}

let viewport: FakeViewport;
let scrollTo: ReturnType<typeof vi.spyOn>;

describe("useRealignViewport", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
    delete document.documentElement.dataset.keyboard;
    vi.restoreAllMocks();
  });

  it("scrolls the page back to the top when the visual viewport is panned down with nothing to explain it", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("leaves a settled viewport alone", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 0 }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("leaves a pinch zoom, an open keyboard and a focused field alone", () => {
    const view = render(<Probe />);
    act(() => viewport.move({ offsetTop: 40, scale: 2 }));
    expect(scrollTo).not.toHaveBeenCalled();
    act(() => viewport.move({ offsetTop: 40, scale: 1 }));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    scrollTo.mockClear();
    document.documentElement.dataset.keyboard = "open";
    act(() => viewport.move({ offsetTop: 40 }));
    expect(scrollTo).not.toHaveBeenCalled();
    delete document.documentElement.dataset.keyboard;
    view.getByLabelText("Time").focus();
    act(() => viewport.move({ offsetTop: 40 }));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("stops listening when it unmounts", () => {
    const view = render(<Probe />);
    view.unmount();
    act(() => viewport.move({ offsetTop: 83 }));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
