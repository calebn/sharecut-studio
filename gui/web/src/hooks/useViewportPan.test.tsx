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

let clock = 0;

const flush = (step = 16) =>
  act(() => {
    clock += step;
    const due = frames;
    frames = [];
    for (const frame of due) frame(clock);
  });

const fire = (target: EventTarget, type: string) =>
  act(() => {
    target.dispatchEvent(new Event(type));
  });

describe("useViewportPan", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    frames = [];
    clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
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

  it("clears a pan that ended with no event in the frame it ended", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    flush();
    expect(root.dataset.viewportPan).toBe("on");
    viewport.offsetTop = 0;
    flush();
    expect(root.dataset.viewportPan).toBeUndefined();
  });

  it("engages a pan that appears with no event shortly after a resize", () => {
    render(<Probe />);
    fire(viewport, "resize");
    for (let frame = 0; frame < 20; frame++) flush();
    expect(root.dataset.viewportPan).toBeUndefined();
    viewport.offsetTop = 70;
    flush();
    expect(root.dataset.viewportPan).toBe("on");
    expect(root.style.getPropertyValue("--viewport-pan-top")).toBe("70px");
  });

  it("watches after an orientation change, a click or a tab coming back, not only after viewport events", () => {
    render(<Probe />);
    for (const [target, type] of [
      [window, "orientationchange"],
      [window, "resize"],
      [document, "visibilitychange"],
      [document, "pointerup"],
    ] as const) {
      for (let frame = 0; frame < 200; frame++) flush();
      expect(frames).toHaveLength(0);
      fire(target, type);
      expect(frames).toHaveLength(1);
    }
  });

  it("stops watching once the settle window has passed and nothing is panned", () => {
    render(<Probe />);
    fire(viewport, "resize");
    flush();
    expect(frames).toHaveLength(1);
    flush(1600);
    expect(frames).toHaveLength(0);
  });

  it("keeps watching for as long as a pan is engaged", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    flush();
    for (let frame = 0; frame < 400; frame++) flush();
    expect(frames).toHaveLength(1);
    expect(root.dataset.viewportPan).toBe("on");
  });

  it("does not rewrite the published values while they are unchanged", () => {
    render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    flush();
    const set = vi.spyOn(root.style, "setProperty");
    flush();
    flush();
    expect(set).not.toHaveBeenCalled();
  });

  it("queues one frame however many triggers arrive", () => {
    render(<Probe />);
    act(() => {
      for (let i = 0; i < 100; i++)
        document.dispatchEvent(new Event("focusin"));
    });
    expect(frames).toHaveLength(1);
  });

  it("cancels its pending frame and listeners on unmount", () => {
    const view = render(<Probe />);
    act(() => viewport.move({ offsetTop: 83 }));
    view.unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(root.dataset.viewportPan).toBeUndefined();
    fire(document, "pointerup");
    expect(frames).toHaveLength(0);
  });

  it("does nothing, and asks for no frame, when there is no visual viewport", () => {
    Reflect.deleteProperty(window, "visualViewport");
    render(<Probe />);
    fire(document, "pointerup");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("is applied to the fixed touch frames by stage-frame.css", () => {
    const css = readFileSync("src/styles/partials/stage-frame.css", "utf8");
    expect(css).toMatch(
      /html\[data-viewport-pan\]\[data-shell="phone"\] \.stage-frame[\s\S]*?inset-block: var\(--viewport-pan-top\) auto;[\s\S]*?block-size: var\(--viewport-pan-height\)/,
    );
  });
});
