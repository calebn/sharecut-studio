import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { partial, rule } from "../test/cssRules";
import { editBoundaries, minimalProject, sampleTrack } from "../test/fixtures";
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
  source_duration_sec: null,
  recording_key: null,
};

const baseProps = {
  track,
  trackIndex: 0,
  clips: [clip],
  width: 1000,
  laneHeight: 104,
  zoomPxPerSec: 100,
  projectPath: "/tmp/p.json",
  selection: null,
  showLevels: false,
  envelopes: [],
  appliedRecords: [],
  pendingEdits: [],
  onSelectPending: vi.fn(),
  onSelectSeam: vi.fn(),
};

describe("TrackLane", () => {
  afterEach(() => {
    laneStatus.current = "idle";
    useDawStore.setState({ project: null, projectPath: "" });
  });

  it("labels a moved clip with its origin speaker", () => {
    useDawStore.getState().hydrate(
      "/tmp/p.json",
      minimalProject({
        tracks: [track, sampleTrack({ id: "guest", speaker: "Avery" })],
      }),
    );
    render(
      <TrackLane
        {...baseProps}
        clips={[{ ...clip, origin_track_id: "guest" }]}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Select Avery clip at 00:00.000, 10s",
      }),
    ).toBeInTheDocument();
  });

  it("selects a clicked clip and does not seek", async () => {
    const onSeek = vi.fn();
    const onSelectClip = vi.fn();
    render(
      <TrackLane {...baseProps} onSeek={onSeek} onSelectClip={onSelectClip} />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /^Select .+ clip at / }),
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

describe("TrackLane mute dim", () => {
  afterEach(() => {
    useDawStore.setState({ soloTracks: {}, viewerMute: {} });
  });

  it.each([
    [
      "your solo on another track",
      { soloTracks: { guest: true } },
      false,
      "implied",
    ],
    ["your own solo", { soloTracks: { host: true } }, false, "off"],
    ["a listen-only mute", { viewerMute: { host: true } }, false, "listen"],
    ["a saved mute", {}, true, "saved"],
    [
      "a saved mute under another solo",
      { soloTracks: { guest: true } },
      true,
      "saved",
    ],
  ])("marks the lane for %s", (_case, listen, muted, mute) => {
    useDawStore.setState(listen);
    render(
      <TrackLane
        {...baseProps}
        track={{ ...track, muted }}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("group", { name: "Track Host" })
        .getAttribute("data-mute"),
    ).toBe(mute);
  });

  it("greys the lane, clips and waveform of every track this listener doesn't hear", () => {
    const css = partial("timeline.css");
    const system = partial("system.css");
    const muted = '.sys-lane[data-mute]:not([data-mute="off"])';
    expect(rule(system, '.sys-lane[data-mute]:not([data-mute="off"])')).toMatch(
      /background:\s*var\(--color-track-muted\)/,
    );
    const clip = rule(css, `${muted} .clip-block`);
    expect(clip).toMatch(
      /background-image:\s*linear-gradient\(\s*var\(--color-clip-muted\),\s*var\(--color-clip-muted\)\s*\);/,
    );
    expect(clip).not.toMatch(/background(-color)?:/);
    expect(rule(css, `${muted} .clip-waveform`)).toMatch(
      /filter:\s*grayscale\(1\);\s*opacity:\s*var\(--mute-waveform-opacity\);/,
    );
    expect(css).not.toMatch(/\.clip-label[^{]*\{[^}]*opacity/);
  });

  it("draws the drop ring above the opaque lane, not on the wrapper under it", () => {
    const ingest = partial("ingest.css");
    expect(rule(ingest, ".lane-row.lane-drop-target")).toMatch(
      /outline:\s*none/,
    );
    const ring = rule(ingest, ".lane-row.lane-drop-target::after");
    expect(ring).toMatch(/position:\s*absolute/);
    expect(ring).toMatch(/inset:\s*0/);
    expect(ring).toMatch(/z-index:\s*var\(--z-status-overlay\)/);
    expect(ring).toMatch(/pointer-events:\s*none/);
    expect(ring).toMatch(
      /outline:\s*var\(--focus-ring-width\)\s+solid\s+var\(--color-accent\)/,
    );
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    const row = container.querySelector(".lane-row");
    expect(row).not.toBeNull();
    fireEvent.dragOver(row as Element, { dataTransfer: { files: [] } });
    expect(row?.classList.contains("lane-drop-target")).toBe(true);
  });

  it("keeps the lane colour as each clip's background-color, which the waveform tint reads", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    const clip = container.querySelector<HTMLElement>(".clip-block");
    expect(clip?.style.backgroundColor).toBe("var(--color-clip-dialogue-0)");
    expect(clip?.style.backgroundImage).toBe("");
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
    expect(screen.getByRole("group", { name: "Track Host" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
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

describe("TrackLane seam marks", () => {
  const left: ClipRow = {
    ...clip,
    id: "c0",
    source_duration_sec: 10,
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
  const lane = (props: Partial<ComponentProps<typeof TrackLane>> = {}) => {
    const clips = props.clips ?? [left, right];
    useDawStore.setState({
      projectPath: baseProps.projectPath,
      project: minimalProject({
        tracks: [props.track ?? track],
        clips: { tracks: { host: [...clips] }, clip_count: clips.length },
        edit_boundaries: editBoundaries(clips),
      }),
    });
    return render(
      <TrackLane
        {...baseProps}
        clips={[left, right]}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
        {...props}
      />,
    );
  };
  const diamonds = (container: HTMLElement) =>
    container.querySelectorAll<HTMLElement>(".seam-mark");

  afterEach(() => {
    useDawStore.setState({ project: null, projectPath: "" });
  });

  it("draws one hollow diamond at a split seam", () => {
    const { container } = lane();
    expect(diamonds(container)).toHaveLength(1);
    expect(diamonds(container)[0]?.style.left).toBe("500px");
    expect(container.querySelector(".sys-seam")).toHaveAttribute(
      "data-kind",
      "split",
    );
    expect(
      screen.getByRole("button", { name: "Split at 0:05.0, Fade join" }),
    ).toBeInTheDocument();
  });

  it("draws a filled diamond where a cut left the clips touching", () => {
    const { container } = lane({
      clips: [left, { ...right, source_start: 7 }],
    });
    expect(container.querySelector(".sys-seam")).toHaveAttribute(
      "data-kind",
      "cut",
    );
  });

  it("draws no diamond for a single clip", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(diamonds(container)).toHaveLength(0);
  });

  it("draws no diamond across a gap that cut nothing", () => {
    const { container } = lane({
      clips: [left, { ...right, timeline_start: 6, timeline_end: 11 }],
    });
    expect(diamonds(container)).toHaveLength(0);
  });

  it("marks the diamond as the roll target of its right clip", () => {
    const { container } = lane();
    const hit = container.querySelector<HTMLElement>(
      '.seam-mark [data-hit-kind="roll"]',
    );
    expect(hit?.getAttribute("data-hit-id")).toBe("c1");
    expect(container.querySelector(".join-seam")).toBeNull();
    expect(container.querySelector(".edit-mark")).toBeNull();
  });

  it("draws the diamond at a zoom where the clips are a few pixels wide", () => {
    const { container } = lane({ zoomPxPerSec: 4, width: 40 });
    expect(diamonds(container)[0]?.style.left).toBe("20px");
  });

  it("draws no diamond while a neighbour is being moved", () => {
    const { container: previewContainer } = lane({
      previewStartById: { c1: 7 },
    });
    expect(diamonds(previewContainer)).toHaveLength(0);

    const { container: hiddenContainer } = lane({
      hideClipIds: new Set(["c0"]),
    });
    expect(diamonds(hiddenContainer)).toHaveLength(0);
  });

  it("draws two diamonds for three abutting clips", () => {
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
    expect(Array.from(diamonds(container)).map((b) => b.style.left)).toEqual([
      "500px",
      "1000px",
    ]);
  });

  it("selects the seam when its diamond is pressed", () => {
    const onSelectSeam = vi.fn();
    lane({ onSelectSeam });
    fireEvent.click(screen.getByRole("button", { name: /^Split at 0:05\.0/ }));
    expect(onSelectSeam).toHaveBeenCalledExactlyOnceWith("host", "eb:c0:c1");
  });

  it("moves the diamond and both clips with a live roll", () => {
    const { container } = lane();
    const hit = screen.getByRole("button", { name: /^Split at 0:05\.0/ });
    // 50 px at 100 px/s rolls the c0 | c1 seam 0.5 s right.
    fireEvent.pointerDown(hit, { clientX: 100, pointerId: 7, button: 0 });
    fireEvent.pointerMove(hit, { clientX: 150, pointerId: 7 });
    expect(diamonds(container)[0]?.style.left).toBe("550px");
    expect(container.querySelector(".sys-seam-readout")).toHaveTextContent(
      "+500 ms",
    );
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

describe("TrackLane prosody overlay", () => {
  const prosodyTrack: import("../types/prosody").ProsodyOverlayTrack = {
    track_id: "host",
    status: "fresh",
    segments: [
      {
        source_start: 0,
        source_end: 2,
        spans: [{ start: 0, end: 2 }],
        energy_thirds: [],
        trend: "flat",
        drop_db: 0,
        line: "",
      },
    ],
    boundaries: [],
    prominent_words: [],
    energy_db: null,
  };

  it("renders the overlay when a prosody track is given", () => {
    const { container } = render(
      <TrackLane
        {...baseProps}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
        prosody={prosodyTrack}
      />,
    );
    expect(container.querySelector(".prosody-overlay")).toBeTruthy();
  });

  it("renders no overlay without a prosody track", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".prosody-overlay")).toBeNull();
  });
});
