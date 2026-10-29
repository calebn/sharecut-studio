import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { swallowsDuringDrag, useGrab } from "./useGrab";

function Part({ states }: { states: boolean[] }) {
  const grab = useGrab<"a">({
    canGrab: () => true,
    onStart: () => true,
    onMove: () => undefined,
    onEnd: () => undefined,
  });
  return (
    <button
      type="button"
      {...grab.handlers("a")}
      onKeyDown={() => states.push(grab.dragging())}
    >
      part
    </button>
  );
}

describe("useGrab.dragging", () => {
  it("is false before the slop, true while moving, and false again after the end or a cancel", () => {
    const states: boolean[] = [];
    render(<Part states={states} />);
    const part = screen.getByRole("button");
    const key = () => fireEvent.keyDown(part, { key: "Home" });
    fireEvent.pointerDown(part, { pointerId: 1, clientX: 10, clientY: 0 });
    key();
    fireEvent.pointerMove(part, { pointerId: 1, clientX: 11, clientY: 0 });
    key();
    fireEvent.pointerMove(part, { pointerId: 1, clientX: 40, clientY: 0 });
    key();
    fireEvent.pointerUp(part, { pointerId: 1, clientX: 40, clientY: 0 });
    key();
    fireEvent.pointerDown(part, { pointerId: 2, clientX: 10, clientY: 0 });
    fireEvent.pointerMove(part, { pointerId: 2, clientX: 40, clientY: 0 });
    key();
    fireEvent.pointerCancel(part, { pointerId: 2 });
    key();
    expect(states).toEqual([false, false, true, false, true, false]);
  });
});

describe("swallowsDuringDrag", () => {
  const key = (name: string, over = {}) => ({
    key: name,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...over,
  });

  it("swallows the nudge and select keys, and lets Escape, Alt chords and modifiers through", () => {
    for (const name of [
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "Enter",
      " ",
    ]) {
      expect(swallowsDuringDrag(key(name))).toBe(true);
      expect(swallowsDuringDrag(key(name, { altKey: true }))).toBe(false);
      expect(swallowsDuringDrag(key(name, { ctrlKey: true }))).toBe(false);
      expect(swallowsDuringDrag(key(name, { metaKey: true }))).toBe(false);
    }
    for (const name of ["Escape", "Tab", "a"]) {
      expect(swallowsDuringDrag(key(name))).toBe(false);
    }
  });
});
