import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  SelectionHandles,
  type SelectionHandlesProps,
} from "./SelectionHandles";

function setup(over: Partial<SelectionHandlesProps> = {}) {
  const handlers = {
    onDrag: vi.fn(),
    onGrab: vi.fn(),
    onRelease: vi.fn(),
  };
  const view = render(
    <div style={{ position: "relative" }}>
      <SelectionHandles
        start={{ x: 40, y: 10, height: 20 }}
        end={{ x: 200, y: 10, height: 20 }}
        {...handlers}
        {...over}
      />
    </div>,
  );
  return {
    ...handlers,
    ...view,
    start: view.container.querySelector<HTMLElement>(
      "[data-edge='start']",
    ) as HTMLElement,
    end: view.container.querySelector<HTMLElement>(
      "[data-edge='end']",
    ) as HTMLElement,
  };
}

describe("SelectionHandles", () => {
  it("is two pointer-only grips: hidden from assistive tech, no role, no tab stop, no keys", async () => {
    const { start, end, container, onDrag } = setup();
    for (const grip of [start, end]) {
      expect(grip).toHaveAttribute("aria-hidden", "true");
      expect(grip).not.toHaveAttribute("role");
      expect(grip).not.toHaveAttribute("tabindex");
    }
    expect(container.querySelector("[role=slider]")).toBeNull();
    expect(fireEvent.keyDown(start, { key: "ArrowRight" })).toBe(true);
    expect(onDrag).not.toHaveBeenCalled();
    await expectNoA11yViolations(container);
  });

  it("reports the point under the caret, not the finger, while it is held", () => {
    const { end, onDrag, onGrab, onRelease } = setup();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 10, clientY: 20 });
    expect(onGrab).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 30, clientY: 50 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 31, clientY: 51 });
    expect(onDrag.mock.calls).toEqual([
      ["end", { x: 20, y: 30 }],
      ["end", { x: 21, y: 31 }],
    ]);
    fireEvent.pointerUp(end, { pointerId: 1, clientX: 31, clientY: 51 });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("stops reporting on release or cancel and ignores another pointer or a right button", () => {
    const { start, onDrag } = setup();
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 5, clientY: 5 });
    fireEvent.pointerDown(start, {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      button: 2,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(start, { pointerId: 1, clientX: 5, clientY: 5 });
    expect(onDrag).not.toHaveBeenCalled();
    fireEvent.pointerDown(start, { pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(start, { pointerId: 3, clientX: 5, clientY: 5 });
    fireEvent.pointerMove(start, { pointerId: 2, clientX: 6, clientY: 7 });
    fireEvent.pointerUp(start, { pointerId: 2 });
    fireEvent.pointerMove(start, { pointerId: 2, clientX: 9, clientY: 9 });
    fireEvent.pointerDown(start, { pointerId: 4, clientX: 0, clientY: 0 });
    fireEvent.pointerCancel(start, { pointerId: 4 });
    fireEvent.pointerMove(start, { pointerId: 4, clientX: 9, clientY: 9 });
    expect(onDrag.mock.calls).toEqual([["start", { x: 6, y: 7 }]]);
  });

  it("passes a tap that never moves to the button under the point", () => {
    const word = document.createElement("button");
    const clicks: MouseEvent[] = [];
    word.addEventListener("click", (event) => clicks.push(event));
    const under = vi.fn(() => [document.body, word]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: under,
    });
    const { end, onDrag, onRelease } = setup();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 52, clientY: 61 });
    fireEvent.pointerUp(end, { pointerId: 1, clientX: 52, clientY: 61 });
    expect(under).toHaveBeenCalledWith(52, 61);
    expect(clicks).toHaveLength(1);
    expect(clicks[0].shiftKey).toBe(false);
    expect(onDrag).not.toHaveBeenCalled();
    expect(onRelease).toHaveBeenCalledTimes(1);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("replays the press's modifier keys on the tap it passes on, so a Shift-tap still extends", () => {
    const word = document.createElement("button");
    const clicks: MouseEvent[] = [];
    word.addEventListener("click", (event) => clicks.push(event));
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [word],
    });
    const { start } = setup();
    fireEvent.pointerDown(start, { pointerId: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerUp(start, {
      pointerId: 1,
      clientX: 50,
      clientY: 60,
      shiftKey: true,
      altKey: true,
    });
    expect(
      clicks.map(({ shiftKey, altKey, ctrlKey, metaKey }) => [
        shiftKey,
        altKey,
        ctrlKey,
        metaKey,
      ]),
    ).toEqual([[true, true, false, false]]);
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });

  it("ends the drag when the pointer capture is lost, once, and stops reporting", () => {
    const { end, onDrag, onRelease } = setup();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 30, clientY: 50 });
    fireEvent.lostPointerCapture(end, { pointerId: 1 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 60, clientY: 80 });
    fireEvent.pointerUp(end, { pointerId: 1, clientX: 60, clientY: 80 });
    expect(onDrag).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it("does not pass a drag, or a cancelled touch, on to the button under it", () => {
    const word = document.createElement("button");
    const click = vi.spyOn(word, "click");
    word.addEventListener("click", click);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: () => [word],
    });
    const { end } = setup();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.pointerUp(end, { pointerId: 1, clientX: 80, clientY: 60 });
    fireEvent.pointerDown(end, { pointerId: 2, clientX: 50, clientY: 60 });
    fireEvent.pointerCancel(end, { pointerId: 2, clientX: 50, clientY: 60 });
    expect(click).not.toHaveBeenCalled();
    delete (document as { elementsFromPoint?: unknown }).elementsFromPoint;
  });
});
