import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { synchronizePlaybackClipLatches } from "../audio/playbackClipLatches";
import { bindPlaybackMeterSource } from "../audio/playbackMeterSource";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { TrackPlaybackMeter } from "./TrackPlaybackMeter";

let tick: FrameRequestCallback | null = null;
let unbind: (() => void) | null = null;
function frame(now = 100) {
  act(() => {
    tick?.(now);
  });
}

beforeEach(() => {
  synchronizePlaybackClipLatches(-1, []);
  useDawStore.setState({
    isPlaying: true,
    sourcePreview: null,
    projectEpoch: 1,
    project: minimalProject({
      tracks: [sampleTrack({ id: "host", label: "Mira" })],
    }),
  });
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((next: FrameRequestCallback) => {
      tick = next;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
  unbind?.();
  unbind = null;
  vi.unstubAllGlobals();
});

describe("track playback peak meter", () => {
  it("shows measured peak, retains clip across pause and seek, and clears on request", async () => {
    let samples = [1];
    unbind = bindPlaybackMeterSource({ read: () => samples });
    const { container } = render(
      <TrackPlaybackMeter trackId="host" label="Mira" />,
    );
    frame();
    const meter = screen.getByRole("meter", { name: "Mira playback level" });
    expect(meter).toHaveAttribute("aria-valuenow", "0");
    expect(meter).toHaveAttribute("aria-valuetext", "Clipping: peak 0 dBFS");
    const clear = screen.getByRole("button", {
      name: "Clear clip light for Mira",
    });
    expect(clear).toBeEnabled();
    expect(
      screen.getByRole("img", { name: "Clipping detected" }),
    ).toBeVisible();
    samples = [0];
    act(() => useDawStore.setState({ isPlaying: false, playheadSec: 2 }));
    expect(clear).toBeEnabled();
    expect(meter).toHaveAttribute(
      "aria-valuetext",
      "Playback stopped. Clipping detected",
    );
    expect(cancelAnimationFrame).toHaveBeenCalled();
    await userEvent.click(clear);
    expect(clear).toBeDisabled();
    await expectNoA11yViolations(container);
  });

  it("distinguishes unavailable evidence and source replacement without clearing a clip", () => {
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    frame();
    act(() => {
      unbind?.();
      unbind = bindPlaybackMeterSource({ read: () => null });
    });
    frame(150);
    expect(screen.getByRole("meter")).toHaveAttribute(
      "aria-valuetext",
      "Playback level unavailable. Clipping detected",
    );
    expect(screen.getByRole("button")).toBeEnabled();
    act(() => useDawStore.setState({ projectEpoch: 2 }));
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("freezes reduced-motion bars while continuing overload protection", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    frame();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "-60");
    expect(screen.getByRole("button")).toBeEnabled();
  });

  it("retains the clip latch across responsive shell remounts until cleared", async () => {
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    const first = render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    frame();
    act(() => useDawStore.setState({ isPlaying: false }));
    first.unmount();
    const second = render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    expect(screen.getByRole("button")).toBeEnabled();
    await userEvent.click(screen.getByRole("button"));
    second.unmount();
    render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("drops removed track latches while the meter source and leaf are absent", () => {
    unbind = bindPlaybackMeterSource({ read: () => [1] });
    const first = render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    frame();
    act(() => {
      unbind?.();
      unbind = null;
    });
    first.unmount();
    act(() =>
      useDawStore.setState({ project: minimalProject(), isPlaying: false }),
    );
    act(() =>
      useDawStore.setState({
        project: minimalProject({ tracks: [sampleTrack({ id: "host" })] }),
      }),
    );
    act(() => {
      unbind = bindPlaybackMeterSource({ read: () => [0] });
    });
    render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("never samples idle transport", () => {
    const read = vi.fn(() => [1]);
    unbind = bindPlaybackMeterSource({ read });
    useDawStore.setState({ isPlaying: false });
    render(<TrackPlaybackMeter trackId="host" label="Mira" />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
