import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import {
  SelectionHandles,
  type SelectionHandlesProps,
} from "./SelectionHandles";

function setup(over: Partial<SelectionHandlesProps> = {}) {
  const handlers = { onDrag: vi.fn(), onStep: vi.fn() };
  const view = render(
    <div style={{ position: "relative" }}>
      <SelectionHandles
        start={{ x: 40, y: 10, height: 20 }}
        end={{ x: 200, y: 10, height: 20 }}
        startAt={13}
        endAt={15}
        count={54}
        startText="before small"
        endText="after can"
        {...handlers}
        {...over}
      />
    </div>,
  );
  return {
    ...handlers,
    ...view,
    start: screen.getByRole("slider", { name: "Selection start" }),
    end: screen.getByRole("slider", { name: "Selection end" }),
  };
}

describe("SelectionHandles", () => {
  it("is two sliders over the places the keyboard stops, off the tab order", async () => {
    const { start, end, container } = setup();
    expect(
      [start, end].map((h) => [
        h.getAttribute("aria-valuemin"),
        h.getAttribute("aria-valuenow"),
        h.getAttribute("aria-valuemax"),
        h.getAttribute("aria-valuetext"),
        h.getAttribute("tabindex"),
        h.getAttribute("data-edge"),
      ]),
    ).toEqual([
      ["1", "13", "54", "before small", "-1", "start"],
      ["1", "15", "54", "after can", "-1", "end"],
    ]);
    await expectNoA11yViolations(container);
  });

  it("steps an edge with the slider keys, forward and up one on, back and down one back", async () => {
    const user = userEvent.setup();
    const { start, end, onStep } = setup();
    start.focus();
    await user.keyboard(
      "{ArrowRight}{ArrowUp}{ArrowLeft}{ArrowDown}{Home}{End}",
    );
    end.focus();
    await user.keyboard("{ArrowRight}{Home}");
    expect(onStep.mock.calls).toEqual([
      ["start", 1],
      ["start", 1],
      ["start", -1],
      ["start", -1],
      ["start", "first"],
      ["start", "last"],
      ["end", 1],
      ["end", "first"],
    ]);
  });

  it("leaves other keys and modified arrows to the page", () => {
    const { start, onStep } = setup();
    expect(fireEvent.keyDown(start, { key: "a" })).toBe(true);
    expect(fireEvent.keyDown(start, { key: "ArrowLeft", altKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(start, { key: "ArrowLeft", metaKey: true })).toBe(
      true,
    );
    expect(onStep).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(start, { key: "ArrowLeft" })).toBe(false);
  });

  it("reports the point under the caret, not the finger, while it is held", () => {
    const { end, onDrag } = setup();
    fireEvent.pointerDown(end, { pointerId: 1, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 30, clientY: 50 });
    fireEvent.pointerMove(end, { pointerId: 1, clientX: 31, clientY: 51 });
    expect(onDrag.mock.calls).toEqual([
      ["end", { x: 20, y: 30 }],
      ["end", { x: 21, y: 31 }],
    ]);
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
});
