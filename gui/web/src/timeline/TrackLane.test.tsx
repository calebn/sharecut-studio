import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClipRow, TrackView } from "../types/project";
import { TrackLane } from "./TrackLane";

const laneStatus = vi.hoisted(() => ({
  current: "idle" as string,
  refs: [] as string[],
}));

vi.mock("../waveform/statusStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../waveform/statusStore")>()),
  useWaveformStatus: () => null,
  useLaneWaveformStatus: (_path: string, refsKey: string) => {
    laneStatus.refs.push(refsKey);
    return laneStatus.current;
  },
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
    laneStatus.current = "idle";
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
    expect(onSelectClip).toHaveBeenCalledWith("host", "c1", {
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
});

describe("TrackLane waveform status hint", () => {
  afterEach(() => {
    laneStatus.current = "idle";
  });

  it("shows a generating hint and marks the lane while a pyramid builds", () => {
    laneStatus.current = "generating";
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Generating waveform…",
    );
    expect(
      container.querySelector("[data-waveform-status='generating']"),
    ).toBeTruthy();
  });

  it("shows an unavailable hint when no ref has a pyramid", () => {
    laneStatus.current = "unavailable";
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waveform unavailable",
    );
    expect(
      container.querySelector("[data-waveform-status='unavailable']"),
    ).toBeTruthy();
  });

  it("shows no hint once a pyramid is ready", () => {
    laneStatus.current = "ready";
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".lane-waveform-status")).toBeNull();
    expect(
      container.querySelector("[data-waveform-status='ready']"),
    ).toBeTruthy();
  });

  it("shows no hint while idle", () => {
    laneStatus.current = "idle";
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".lane-waveform-status")).toBeNull();
  });
});

describe("TrackLane media refs", () => {
  it("asks lane status for the refs its clips draw", () => {
    laneStatus.refs = [];
    render(
      <TrackLane
        {...baseProps}
        clips={[clip, { ...clip, id: "c2", source_id: "s1" }]}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(laneStatus.refs.at(-1)).toBe("source:s1\ntrack:host");
  });
});
