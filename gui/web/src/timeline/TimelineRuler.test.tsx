import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useDawKeymapListener } from "../keymap/listener";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import { TimelineRuler } from "./TimelineRuler";

const sliderName = { name: "Timeline position" };

function Ruler({
  sessionSec = 9,
  zoomPxPerSec = 40,
  canvasWidthPx = sessionSec * zoomPxPerSec,
  viewportPx = 360,
  fixedPlayhead = false,
  onSeek = vi.fn(),
  onFit = vi.fn(),
}: Partial<React.ComponentProps<typeof TimelineRuler>>) {
  return (
    <TimelineRuler
      canvasWidthPx={canvasWidthPx}
      viewportPx={viewportPx}
      sessionSec={sessionSec}
      zoomPxPerSec={zoomPxPerSec}
      fixedPlayhead={fixedPlayhead}
      onSeek={onSeek}
      onFit={onFit}
    />
  );
}

const ticks = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>(".sys-ruler-tick"),
];

afterEach(() => {
  useDawStore.setState({
    scrollLeft: 0,
    playheadSec: 0,
    isPlaying: false,
    zoomPxPerSec: 40,
  });
});

describe("TimelineRuler", () => {
  it("draws the window the lanes show: ticks from the scroll, at the canvas x", () => {
    // 60 s at 48,000 px/s: 2.88M px of canvas, 2 ms ticks 96 px apart.
    useDawStore.setState({ scrollLeft: 1_000_000 });
    const { container } = render(
      <Ruler
        sessionSec={60}
        zoomPxPerSec={48_000}
        canvasWidthPx={2_880_000}
        viewportPx={1200}
      />,
    );
    const shown = ticks(container).filter((tick) => tick.textContent);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(Math.ceil((1200 + 64) / 64) + 1);
    for (const tick of shown) {
      expect(tick.textContent).toMatch(/^\d+:\d{2}\.\d{3}$/);
      const x = Number.parseFloat(tick.style.getPropertyValue("--sys-ruler-x"));
      const seconds = (1_000_000 + x) / 48_000;
      expect(seconds * 48_000).toBeGreaterThanOrEqual(1_000_000 - 64);
      expect(x).toBeLessThanOrEqual(1200);
    }
    expect(screen.getByRole("slider", sliderName)).toHaveAttribute(
      "aria-valuetext",
      "0:00.000",
    );
    act(() => useDawStore.setState({ scrollLeft: 2_000_000 }));
    const moved = ticks(container).filter((tick) => tick.textContent);
    expect(moved[0]?.textContent).not.toBe(shown[0]?.textContent);
  });

  it("holds the window inside the canvas where the sticky row rests", () => {
    useDawStore.setState({ scrollLeft: 5_000 });
    const { container } = render(
      <Ruler sessionSec={9} zoomPxPerSec={40} viewportPx={200} />,
    );
    // 360 px of canvas, 200 px window: it starts 160 px in, at 4 s.
    const labels = ticks(container).map((tick) => tick.textContent);
    expect(labels).toContain("0:08");
    expect(labels).not.toContain("0:02");
    // Before time 0 (a phone's lead pad) it starts at 0.
    act(() => useDawStore.setState({ scrollLeft: -300 }));
    expect(ticks(container).map((tick) => tick.textContent)).toContain("0:00");
  });

  it("is as wide as the viewport, and never wider than the canvas", () => {
    const { container, rerender } = render(<Ruler viewportPx={200} />);
    const ruler = () => container.querySelector<HTMLElement>(".sys-ruler");
    expect(ruler()?.style.getPropertyValue("--sys-ruler-width")).toBe("200px");
    rerender(<Ruler viewportPx={900} canvasWidthPx={360} />);
    expect(ruler()?.style.getPropertyValue("--sys-ruler-width")).toBe("360px");
  });

  it("reads its value from the store, in quarter seconds while playing", () => {
    useDawStore.setState({ playheadSec: 3.3, isPlaying: false });
    render(<Ruler />);
    const slider = screen.getByRole("slider", sliderName);
    expect(slider).toHaveAttribute("aria-valuenow", "3.3");
    act(() => useDawStore.setState({ isPlaying: true, playheadSec: 3.6 }));
    expect(slider).toHaveAttribute("aria-valuenow", "3.5");
    act(() => useDawStore.setState({ playheadSec: 3.7 }));
    expect(slider).toHaveAttribute("aria-valuenow", "3.75");
  });

  it("announces the nearest quarter second during playback, not the one below", () => {
    useDawStore.setState({ playheadSec: 0.7, isPlaying: true });
    render(<Ruler zoomPxPerSec={400} canvasWidthPx={3600} />);
    const slider = screen.getByRole("slider", sliderName);
    expect(slider).toHaveAttribute("aria-valuenow", "0.75");
    expect(slider).toHaveAttribute("aria-valuetext", "0:00.8");
  });

  it("ends at the session, not at the canvas padding", () => {
    render(<Ruler sessionSec={8} canvasWidthPx={9 * 40} />);
    expect(screen.getByRole("slider", sliderName)).toHaveAttribute(
      "aria-valuemax",
      "8",
    );
  });

  it("seeks on a click and on a scrub, and a cancelled scrub puts the playhead back", () => {
    useDawStore.setState({ playheadSec: 2 });
    const onSeek = vi.fn();
    render(<Ruler onSeek={onSeek} />);
    const body = screen.getByRole("slider", sliderName);
    fireEvent.click(body, { clientX: 80 });
    expect(onSeek).toHaveBeenLastCalledWith(2);
    onSeek.mockClear();
    fireEvent.pointerDown(body, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 40,
    });
    fireEvent.pointerMove(body, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 120,
    });
    expect(onSeek).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onSeek).toHaveBeenLastCalledWith(2);
  });

  it("fits on a double-click", () => {
    const onFit = vi.fn();
    render(<Ruler onFit={onFit} />);
    fireEvent.doubleClick(screen.getByRole("slider", sliderName));
    expect(onFit).toHaveBeenCalledTimes(1);
  });

  it("draws its needle as the store-driven Playhead, and none on the phone", () => {
    useDawStore.setState({ playheadSec: 1.5, zoomPxPerSec: 40 });
    const { container, rerender } = render(<Ruler />);
    expect(container.querySelector(".timeline-ruler .playhead")).toHaveStyle({
      transform: "translateX(60px)",
    });
    expect(container.querySelector(".sys-ruler-playhead")).toBeNull();
    rerender(<Ruler fixedPlayhead />);
    expect(container.querySelector(".playhead")).toBeNull();
    expect(container.querySelector(".sys-ruler-playhead")).toBeNull();
  });

  it("has no a11y violations", async () => {
    const { container } = render(<Ruler />);
    await expectNoA11yViolations(container);
  });
});

