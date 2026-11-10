import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { OverviewStrip } from "./OverviewStrip";
import { snapToTick } from "./overviewSnap";

const TICKS = [
  { at: 0.25, kind: "comment" as const },
  { at: 0.75, kind: "suggestion" as const },
];

function sized(strip: HTMLElement) {
  strip.getBoundingClientRect = () =>
    ({ left: 100, width: 200, top: 0, height: 16 }) as DOMRect;
}

describe("snapToTick", () => {
  it("snaps to the nearest tick inside the tolerance and otherwise keeps the fraction", () => {
    expect(snapToTick(0.27, TICKS, 0.05)).toBe(0.25);
    expect(snapToTick(0.5, TICKS, 0.05)).toBe(0.5);
    expect(snapToTick(0.5, [], 0.05)).toBe(0.5);
  });
});

describe("OverviewStrip seeking", () => {
  it("stays a static image without onSeek", async () => {
    const { container } = render(
      <OverviewStrip height={16} label="Episode overview" ticks={TICKS} />,
    );
    expect(screen.getByRole("img", { name: "Episode overview" })).toBeVisible();
    expect(screen.queryByRole("slider")).toBeNull();
    await expectNoA11yViolations(container);
  });

  it("seeks to the tapped fraction, snapping to a tick under the finger", async () => {
    const onSeek = vi.fn();
    const { container } = render(
      <OverviewStrip
        height={16}
        label="Episode overview"
        ticks={TICKS}
        playhead={0.5}
        valueText="0:30 of 1:00"
        onSeek={onSeek}
      />,
    );
    const strip = screen.getByRole("slider", { name: "Episode overview" });
    sized(strip);
    expect(strip).toHaveAttribute("aria-valuenow", "50");
    expect(strip).toHaveAttribute("aria-valuetext", "0:30 of 1:00");
    fireEvent.pointerDown(strip, { clientX: 200, button: 0, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0.5);
    fireEvent.pointerDown(strip, { clientX: 152, button: 0, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0.25);
    await expectNoA11yViolations(container);
  });

  it("follows a drag without snapping and stops after release", () => {
    const onSeek = vi.fn();
    render(
      <OverviewStrip height={32} label="Episode overview" onSeek={onSeek} />,
    );
    const strip = screen.getByRole("slider", { name: "Episode overview" });
    sized(strip);
    fireEvent.pointerMove(strip, { clientX: 150 });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerDown(strip, { clientX: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 250, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0.75);
    fireEvent.pointerMove(strip, { clientX: 900, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(1);
    fireEvent.pointerUp(strip, { pointerId: 1 });
    onSeek.mockClear();
    fireEvent.pointerMove(strip, { clientX: 150, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("seeks from the keyboard and keeps the keys from the keymap", () => {
    const onSeek = vi.fn();
    render(
      <OverviewStrip
        height={16}
        label="Episode overview"
        playhead={0.5}
        onSeek={onSeek}
      />,
    );
    const strip = screen.getByRole("slider", { name: "Episode overview" });
    const keys: [string, boolean, number][] = [
      ["ArrowRight", false, 0.51],
      ["ArrowLeft", true, 0.4],
      ["PageUp", false, 0.6],
      ["PageDown", false, 0.4],
      ["Home", false, 0],
      ["End", false, 1],
    ];
    for (const [key, shiftKey, expected] of keys) {
      fireEvent.keyDown(strip, { key, shiftKey });
      expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(expected, 5));
    }
    onSeek.mockClear();
    fireEvent.keyDown(strip, { key: "a" });
    expect(onSeek).not.toHaveBeenCalled();
  });
});
