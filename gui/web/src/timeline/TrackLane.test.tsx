import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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

describe("TrackLane join badges", () => {
  const left: ClipRow = {
    ...clip,
    id: "c0",
    source_start: 0,
    source_end: 5,
    timeline_start: 0,
    timeline_end: 5,
  };
  const right: ClipRow = {
    ...clip,
    id: "c1",
    source_start: 5,
    source_end: 10,
    timeline_start: 5,
    timeline_end: 10,
    join_left_clip_id: "c0",
  };
  const lane = (props: Partial<ComponentProps<typeof TrackLane>> = {}) =>
    render(
      <TrackLane
        {...baseProps}
        clips={[left, right]}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
        {...props}
      />,
    );

  it("draws one badge at the seam", () => {
    const { container } = lane();
    const badges = container.querySelectorAll(".join-badge");
    expect(badges).toHaveLength(1);
    const badge = screen.getByRole("img", { name: "Fade join at 0:05.0" });
    expect((badge as HTMLElement).style.left).toBe("500px");
  });

  it("draws no badge for a single clip", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".join-badge")).toBeNull();
  });

  it("classes a cut and a blocked crossfade", () => {
    const { container, rerender } = lane({
      clips: [left, { ...right, join_in_mode: "cut" }],
    });
    expect(container.querySelector(".join-badge--cut")).toBeTruthy();
    rerender(
      <TrackLane
        {...baseProps}
        clips={[
          left,
          {
            ...right,
            join_in_mode: "crossfade",
            join_crossfade_blocked: "no_fade_in",
          },
        ]}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(
      container.querySelector(".join-badge--crossfade.join-badge--blocked"),
    ).toBeTruthy();
  });

  it("draws no badge for a mismatched join id", () => {
    const { container } = lane({
      clips: [left, { ...right, join_left_clip_id: "cx" }],
    });
    expect(container.querySelector(".join-badge")).toBeNull();
  });

  it("draws no badge across a gap", () => {
    const { container } = lane({
      clips: [left, { ...right, timeline_start: 6, timeline_end: 11 }],
    });
    expect(container.querySelector(".join-badge")).toBeNull();
  });

  it("draws no badge when the clips are too narrow on screen", () => {
    const { container } = lane({ zoomPxPerSec: 4 });
    expect(container.querySelector(".join-badge")).toBeNull();
  });

  it("draws no badge while a neighbour is being moved", () => {
    const { container: previewContainer } = lane({
      previewStartById: { c1: 7 },
    });
    expect(previewContainer.querySelector(".join-badge")).toBeNull();

    const { container: hiddenContainer } = lane({
      hideClipIds: new Set(["c0"]),
    });
    expect(hiddenContainer.querySelector(".join-badge")).toBeNull();
  });

  it("draws two badges for three abutting clips", () => {
    const c2: ClipRow = {
      ...clip,
      id: "c2",
      source_start: 10,
      source_end: 15,
      timeline_start: 10,
      timeline_end: 15,
      join_left_clip_id: "c1",
    };
    const { container } = lane({ clips: [left, right, c2], width: 1500 });
    const badges = Array.from(container.querySelectorAll(".join-badge"));
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => (b as HTMLElement).style.left)).toEqual([
      "500px",
      "1000px",
    ]);
  });

  it("keeps the join diamond alongside the badge", () => {
    const { container } = lane();
    expect(container.querySelector(".join-diamond")).toBeTruthy();
    expect(container.querySelector(".join-badge")).toBeTruthy();
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
