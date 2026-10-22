import { readFileSync } from "node:fs";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let frames: FrameRequestCallback[] = [];

const flush = () =>
  act(() => {
    const due = frames;
    frames = [];
    for (const frame of due) frame(0);
  });

describe("useViewportPan", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    frames = [];
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((frame) => {
      frames.push(frame);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      frames = [];
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
    delete root.dataset.keyboard;
    delete root.dataset.viewportPan;
    root.style.removeProperty("--viewport-pan-top");
    root.style.removeProperty("--viewport-pan-height");
    vi.restoreAllMocks();
  });

  it("publishes a pan with nothing to explain it, and clears it when the viewport settles", () => {
    render(<Probe />);
    expect(root.dataset.viewportPan).toBeUndefined();
    act(() => viewport.move({ offsetTop: 83 }));
    flush();
    expect(root.dataset.viewportPan).toBe("on");
    expect(root.style.getPropertyValue("--viewport-pan-top")).toBe("83px");
    expect(root.style.getPropertyValue("--viewport-pan-height")).toBe("347px");
    act(() => viewport.move({ offsetTop: 0 }));
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
    expect(root.style.getPropertyValue("--viewport-pan-top")).toBe("");
  });

  it("leaves a pinch zoom, an open keyboard and a focused field alone", () => {
    const view = render(<Probe />);
    act(() => viewport.move({ offsetTop: 40, scale: 2 }));
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
    act(() => viewport.move({ offsetTop: 40, scale: 1 }));
    flush();
    expect(root.dataset.viewportPan).toBe("on");
    root.dataset.keyboard = "open";
    act(() => viewport.move({ offsetTop: 41 }));
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
    delete root.dataset.keyboard;
    view.getByLabelText("Time").focus();
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
  });

  it("reads the keyboard state after the keyboard hook has run, not before", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    root.dataset.keyboard = "open";
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
  });

  it("comes back when a field loses focus while the viewport is still panned", () => {
    const view = render(<Probe />);
    const field = view.getByLabelText("Time");
    field.focus();
    act(() => viewport.move({ offsetTop: 50 }));
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
    field.blur();
    flush();
    expect(root.dataset.viewportPan).toBe("on");
  });

  it("publishes a pan already present when it mounts, and clears on unmount", () => {
    viewport.offsetTop = 50;
    const view = render(<Probe />);
    expect(root.dataset.viewportPan).toBe("on");
    view.unmount();
    expect(root.dataset.viewportPan).toBeUndefined();
  });

  it("is applied to the fixed touch shells by layout.css", () => {
    const css = readFileSync("src/styles/partials/layout.css", "utf8");
    expect(css).toMatch(
      /html\[data-viewport-pan\]\[data-shell="phone"\] \.daw-shell[\s\S]*?inset-block: var\(--viewport-pan-top\) auto;[\s\S]*?block-size: var\(--viewport-pan-height\)/,
    );
  });
});
