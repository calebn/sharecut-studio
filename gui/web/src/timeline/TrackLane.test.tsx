import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { partial, rule } from "../test/cssRules";
import { minimalProject, sampleTrack } from "../test/fixtures";
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
      screen.getByRole("button", { name: /^Select .+ clip at / }),
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
      "lane-row mute-implied",
    ],
    ["your own solo", { soloTracks: { host: true } }, false, "lane-row"],
    [
      "a listen-only mute",
      { viewerMute: { host: true } },
      false,
      "lane-row muted mute-listen",
    ],
    ["a saved mute", {}, true, "lane-row muted"],
    [
      "a saved mute under another solo",
      { soloTracks: { guest: true } },
      true,
      "lane-row muted",
    ],
  ])("classes the lane for %s", (_case, listen, muted, className) => {
    useDawStore.setState(listen);
    const { container } = render(
      <TrackLane
        {...baseProps}
        track={{ ...track, muted }}
        onSeek={vi.fn()}
        onSelectClip={vi.fn()}
      />,
    );
    expect(container.querySelector(".lane-row")?.className).toBe(className);
  });

  it("greys the lane, clips and waveform of every track this listener doesn't hear", () => {
    const css = partial("timeline.css");
    expect(rule(css, ".lane-row:is(.muted, .mute-implied)")).toMatch(
      /background:\s*var\(--color-track-muted\)/,
    );
    const clip = rule(css, ".lane-row:is(.muted, .mute-implied) .clip-block");
    expect(clip).toMatch(
      /background-image:\s*linear-gradient\(\s*var\(--color-clip-muted\),\s*var\(--color-clip-muted\)\s*\);/,
    );
    expect(clip).not.toMatch(/background(-color)?:/);
    expect(
      rule(css, ".lane-row:is(.muted, .mute-implied) .clip-waveform"),
    ).toMatch(
      /filter:\s*grayscale\(1\);\s*opacity:\s*var\(--mute-waveform-opacity\);/,
    );
    expect(css).not.toMatch(/\.clip-label[^{]*\{[^}]*opacity/);
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

describe("TrackLane join marks", () => {
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

  afterEach(() => {
    useDawStore.setState({ project: null, projectPath: "" });
  });

  it("draws one glyph at the seam", () => {
    const { container } = lane();
    const badges = container.querySelectorAll(".edit-mark");
    expect(badges).toHaveLength(1);
    const badge = screen.getByRole("button", { name: "Fade join at 0:05.0" });
    expect((badge as HTMLElement).style.left).toBe("500px");
  });

  it("draws no glyph for a single clip", () => {
    const { container } = render(
      <TrackLane {...baseProps} onSeek={vi.fn()} onSelectClip={vi.fn()} />,
    );
    expect(container.querySelector(".edit-mark")).toBeNull();
  });

  it("types a cut and a blocked crossfade", () => {
    const { container, rerender } = lane({
      clips: [left, { ...right, join_in_mode: "cut" }],
    });
    expect(container.querySelector(".edit-mark--cut")).toBeTruthy();
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
      container.querySelector(".edit-mark--crossfade.edit-mark--blocked"),
    ).toBeTruthy();
  });

  it("draws no glyph for a mismatched join id", () => {
    const { container } = lane({
      clips: [left, { ...right, join_left_clip_id: "cx" }],
    });
    expect(container.querySelector(".edit-mark")).toBeNull();
  });

  it("draws no glyph across a gap", () => {
    const { container } = lane({
      clips: [left, { ...right, timeline_start: 6, timeline_end: 11 }],
    });
    expect(container.querySelector(".edit-mark")).toBeNull();
  });

  it("offers no roll across a gap: the seam is drawn only where clips abut", () => {
    const gapped = {
      clips: [left, { ...right, timeline_start: 10, timeline_end: 15 }],
    };
    const { container } = lane(gapped);
    expect({
      seams: container.querySelectorAll(".join-seam").length,
      rolls: container.querySelectorAll('[data-hit-kind="roll"]').length,
    }).toEqual({ seams: 0, rolls: 0 });
  });

  it("draws the glyph at a zoom where the clips are a few pixels wide", () => {
    const { container } = lane({ zoomPxPerSec: 4, width: 40 });
    const glyph = container.querySelector<HTMLElement>(".edit-mark");
    expect(glyph?.style.left).toBe("20px");
  });

  it("draws no glyph while a neighbour is being moved", () => {
    const { container: previewContainer } = lane({
      previewStartById: { c1: 7 },
    });
    expect(previewContainer.querySelector(".edit-mark")).toBeNull();

    const { container: hiddenContainer } = lane({
      hideClipIds: new Set(["c0"]),
    });
    expect(hiddenContainer.querySelector(".edit-mark")).toBeNull();
  });

  it("draws two glyphs for three abutting clips", () => {
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
    const badges = Array.from(container.querySelectorAll(".edit-mark"));
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => (b as HTMLElement).style.left)).toEqual([
      "500px",
      "1000px",
    ]);
  });

  it("keeps the join seam alongside the glyph", () => {
    const { container } = lane();
    expect(container.querySelector(".join-seam")).toBeTruthy();
    expect(container.querySelector(".edit-mark")).toBeTruthy();
  });

  it("moves the glyph with a live roll of its join", () => {
    const { container } = lane();
    const seam = container.querySelector<HTMLElement>("button.join-seam")!;
    // 50 px at 100 px/s rolls the c0 | c1 join 0.5 s right.
    fireEvent.pointerDown(seam, { clientX: 100, pointerId: 7 });
    fireEvent.pointerMove(seam, { clientX: 150, pointerId: 7 });
    const badge = container.querySelector<HTMLElement>(".edit-mark")!;
    expect(badge.style.left).toBe("550px");
  });

  it("folds joins closer than 24 px into one count chip", () => {
    const clips: ClipRow[] = [left];
    for (let i = 1; i <= 3; i += 1) {
      clips.push({
        ...clip,
        id: `n${i}`,
        source_start: i * 0.1,
        source_end: i * 0.1 + 0.1,
        timeline_start: i * 0.1,
        timeline_end: i * 0.1 + 0.1,
        join_left_clip_id: i === 1 ? "c0" : `n${i - 1}`,
        join_in_mode: i === 2 ? "cut" : "fade",
      });
    }
    const { container } = lane({
      clips: [
        { ...left, source_end: 0.1, timeline_end: 0.1 },
        ...clips.slice(1),
      ],
      zoomPxPerSec: 10,
      width: 100,
    });
    expect(container.querySelectorAll(".edit-mark")).toHaveLength(0);
    const chip = container.querySelector<HTMLElement>(".edit-chip");
    expect(chip?.getAttribute("aria-label")).toBe(
      "3 edits: 1 cut, 2 fades. Zoom in",
    );
    expect(
      container.querySelectorAll('[data-hit-kind="edit-chip"]'),
    ).toHaveLength(1);
  });

  it("opens the join popover from the glyph", () => {
    lane();
    const badge = screen.getByRole("button", { name: "Fade join at 0:05.0" });
    fireEvent.click(badge);
    expect(
      screen.getByRole("dialog", { name: "Fade join at 0:05.0" }),
    ).toBeInTheDocument();
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
