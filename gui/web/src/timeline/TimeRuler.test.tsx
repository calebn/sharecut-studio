import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { TimeRuler } from "./TimeRuler";

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
