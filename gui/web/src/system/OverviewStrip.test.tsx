import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeResizeObserver, stubResizeObserver } from "../test/resizeObserver";
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
    expect(strip).toHaveAttribute("aria-valuetext", "0:50 of 3:20");
    expect(strip).toHaveAttribute("tabindex", "0");
  });

  it("reads whole seconds so the value does not churn every frame", () => {
    const { strip } = setup({ playhead: 0.123456, duration: 200.4 });
    expect(strip).toHaveAttribute("aria-valuenow", "25");
    expect(strip).toHaveAttribute("aria-valuemax", "200");
    expect(strip).toHaveAttribute("aria-valuetext", "0:25 of 3:20");
  });

  it("is a plain image when it could seek but has no duration yet", () => {
    render(
      <OverviewStrip
        height={64}
        label="Episode overview"
        duration={0}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByRole("img", { name: "Episode overview" })).toBeVisible();
    expect(screen.queryByRole("slider")).toBeNull();
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

describe("OverviewStrip touch box", () => {
  it("keeps the slider on the root and draws the strip in an inner face", () => {
    const { strip } = setup({ height: 16 });
    expect(strip).toHaveClass("sys-overview--16", "sys-overview--seek");
    const face = strip.querySelector(":scope > .sys-overview-face");
    expect(face).not.toBeNull();
    expect(face?.querySelector("svg")).not.toBeNull();
  });
});

describe("OverviewStrip bars", () => {
  afterEach(() => vi.unstubAllGlobals());

  const peaks = Array.from({ length: 512 }, (_, i) => (i === 300 ? 1 : 0.2));
  const bars = (view: HTMLElement) =>
    view.querySelectorAll("rect.sys-overview-peak");

  it("draws one bar per pixel of the strip, keeping the loudest of each run", () => {
    stubResizeObserver();
    const { container } = render(
      <OverviewStrip height={32} label="Episode overview" peaks={peaks} />,
    );
    expect(bars(container)).toHaveLength(512);
    const strip = container.querySelector(".sys-overview") as HTMLElement;
    act(() =>
      FakeResizeObserver.of(strip).fire(strip, {
        contentRect: { width: 100 } as DOMRectReadOnly,
      }),
    );
    const drawn = [...bars(container)];
    expect(drawn).toHaveLength(100);
    expect(
      Math.max(...drawn.map((bar) => Number(bar.getAttribute("height")))),
    ).toBe(1);
  });

  it("scales the view box, selection and ticks to the bars it drew", () => {
    stubResizeObserver();
    const { container } = render(
      <OverviewStrip
        height={32}
        label="Episode overview"
        peaks={peaks}
        selection={[0.5, 0.75]}
        ticks={[{ at: 0.25, kind: "chapter" }]}
      />,
    );
    const strip = container.querySelector(".sys-overview") as HTMLElement;
    act(() =>
      FakeResizeObserver.of(strip).fire(strip, {
        contentRect: { width: 100.6 } as DOMRectReadOnly,
      }),
    );
    expect(container.querySelector("svg")).toHaveAttribute(
      "viewBox",
      "0 0 101 1",
    );
    const selection = container.querySelector(".sys-overview-selection");
    expect(selection).toHaveAttribute("x", "50.5");
    expect(selection).toHaveAttribute("width", "25.25");
    expect(container.querySelector(".sys-overview-tick")).toHaveAttribute(
      "x1",
      "25.25",
    );
    expect(bars(container)).toHaveLength(101);
  });

  it("draws a flat line when there are no peaks", () => {
    const { container } = render(
      <OverviewStrip height={32} label="Episode overview" />,
    );
    const flat = bars(container);
    expect(flat).toHaveLength(1);
    expect(container.querySelector("svg")).toHaveAttribute(
      "viewBox",
      "0 0 1 1",
    );
  });

  it("keeps every column when the strip is wider than the peaks", () => {
    stubResizeObserver();
    const { container } = render(
      <OverviewStrip height={32} label="Episode overview" peaks={peaks} />,
    );
    const strip = container.querySelector(".sys-overview") as HTMLElement;
    act(() =>
      FakeResizeObserver.of(strip).fire(strip, {
        contentRect: { width: 900 } as DOMRectReadOnly,
      }),
    );
    expect(bars(container)).toHaveLength(512);
  });
});
