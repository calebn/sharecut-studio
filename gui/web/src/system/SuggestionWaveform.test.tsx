import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SuggestionWaveform } from "./SuggestionWaveform";

const peaks = Array.from({ length: 120 }, (_, i) =>
  i >= 58 && i <= 62 ? 0.02 : 0.8,
);

function setup(extra: { readOnly?: boolean } = {}) {
  const onAdjust = vi.fn();
  const onAdjustStart = vi.fn();
  const view = render(
    <SuggestionWaveform
      kind="filler"
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
    expect(end().style.insetInlineStart).toBe(`${(5 / 12) * 100}%`);
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