function Connected() {
  useDawKeymapListener();
  return (
    <TimelineRuler
      canvasWidthPx={1000}
      viewportPx={1000}
      sessionSec={60}
      zoomPxPerSec={5}
      fixedPlayhead={false}
      onSeek={useDawStore.getState().setPlayheadSec}
      onFit={vi.fn()}
    />
  );
}

it("owns ruler steps while preserving the real global arrow command elsewhere", async () => {
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate("/tmp/ruler-keys", minimalProject());
  const { unmount } = render(<Connected />);
  try {
    const slider = screen.getByRole("slider", sliderName);
    fireEvent.keyDown(slider, { key: "Home", code: "Home" });
    fireEvent.keyDown(slider, { key: "ArrowRight", code: "ArrowRight" });
    const step = useDawStore.getState().playheadSec;
    expect(step).toBeGreaterThan(1);
    fireEvent.keyDown(slider, { key: "ArrowLeft", code: "ArrowLeft" });
    expect(useDawStore.getState().playheadSec).toBe(0);
    fireEvent.keyDown(slider, { key: "End", code: "End" });
    expect(useDawStore.getState().playheadSec).toBe(60);
    act(() => useDawStore.getState().setPlayheadSec(0));
    fireEvent.keyDown(document.body, { key: "ArrowRight", code: "ArrowRight" });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useDawStore.getState().playheadSec).toBe(1);
  } finally {
    unmount();
    clearRegisteredCommands();
  }
});
