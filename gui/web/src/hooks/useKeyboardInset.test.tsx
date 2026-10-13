import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

class FakeViewport extends EventTarget {
  listeners = 0;
  addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listeners += 1;
    super.addEventListener(...args);
  }
  removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listeners -= 1;
    super.removeEventListener(...args);
  }
  height = 800;
  offsetTop = 0;
  scale = 1;
  move(next: Partial<Pick<FakeViewport, "height" | "offsetTop" | "scale">>) {
    Object.assign(this, next);
    this.dispatchEvent(new Event("resize"));
  }
}

function Probe({ on }: { on: boolean }) {
  useKeyboardInset(on);
  return (
    <div className="bottom-sheet">
      <input aria-label="Time" />
    </div>
  );
}

const root = document.documentElement;
let viewport: FakeViewport;

describe("useKeyboardInset", () => {
  beforeEach(() => {
    viewport = new FakeViewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "visualViewport");
  });

  it("publishes the keyboard's height and the visual top while it is up, and clears both when it goes", () => {
    const view = render(<Probe on />);
    expect(root.dataset.keyboard).toBeUndefined();
    act(() => viewport.move({ height: 480, offsetTop: 40 }));
    expect(root.dataset.keyboard).toBe("open");
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("280px");
    expect(root.style.getPropertyValue("--visual-viewport-top")).toBe("40px");
    act(() => viewport.move({ height: 800, offsetTop: 0 }));
    expect(root.dataset.keyboard).toBeUndefined();
    expect(root.style.getPropertyValue("--keyboard-inset")).toBe("");
    view.unmount();
  });

  it("does not mistake a pinch zoom for a keyboard", () => {
    render(<Probe on />);
    act(() => viewport.move({ height: 400, scale: 2 }));
    expect(root.dataset.keyboard).toBeUndefined();
  });

  it("reveals the focused field once the keyboard has shrunk the viewport", async () => {
    const { getByLabelText } = render(<Probe on />);
    const input = getByLabelText("Time");
    const scroller = input.closest<HTMLElement>(".bottom-sheet")!;
    scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 900 },
    });
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100);
    input.getBoundingClientRect = () =>
      new DOMRect(0, 300 - scroller.scrollTop, 100, 40);
    act(() => input.focus());
    act(() => viewport.move({ height: 480 }));
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
  });

  it("clears its published values on unmount and does nothing when disabled", () => {
    const view = render(<Probe on />);
    act(() => viewport.move({ height: 480 }));
    view.unmount();
    expect(root.dataset.keyboard).toBeUndefined();
    render(<Probe on={false} />);
    act(() => viewport.move({ height: 400 }));
    expect(root.dataset.keyboard).toBeUndefined();
  });

  describe("lifecycle", () => {
    afterEach(() => vi.restoreAllMocks());

    it("removes both visualViewport listeners and cancels its pending frame on unmount", () => {
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
      const cancel = vi
        .spyOn(window, "cancelAnimationFrame")
        .mockImplementation(() => undefined);
      const view = render(<Probe on />);
      expect(viewport.listeners).toBe(2);
      act(() => viewport.move({ height: 480 }));
      view.unmount();
      expect(viewport.listeners).toBe(0);
      expect(cancel).toHaveBeenCalledWith(7);
    });

    it("keeps at most one reveal frame pending however many viewport events arrive", () => {
      const frame = vi
        .spyOn(window, "requestAnimationFrame")
        .mockReturnValue(3);
      render(<Probe on />);
      act(() => viewport.move({ height: 480 }));
      act(() => viewport.move({ height: 470, offsetTop: 10 }));
      act(() => viewport.dispatchEvent(new Event("scroll")));
      expect(frame).toHaveBeenCalledTimes(1);
    });

    it("leaves the outer sheet's inset in place when a nested sheet unmounts", () => {
      function Nested({ inner }: { inner: boolean }) {
        return (
          <>
            <Probe on />
            {inner ? <Probe on /> : null}
          </>
        );
      }
      const view = render(<Nested inner />);
      act(() => viewport.move({ height: 480, offsetTop: 40 }));
      view.rerender(<Nested inner={false} />);
      expect(root.dataset.keyboard).toBe("open");
      expect(root.style.getPropertyValue("--keyboard-inset")).toBe("280px");
      expect(viewport.listeners).toBe(2);
      view.unmount();
      expect(root.dataset.keyboard).toBeUndefined();
      expect(viewport.listeners).toBe(0);
    });
  });
});
