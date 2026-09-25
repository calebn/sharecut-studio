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
    // No matchMedia stub: fine pointer, tight estimate, no drop.
    render(
      <TimeRuler
        durationSec={9}
        sessionDurationSec={9}
        zoomPxPerSec={40}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByText("0:08")).toBeTruthy();
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
    expect(screen.getByText("0:08")).toBeTruthy();
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
