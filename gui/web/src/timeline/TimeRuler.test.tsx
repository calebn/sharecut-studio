import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { PlayheadNeedle } from "./PlayheadNeedle";
import { TimeRuler } from "./TimeRuler";
import { TimeRulerView } from "./TimeRulerView";

describe("TimeRuler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips the colliding end label on a narrow touch timeline", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
    }));
    const { container } = render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        onSeek={vi.fn()}
      />,
    );
    const labels = [...container.querySelectorAll(".ruler-tick")].map(
      (el) => el.textContent,
    );
    // 0:08 would collide with 0:06, so it is skipped.
    expect(labels).not.toContain("0:08");
    expect(labels).toContain("0:06");
  });

  it("keeps the end label on desktop where labels fit", () => {
    // No matchMedia stub: fine pointer, tight estimate (34 px), no drop.
    // At 47 px/s the 0:08 label right-aligns 94 px after 0:06.
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={47}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("0:08")).toBeTruthy();
    // Whole-second steps announce whole seconds.
    expect(
      screen
        .getByRole("slider", { name: "Timeline position" })
        .getAttribute("aria-valuetext"),
    ).toMatch(/^\d+:\d{2}$/);
  });

  it("keeps the end label when there is room", () => {
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={200}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("0:08.0")).toBeTruthy();
  });

  it("labels deep-zoom ticks in m:ss.fff and mounts only the visible chunks", () => {
    // 60 s at 48,000 px/s: 2.88M px of ruler, 2 ms ticks 96 px apart.
    useDawStore.setState({
      scrollLeft: 1_000_000,
      timelineViewportWidth: 1200,
    });
    const { container } = render(
      <TimeRuler
        durationSec={60}
        sessionDurationSec={60}
        zoomPxPerSec={48000}
        onSeek={vi.fn()}
      />,
    );
    const ticks = [...container.querySelectorAll(".ruler-tick")];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(Math.ceil((1200 + 4096) / 70) + 2);
    for (const el of ticks) {
      expect(el.textContent).toMatch(/^\d+:\d{2}\.\d{3}$/);
      const left = parseFloat((el as HTMLElement).style.left);
      expect(left).toBeGreaterThanOrEqual(1_000_000 - 2048);
      expect(left).toBeLessThanOrEqual(1_000_000 + 1200 + 2048);
    }
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "0:00.000",
    );
    // Scrolling swaps in the new chunk's ticks.
    act(() => useDawStore.setState({ scrollLeft: 2_000_000 }));
    const moved = [...container.querySelectorAll(".ruler-tick")].map((el) =>
      parseFloat((el as HTMLElement).style.left),
    );
    expect(Math.min(...moved)).toBeGreaterThanOrEqual(2_000_000 - 2048);
    act(() =>
      useDawStore.setState({ scrollLeft: 0, timelineViewportWidth: 0 }),
    );
  });

  it("reads its value from the store, in quarter seconds while playing", () => {
    useDawStore.setState({ playheadSec: 3.3, isPlaying: false });
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        onSeek={vi.fn()}
      />,
    );
    const slider = screen.getByRole("slider");
    expect(slider).toHaveAttribute("aria-valuenow", "3.3");
    act(() => useDawStore.setState({ isPlaying: true, playheadSec: 3.6 }));
    expect(slider).toHaveAttribute("aria-valuenow", "3.5");
    act(() => useDawStore.setState({ playheadSec: 3.7 }));
    expect(slider).toHaveAttribute("aria-valuenow", "3.5");
    act(() => useDawStore.setState({ isPlaying: false, playheadSec: 0 }));
  });

  it("announces the slider value truncated, not rounded", () => {
    useDawStore.setState({ playheadSec: 59.6, isPlaying: false });
    render(
      <TimeRuler
        durationSec={60}
        sessionDurationSec={60}
        zoomPxPerSec={20}
        onSeek={vi.fn()}
      />,
    );
    // 20 px/s picks a whole-second step (5 s), so no decimals.
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "0:59",
    );
    act(() => useDawStore.setState({ playheadSec: 0 }));
  });

  it("steps from the store playhead on arrow keys", () => {
    useDawStore.setState({ playheadSec: 4, isPlaying: false });
    const onSeek = vi.fn();
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        onSeek={onSeek}
      />,
    );
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft" });
    expect(onSeek).toHaveBeenCalledWith(2);
    act(() => useDawStore.setState({ playheadSec: 0 }));
  });
});

describe("TimeRulerView", () => {
  it("renders from props and uses the precise position for keyboard steps", async () => {
    const onSeek = vi.fn();
    const { container } = render(
      <TimeRulerView
        durationSec={9}
        sessionDurationSec={8}
        zoomPxPerSec={40}
        valueSec={4.5}
        getPlayheadSec={() => 4.6}
        visibleChunks={[0, 0]}
        playhead={<PlayheadNeedle xPx={184} height="100%" />}
        onSeek={onSeek}
      />,
    );
    const slider = screen.getByRole("slider", { name: "Timeline position" });
    expect(slider).toHaveAttribute("aria-valuenow", "4.5");
    expect(slider).toHaveAttribute("aria-valuemax", "8");
    expect(container.querySelector(".playhead")).toHaveStyle({
      transform: "translateX(184px)",
    });
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onSeek).toHaveBeenCalledWith(6.6);
    await expectNoA11yViolations(container);
  });

  it("renders only the requested chunks at deep zoom", () => {
    const { container } = render(
      <TimeRulerView
        durationSec={60}
        sessionDurationSec={60}
        zoomPxPerSec={48_000}
        valueSec={21}
        getPlayheadSec={() => 21}
        visibleChunks={[488, 489]}
        onSeek={vi.fn()}
      />,
    );
    const ticks = [...container.querySelectorAll<HTMLElement>(".ruler-tick")];
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(100);
    expect(
      ticks.every((tick) => Number.parseFloat(tick.style.left) >= 488 * 2048),
    ).toBe(true);
  });
});
