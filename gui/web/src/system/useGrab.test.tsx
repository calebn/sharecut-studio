import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { swallowsDuringDrag, useGrab } from "./useGrab";

function Part({
  states,
  axis,
}: {
  states: boolean[];
  axis?: "x" | "y" | "both";
}) {
  const grab = useGrab<"a">({
    axis,
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

describe("useGrab axis", () => {
  const dragged = (
    axis: "x" | "y" | "both" | undefined,
    to: [number, number],
  ) => {
    const states: boolean[] = [];
    const { unmount } = render(<Part states={states} axis={axis} />);
    const part = screen.getByRole("button");
    fireEvent.pointerDown(part, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(part, {
      pointerId: 1,
      clientX: to[0],
      clientY: to[1],
    });
    fireEvent.keyDown(part, { key: "Home" });
    unmount();
    return states[0];
  };

  it("measures the slop along x by default, along y, or from the press with both", () => {
    expect(dragged(undefined, [10, 60])).toBe(false);
    expect(dragged("y", [60, 10])).toBe(false);
    expect(dragged("y", [10, 60])).toBe(true);
    expect(dragged("both", [10, 60])).toBe(true);
    expect(dragged("both", [60, 10])).toBe(true);
    expect(dragged("both", [11, 11])).toBe(false);
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

describe("useGrab event time", () => {
  const stamped = (
    kind: "pointerDown" | "pointerMove" | "pointerUp",
    part: HTMLElement,
    clientY: number,
    timeStamp: number,
  ) => {
    const event = createEvent[kind](part, { pointerId: 1, clientY });
    Object.defineProperty(event, "timeStamp", { value: timeStamp });
    fireEvent(part, event);
  };

  function Timed({ seen }: { seen: [string, number][] }) {
    const grab = useGrab<"a">({
      axis: "y",
      canGrab: () => true,
      onStart: () => true,
      onMove: (_grip, _move, at) => seen.push(["move", at]),
      onEnd: (_grip, committed, at) =>
        seen.push([committed ? "end" : "abort", at]),
    });
    return (
      <button type="button" {...grab.handlers("a")}>
        part
      </button>
    );
  }

  it("hands onMove and onEnd the events' own timeStamp, not the time the handler ran", () => {
    const seen: [string, number][] = [];
    vi.spyOn(performance, "now").mockReturnValue(9000);
    render(<Timed seen={seen} />);
    const part = screen.getByRole("button");
    stamped("pointerDown", part, 0, 10);
    stamped("pointerMove", part, 20, 40);
    stamped("pointerMove", part, 60, 100);
    stamped("pointerUp", part, 60, 160);
    expect(seen).toEqual([
      ["move", 40],
      ["move", 100],
      ["end", 160],
    ]);
    vi.restoreAllMocks();
  });

  it("reads performance.now for an abort, which has no event", () => {
    const seen: [string, number][] = [];
    vi.spyOn(performance, "now").mockReturnValue(9000);
    render(<Timed seen={seen} />);
    const part = screen.getByRole("button");
    stamped("pointerDown", part, 0, 10);
    stamped("pointerMove", part, 20, 40);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(seen).toEqual([
      ["move", 40],
      ["abort", 9000],
    ]);
    vi.restoreAllMocks();
  });
});

describe("useGrab interruptions", () => {
  function Counted({ ends }: { ends: boolean[] }) {
    const grab = useGrab<"a">({
      canGrab: () => true,
      onStart: () => true,
      onMove: () => undefined,
      onEnd: (_grip, committed) => ends.push(committed),
    });
    return (
      <button type="button" {...grab.handlers("a")}>
        part
      </button>
    );
  }
  const grabbed = (ends: boolean[]) => {
    render(<Counted ends={ends} />);
    const part = screen.getByRole("button");
    fireEvent.pointerDown(part, { pointerId: 1, clientX: 10, clientY: 0 });
    fireEvent.pointerMove(part, { pointerId: 1, clientX: 40, clientY: 0 });
    return part;
  };

  it.each([
    ["blur", () => fireEvent.blur(window)],
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    [
      "the tab going hidden",
      () => {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      },
    ],
  ])(
    "cancels a moved drag on %s, once, and ignores the release",
    (_name, interrupt) => {
      const ends: boolean[] = [];
      const part = grabbed(ends);
      interrupt();
      fireEvent.pointerUp(part, { pointerId: 1, clientX: 40, clientY: 0 });
      expect(ends).toEqual([false]);
      vi.restoreAllMocks();
    },
  );

  it("keeps a drag going when the tab is only shown again", () => {
    const ends: boolean[] = [];
    const part = grabbed(ends);
    document.dispatchEvent(new Event("visibilitychange"));
    fireEvent.pointerUp(part, { pointerId: 1, clientX: 40, clientY: 0 });
    expect(ends).toEqual([true]);
  });
});
