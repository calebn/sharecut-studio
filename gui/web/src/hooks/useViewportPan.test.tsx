import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useViewportPan } from "./useViewportPan";

class FakeViewport extends EventTarget {
  offsetTop = 0;
  height = 347;
  scale = 1;
  move(next: Partial<Pick<FakeViewport, "offsetTop" | "height" | "scale">>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event("scroll"));
  }
}

function Probe() {
  useViewportPan();
  return <input aria-label="Time" />;
}

const root = document.documentElement;
let viewport: FakeViewport;

describe("useViewportPan", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
    delete root.dataset.keyboard;
    root.style.removeProperty("--viewport-pan-top");
    root.style.removeProperty("--viewport-pan-height");
    delete root.dataset.viewportPan;
  });

  it("publishes a pan with nothing to explain it, and clears it when the viewport settles", () => {
    render(<Probe />);
    expect(root.dataset.viewportPan).toBeUndefined();
    act(() => viewport.move({ offsetTop: 83 }));
    expect(root.dataset.viewportPan).toBe("on");
    expect(root.style.getPropertyValue("--viewport-pan-top")).toBe("83px");
    expect(root.style.getPropertyValue("--viewport-pan-height")).toBe("347px");
    act(() => viewport.move({ offsetTop: 0 }));
    expect(root.dataset.viewportPan).toBeUndefined();
    expect(root.style.getPropertyValue("--viewport-pan-top")).toBe("");
  });

  it("leaves a pinch zoom, an open keyboard and a focused field alone", () => {
    const view = render(<Probe />);
    act(() => viewport.move({ offsetTop: 40, scale: 2 }));
    expect(root.dataset.viewportPan).toBeUndefined();
    act(() => viewport.move({ offsetTop: 40, scale: 1 }));
    expect(root.dataset.viewportPan).toBe("on");
    root.dataset.keyboard = "open";
    act(() => viewport.move({ offsetTop: 41 }));
    expect(root.dataset.viewportPan).toBeUndefined();
    delete root.dataset.keyboard;
    view.getByLabelText("Time").focus();
    act(() => viewport.move({ offsetTop: 42 }));
    expect(root.dataset.viewportPan).toBeUndefined();
  });

  it("publishes a pan already present when it mounts, and clears on unmount", () => {
    viewport.offsetTop = 50;
    const view = render(<Probe />);
    expect(root.dataset.viewportPan).toBe("on");
    view.unmount();
    expect(root.dataset.viewportPan).toBeUndefined();
  });
});
