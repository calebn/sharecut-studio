import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dragInterrupts,
  pageRotations,
  resetViewport,
  trackInterruptSignals,
} from "../test/pageInterrupts";
import { SuggestionWaveform } from "./SuggestionWaveform";

const peaks = Array.from({ length: 120 }, (_, i) =>
  i >= 58 && i <= 62 ? 0.02 : 0.8,
);

function setup(extra: { readOnly?: boolean } = {}) {
  const onAdjust = vi.fn();
  const onAdjustStart = vi.fn();
  const view = render(
    <SuggestionWaveform
      icon="scissors"
      peaks={peaks}
      windowStart={100}
      start={103}
      end={105}
      onAdjust={onAdjust}
      onAdjustStart={onAdjustStart}
      {...extra}
    />,
  );
  const track = view.container.querySelector(".sys-wave") as HTMLElement;
  track.getBoundingClientRect = () =>
    ({ left: 0, width: 1200, top: 0, height: 96 }) as DOMRect;
  return { onAdjust, onAdjustStart, track };
}

const end = () => screen.getByRole("slider", { name: "End of the change" });
const drag = (clientX: number, altKey = false) => {
  fireEvent.pointerDown(end(), { clientX: 700, pointerId: 1 });
  fireEvent.pointerMove(end(), { clientX, pointerId: 1, altKey });
  fireEvent.pointerUp(end(), { pointerId: 1 });
};

describe("SuggestionWaveform", () => {
  it("is 12 s wide and positions handles by time", () => {
    setup();
    expect(end()).toHaveAttribute("aria-valuemin", "100");
    expect(end()).toHaveAttribute("aria-valuemax", "112");
    const position = end().style.insetInlineStart;
    expect(position).toMatch(/^\d+(?:\.\d+)?%$/);
    expect(Number(position.slice(0, -1))).toBeCloseTo((5 / 12) * 100, 4);
  });

  it("does not start an adjustment on a tap", () => {
    const { onAdjust, onAdjustStart } = setup();
    fireEvent.pointerDown(end(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(end(), { pointerId: 1 });
    expect(onAdjustStart).not.toHaveBeenCalled();
    expect(onAdjust).not.toHaveBeenCalled();
  });

  it("snaps a dragged handle to the nearest silence", () => {
    const { onAdjust, onAdjustStart } = setup();
    drag(610);
    expect(onAdjustStart).toHaveBeenCalledOnce();
    const range = onAdjust.mock.lastCall?.[0];
    expect(range.start).toBe(103);
    expect(range.end).toBeCloseTo(106.05, 2);
  });

  it("moves freely while Alt is held", () => {
    const { onAdjust } = setup();
    drag(610, true);
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(106.1, 5);
  });

  it("keeps the handle inside the window", () => {
    const { onAdjust } = setup();
    drag(5000, true);
    expect(onAdjust.mock.lastCall?.[0].end).toBe(112);
  });

  it("moves with the arrow keys, 0.5 s with Shift", () => {
    const { onAdjust } = setup();
    fireEvent.keyDown(end(), { key: "ArrowRight" });
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(105.05);
    fireEvent.keyDown(end(), { key: "ArrowLeft", shiftKey: true });
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(104.5);
  });

  it("jumps with Home, End and the page keys", () => {
    const { onAdjust } = setup();
    fireEvent.keyDown(end(), { key: "PageUp" });
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(106);
    fireEvent.keyDown(end(), { key: "PageDown" });
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(104);
    fireEvent.keyDown(end(), { key: "End" });
    expect(onAdjust.mock.lastCall?.[0].end).toBe(112);
    fireEvent.keyDown(end(), { key: "Home" });
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(103.1);
  });

  it("never lets the edges cross", () => {
    const { onAdjust } = setup();
    drag(0, true);
    expect(onAdjust.mock.lastCall?.[0].end).toBeCloseTo(103.1);
  });

  it("does nothing for a guest", () => {
    const { onAdjust, onAdjustStart } = setup({ readOnly: true });
    drag(900);
    fireEvent.keyDown(end(), { key: "ArrowRight" });
    expect(onAdjust).not.toHaveBeenCalled();
    expect(onAdjustStart).not.toHaveBeenCalled();
  });
});

describe("SuggestionWaveform and a page interrupt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetViewport();
  });

  const hold = (before?: () => void) => {
    const view = setup();
    before?.();
    fireEvent.pointerDown(end(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerMove(end(), { clientX: 610, pointerId: 1 });
    return view;
  };

  it.each(Object.entries(dragInterrupts))(
    "%s puts the range back where the press found it, and a later release adjusts nothing",
    (_name, interrupt) => {
      const { onAdjust } = hold();
      expect(onAdjust).toHaveBeenCalledOnce();
      expect(onAdjust.mock.lastCall?.[0].end).not.toBe(105);
      interrupt();
      expect(onAdjust).toHaveBeenCalledTimes(2);
      expect(onAdjust.mock.lastCall?.[0]).toEqual({ start: 103, end: 105 });
      fireEvent.pointerMove(end(), { clientX: 650, pointerId: 1 });
      fireEvent.pointerUp(end(), { pointerId: 1 });
      expect(onAdjust).toHaveBeenCalledTimes(2);
    },
  );

  it("adjusts nothing for a press that never moved", () => {
    const { onAdjust, onAdjustStart } = setup();
    fireEvent.pointerDown(end(), { clientX: 700, pointerId: 1 });
    dragInterrupts.blur();
    expect(onAdjust).not.toHaveBeenCalled();
    expect(onAdjustStart).not.toHaveBeenCalled();
  });

  it("keeps the drag through a height-only resize", () => {
    const { onAdjust } = hold();
    pageRotations.heightResize();
    expect(onAdjust).toHaveBeenCalledOnce();
  });

  it("leaves the dragged range on a normal release and no live listeners", () => {
    const tracked = trackInterruptSignals();
    let idle = -1;
    const { onAdjust } = hold(() => {
      idle = tracked.live();
    });
    expect(tracked.live()).toBeGreaterThan(idle);
    fireEvent.pointerUp(end(), { pointerId: 1 });
    expect(tracked.live()).toBe(idle);
    dragInterrupts.blur();
    expect(onAdjust).toHaveBeenCalledOnce();
  });
});
