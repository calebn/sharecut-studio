import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewStrip } from "./OverviewStrip";

function setup(over: Partial<Parameters<typeof OverviewStrip>[0]> = {}) {
  const onSeek = vi.fn();
  const view = render(
    <OverviewStrip
      height={64}
      label="Episode overview"
      playhead={0.25}
      duration={200}
      onSeek={onSeek}
      {...over}
    />,
  );
  const strip = screen.getByRole("slider", { name: "Episode overview" });
  vi.spyOn(strip, "getBoundingClientRect").mockReturnValue({
    left: 100,
    width: 400,
    right: 500,
    top: 0,
    bottom: 64,
    height: 64,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  });
  return { onSeek, strip, ...view };
}

describe("OverviewStrip seeking", () => {
  it("is a slider with the time as its text when it can seek", () => {
    const { strip } = setup();
    expect(strip).toHaveAttribute("aria-valuemin", "0");
    expect(strip).toHaveAttribute("aria-valuemax", "200");
    expect(strip).toHaveAttribute("aria-valuenow", "50");
    expect(strip).toHaveAttribute("aria-valuetext", "00:50.000");
    expect(strip).toHaveAttribute("tabindex", "0");
  });

  it("stays a plain image without onSeek", () => {
    render(<OverviewStrip height={48} label="Episode overview" />);
    expect(screen.getByRole("img", { name: "Episode overview" })).toBeVisible();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("seeks to the clicked ratio", () => {
    const { strip, onSeek } = setup();
    fireEvent.click(strip, { clientX: 300, detail: 1 });
    expect(onSeek.mock.calls).toEqual([[0.5]]);
  });

  it("seeks continuously while dragged and reads the release click as nothing", () => {
    const { strip, onSeek } = setup();
    fireEvent.pointerDown(strip, { pointerId: 1, clientX: 140 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(strip, { pointerId: 1, clientX: 400 });
    fireEvent.click(strip, { clientX: 400, detail: 1 });
    expect(onSeek.mock.calls).toEqual([[0.25], [0.75]]);
  });

  it("puts the playhead back where the drag started on Escape", () => {
    const { strip, onSeek } = setup();
    fireEvent.pointerDown(strip, { pointerId: 1, clientX: 200 });
    fireEvent.pointerMove(strip, { pointerId: 1, clientX: 400 });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerUp(strip, { pointerId: 1, clientX: 400 });
    expect(onSeek.mock.calls).toEqual([[0.75], [0.25]]);
  });

  it.each([
    ["ArrowRight", false, 0.255],
    ["ArrowLeft", false, 0.245],
    ["ArrowRight", true, 0.3],
    ["ArrowLeft", true, 0.2],
    ["Home", false, 0],
    ["End", false, 1],
  ])("seeks on %s (shift %s) to %s", (key, shiftKey, fraction) => {
    const { strip, onSeek } = setup();
    fireEvent.keyDown(strip, { key, shiftKey });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0]?.[0]).toBeCloseTo(fraction, 6);
  });
});
