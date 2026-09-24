import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipRow, TrackView } from "../types/project";
import { TrackLane } from "./TrackLane";

const mockPeaksState = vi.hoisted(() => ({
  current: { peaks: null as unknown, status: "idle" as string },
}));

vi.mock("../hooks/usePeaks", () => ({
  usePeaks: () => mockPeaksState.current,
}));

vi.mock("../hooks/useClipWaveform", () => ({
  useClipWaveform: () => ({
    window: {
      cssWidth: 100,
      canvasLeft: 0,
      sourceStart: 0,
      sourceEnd: 10,
      offscreen: false,
    },
    quiet: [],
    ticks: [],
    paint: vi.fn(),
  }),
}));

const track: TrackView = {
  id: "host",
  label: "Host",
  role: "dialogue",
  speaker: null,
  gain_db: 0,
  muted: false,
  duration_sec: 10,
  fx_count: 0,
  stem_is_fresh: true,
};

const clip: ClipRow = {
  id: "c1",
  track_id: "host",
  source_start: 0,
  source_end: 10,
  timeline_start: 0,
  timeline_end: 10,
  fade_in_ms: 0,
  fade_out_ms: 0,
  join_in_mode: "fade",
  source_id: null,
};

const baseProps = {
  track,
  trackIndex: 0,
  clips: [clip],
  width: 1000,
  zoomPxPerSec: 100,
  projectPath: "/tmp/p.json",
  hasPeaks: false,
  selection: null,
  showLevels: false,
  showEdits: false,
  envelopes: [],
  appliedRecords: [],
  pendingEdits: [],
  onSelectTrack: vi.fn(),
  onSelectApplied: vi.fn(),
  onSelectPending: vi.fn(),
};

describe("TrackLane bladeMode", () => {
  afterEach(() => {
    mockPeaksState.current = { peaks: null, status: "idle" };
  });

  it("routes clip hit through onSeek with lane-seek underlay when bladeMode", async () => {
    const onSeek = vi.fn();
    const onSelectClip = vi.fn();
    render(
      <TrackLane
        {...baseProps}
        bladeMode
        onSeek={onSeek}
        onSelectClip={onSelectClip}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Select clip c1" }),
    );

    expect(onSelectClip).not.toHaveBeenCalled();
    expect(onSeek).toHaveBeenCalledTimes(1);
    const [clientX, target] = onSeek.mock.calls[0];
    expect(typeof clientX).toBe("number");
    expect(target).toBeInstanceOf(HTMLElement);
    expect((target as HTMLElement).classList.contains("lane-seek")).toBe(true);
  });

  it("selects clip when bladeMode is off", async () => {
    const onSeek = vi.fn();
    const onSelectClip = vi.fn();
    render(
      <TrackLane
        {...baseProps}
        bladeMode={false}
        onSeek={onSeek}
        onSelectClip={onSelectClip}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Select clip c1" }),
    );

    expect(onSeek).not.toHaveBeenCalled();
    expect(onSelectClip).toHaveBeenCalledWith("c1", {
      shift: false,
      mod: false,
    });
  });

  it("exposes data-track-id for drop targeting", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector("[data-track-id='host']")).toBeTruthy();
  });

  it("shows a lane cut guide when blade hover is set on a target lane", () => {
    const { container, rerender } = render(
      <TrackLane
        {...baseProps}
        bladeMode
        bladeHighlight
        bladeHoverSec={2.5}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    const guide = container.querySelector(".blade-cut-guide--lane");
    expect(guide).toBeTruthy();
    expect((guide as HTMLElement).style.left).toBe("250px");

    rerender(
      <TrackLane
        {...baseProps}
        bladeMode
        bladeHighlight
        bladeHoverSec={null}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(container.querySelector(".blade-cut-guide--lane")).toBeNull();
  });

  it("hides the cut guide on non-target lanes", () => {
    const { container } = render(
      <TrackLane
        {...baseProps}
        bladeMode
        bladeHighlight={false}
        bladeHoverSec={1}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(container.querySelector(".blade-cut-guide--lane")).toBeNull();
  });
});

describe("TrackLane peaks status hint", () => {
  afterEach(() => {
    mockPeaksState.current = { peaks: null, status: "idle" };
  });

  it("shows a generating hint and marks the lane while waveform peaks are pending", () => {
    mockPeaksState.current = { peaks: null, status: "generating" };
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Generating waveform…",
    );
    expect(
      container.querySelector("[data-peaks-status='generating']"),
    ).toBeTruthy();
  });

  it("shows an unavailable hint when peaks cannot be generated", () => {
    mockPeaksState.current = { peaks: null, status: "unavailable" };
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waveform unavailable",
    );
    expect(
      container.querySelector("[data-peaks-status='unavailable']"),
    ).toBeTruthy();
  });

  it("shows no hint once peaks are ready", () => {
    mockPeaksState.current = {
      peaks: { peaks: [], samples_per_pixel: 1, sample_rate: 1 },
      status: "ready",
    };
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".lane-peaks-status")).toBeNull();
    expect(container.querySelector("[data-peaks-status='ready']")).toBeTruthy();
  });

  it("shows no hint while idle", () => {
    mockPeaksState.current = { peaks: null, status: "idle" };
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".lane-peaks-status")).toBeNull();
  });
});
