import { act, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
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
  const windowLeft = (container: HTMLElement) =>
    Number.parseFloat(
      container.querySelector<HTMLElement>(".timeline-ruler-window")?.style
        .insetInlineStart ?? "NaN",
    );

  it("draws a chunk of the canvas around the viewport, each tick at its canvas x", () => {
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
    // The chunk is one viewport (1200 px): scroll 1,000,000 is in the chunk from 999,600, and the window starts a viewport before it.
    expect(windowLeft(container)).toBe(998_400);
    expect(
      container
        .querySelector<HTMLElement>(".sys-ruler")
        ?.style.getPropertyValue("--sys-ruler-width"),
    ).toBe("4800px");
    const shown = ticks(container).filter((tick) => tick.textContent);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThanOrEqual(Math.ceil((4800 + 64) / 64) + 1);
    for (const tick of shown) {
      expect(tick.textContent).toMatch(/^\d+:\d{2}\.\d{3}$/);
      const x = Number.parseFloat(tick.style.getPropertyValue("--sys-ruler-x"));
      const canvasX = windowLeft(container) + x;
      expect(canvasX).toBeGreaterThanOrEqual(998_400 - 64);
      expect(canvasX).toBeLessThanOrEqual(1_003_200);
      // The label names the time its canvas x is (to the label's millisecond), and the tick sits on the step grid.
      const [minutes, secs] = (tick.textContent ?? "0:0").split(":");
      const seconds = Number(minutes) * 60 + Number(secs);
      expect(Math.abs(canvasX - seconds * 48_000)).toBeLessThanOrEqual(24);
      expect(Math.abs(canvasX / 96 - Math.round(canvasX / 96))).toBeLessThan(
        1e-6,
      );
    }
    expect(screen.getByRole("slider", sliderName)).toHaveAttribute(
      "aria-valuetext",
      "0:00.000",
    );
    act(() => useDawStore.setState({ scrollLeft: 2_000_000 }));
    const moved = ticks(container).filter((tick) => tick.textContent);
    expect(moved[0]?.textContent).not.toBe(shown[0]?.textContent);
  });

  it("re-renders only when the scroll crosses into another chunk, not on every scroll frame", () => {
    useDawStore.setState({ scrollLeft: 3_000 });
    let commits = 0;
    const { container } = render(
      <Profiler id="ruler" onRender={() => commits++}>
        <Ruler
          sessionSec={60}
          zoomPxPerSec={48_000}
          canvasWidthPx={2_880_000}
          viewportPx={1200}
        />
      </Profiler>,
    );
    const first = commits;
    const left = windowLeft(container);
    for (let scrollLeft = 3_001; scrollLeft < 3_590; scrollLeft += 7) {
      act(() => useDawStore.setState({ scrollLeft }));
    }
    expect(commits).toBe(first);
    expect(windowLeft(container)).toBe(left);
    // The chunk is one viewport (1200 px): 3,000 is in the chunk from 2,400, and 3,700 in the one from 3,600.
    act(() => useDawStore.setState({ scrollLeft: 3_700 }));
    expect(commits).toBe(first + 1);
    expect(windowLeft(container)).toBe(left + 1200);
  });

  it("covers the visible row after a jump of up to one viewport in a single update, either way", () => {
    const viewportPx = 1200;
    const { container } = render(
      <Ruler
        sessionSec={60}
        zoomPxPerSec={48_000}
        canvasWidthPx={2_880_000}
        viewportPx={viewportPx}
      />,
    );
    const covered = (from: number, to: number) => {
      const left = windowLeft(container);
      const width = Number.parseFloat(
        container
          .querySelector<HTMLElement>(".sys-ruler")
          ?.style.getPropertyValue("--sys-ruler-width") ?? "NaN",
      );
      return left <= from && left + width >= to;
    };
    // The start, middle and last px of a chunk: the worst cases for the margin ahead.
    for (const scroll of [1_000_800, 1_001_000, 1_001_399]) {
      for (const jump of [viewportPx, -viewportPx]) {
        act(() => useDawStore.setState({ scrollLeft: scroll }));
        // Before the host sees the jump, the window drawn for `scroll` already covers where it lands.
        const target = scroll + jump;
        expect(covered(target, target + viewportPx)).toBe(true);
        act(() => useDawStore.setState({ scrollLeft: target }));
        expect(covered(target, target + viewportPx)).toBe(true);
      }
    }
  });

  it("holds the window inside the canvas, even when the scroll runs past it", () => {
    useDawStore.setState({ scrollLeft: 5_000 });
    const { container } = render(
      <Ruler sessionSec={9} zoomPxPerSec={40} viewportPx={200} />,
    );
    // 360 px of canvas, 200 px viewport: the last chunk shows 4 s to the end.
    const labels = ticks(container).map((tick) => tick.textContent);
    expect(windowLeft(container)).toBeGreaterThanOrEqual(0);
    expect(labels).toContain("0:08");
    // Before time 0 (a phone's lead pad) it starts at 0.
    act(() => useDawStore.setState({ scrollLeft: -300 }));
    expect(windowLeft(container)).toBe(0);
    expect(ticks(container).map((tick) => tick.textContent)).toContain("0:00");
  });

  it("is a few viewports wide, and never wider than the canvas", () => {
    const { container, rerender } = render(
      <Ruler viewportPx={200} canvasWidthPx={2000} sessionSec={50} />,
    );
    const ruler = () => container.querySelector<HTMLElement>(".sys-ruler");
    expect(ruler()?.style.getPropertyValue("--sys-ruler-width")).toBe("600px");
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
