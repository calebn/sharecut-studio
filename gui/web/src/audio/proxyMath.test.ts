import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import type { ClipRow, ProjectView } from "../types/project";
import {
  buildSchedule,
  chunkFileStartSec,
  chunkIndexForSource,
  episodeEndSec,
  isQueuedMoveOverlay,
  offsetInChunk,
  type ProxyManifest,
  parseProxyManifest,
  projectProxyBasis,
  proxyBasisKey,
} from "./proxyMath";

function clip(partial: Partial<ClipRow> & Pick<ClipRow, "id">): ClipRow {
  return {
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
    ...partial,
  };
}

function manifest(): ProxyManifest {
  return {
    revision: "revision",
    project_basis: { history_head_id: "root", render_hashes: {}, clips: {} },
    tracks: {
      host: {
        hash: "a".repeat(16),
        chunk_sec: 60,
        overlap_ms: 200,
        chunk_count: 2,
        duration_sec: 120,
        urls: ["legacy0", "legacy1"],
      },
    },
    artifacts: {},
    occurrences: {},
  };
}

describe("proxyMath", () => {
  it("drops the fades at a cut join, as render does", () => {
    const [a, b] = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
          fade_in_ms: 20,
          fade_out_ms: 30,
        }),
        clip({
          id: "c2",
          source_start: 3,
          source_end: 5,
          timeline_start: 2,
          timeline_end: 4,
          fade_in_ms: 40,
          fade_out_ms: 50,
          join_in_mode: "cut",
          join_left_clip_id: "c1",
        }),
      ],
      0,
      10,
      manifest(),
    );
    expect(a.envelope.fadeInSec).toBeCloseTo(0.02);
    expect(a.envelope.fadeOutSec).toBe(0);
    expect(b.envelope.fadeInSec).toBe(0);
    expect(b.envelope.fadeOutSec).toBeCloseTo(0.05);
  });

  it("carries each clip's gain as a linear factor", () => {
    const [a, b, c] = buildSchedule(
      [
        clip({
          id: "c1",
          source_end: 2,
          timeline_end: 2,
          gain_db: 6,
        }),
        clip({
          id: "c2",
          source_start: 2,
          source_end: 4,
          timeline_start: 2,
          timeline_end: 4,
          gain_db: -12,
        }),
        clip({
          id: "c3",
          source_start: 4,
          source_end: 6,
          timeline_start: 4,
          timeline_end: 6,
        }),
      ],
      0,
      10,
      manifest(),
    );
    expect(a.envelope.gainLinear).toBeCloseTo(10 ** (6 / 20));
    expect(b.envelope.gainLinear).toBeCloseTo(10 ** (-12 / 20));
    expect(c.envelope.gainLinear).toBe(1);
  });

  it("keeps a first clip's fade-in when its leftover mode is cut", () => {
    const [c1] = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
          fade_in_ms: 20,
          join_in_mode: "cut",
          join_left_clip_id: null,
        }),
      ],
      0,
      10,
      manifest(),
    );
    expect(c1.envelope.fadeInSec).toBeCloseTo(0.02);
  });

  it("maps source seconds to chunk indices", () => {
    expect(chunkIndexForSource(0, 60)).toBe(0);
    expect(chunkIndexForSource(59.9, 60)).toBe(0);
    expect(chunkIndexForSource(60, 60)).toBe(1);
  });

  it("computes chunk file starts with overlap", () => {
    expect(chunkFileStartSec(0, 60, 200)).toBe(0);
    expect(chunkFileStartSec(1, 60, 200)).toBeCloseTo(59.8);
  });

  it("offsets within a chunk including overlap trim", () => {
    expect(offsetInChunk(60, 1, 60, 200)).toBeCloseTo(0.2);
  });

  it("splits a clip across chunk boundaries", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 50,
          source_end: 70,
          timeline_start: 0,
          timeline_end: 20,
        }),
      ],
      0,
      30,
      manifest(),
    );
    expect(slices.length).toBe(2);
    expect(slices[0].chunk.index).toBe(0);
    expect(slices[1].chunk.index).toBe(1);
    expect(slices[0].durationSec + slices[1].durationSec).toBeCloseTo(20);
  });

  it("retains the full clip envelope across chunk slices", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 50,
          source_end: 70,
          timeline_start: 0,
          timeline_end: 20,
          fade_in_ms: 40,
          fade_out_ms: 50,
        }),
      ],
      0,
      30,
      manifest(),
    );
    expect(slices[0].envelope.fadeInSec).toBeCloseTo(0.04);
    expect(slices[0].envelope.fadeOutSec).toBeCloseTo(0.05);
    expect(slices[1].envelope.fadeInSec).toBeCloseTo(0.04);
    expect(slices[1].envelope.fadeOutSec).toBeCloseTo(0.05);
  });

  it("takes the volume envelope of the lane the clip sits on, as render does", () => {
    const hostLine = [{ time: 0, value: 0.5 }];
    const guestLine = [{ time: 0, value: 2 }];
    const [onGuestLane] = buildSchedule(
      [clip({ id: "c1", track_id: "guest", origin_track_id: "host" })],
      0,
      30,
      manifest(),
      { host: hostLine, guest: guestLine },
    );
    expect(onGuestLane.envelope.volume).toEqual(guestLine);
  });

  it("carries the clip's mute regions with where its source starts", () => {
    const [slice] = buildSchedule(
      [
        clip({
          id: "c1",
          source_start: 4,
          source_end: 8,
          timeline_start: 10,
          timeline_end: 14,
          mute_regions: [{ start_s: 5, end_s: 6, gain_db: -12 }],
        }),
      ],
      0,
      30,
      manifest(),
    );
    expect(slice.envelope.sourceStartSec).toBe(4);
    expect(slice.envelope.mute).toEqual([
      {
        start: 5,
        end: 6,
        fadeOutSec: 0.005,
        fadeInSec: 0.005,
        gain: expect.closeTo(0.2512, 3),
      },
    ]);
  });

  it("mutes transcript-ignored words with the clip's own regions", () => {
    const [slice] = buildSchedule(
      [
        clip({
          id: "c1",
          mute_regions: [{ start_s: 1, end_s: 2 }],
          ignored_word_regions: [{ start_s: 5, end_s: 6 }],
        }),
      ],
      0,
      30,
      manifest(),
    );
    expect(slice.envelope.mute.map((span) => [span.start, span.end])).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it("leaves the mutes to an occurrence proxy that already has them baked in", () => {
    const artifactId = "b".repeat(64);
    const m: ProxyManifest = {
      ...manifest(),
      artifacts: {
        [artifactId]: {
          hash: artifactId,
          chunk_sec: 60,
          overlap_ms: 0,
          chunk_count: 1,
          duration_sec: 60,
          urls: ["variant0"],
        },
      },
      occurrences: {
        c1: { artifactId, outputTrackId: "host", bakesMutes: true },
      },
    };
    const [slice] = buildSchedule(
      [
        clip({
          id: "c1",
          mute_regions: [{ start_s: 1, end_s: 2, gain_db: -6 }],
        }),
      ],
      0,
      30,
      m,
    );
    expect(slice.envelope.mute).toEqual([]);
  });

  it("keeps the clip's mutes on a recording proxy that does not bake them", () => {
    const artifactId = "c".repeat(64);
    const base = manifest();
    const m: ProxyManifest = {
      ...base,
      artifacts: {
        [artifactId]: {
          hash: artifactId,
          chunk_sec: 60,
          overlap_ms: 0,
          chunk_count: 1,
          duration_sec: 60,
          urls: ["recording0"],
        },
      },
      occurrences: {
        c1: { artifactId, outputTrackId: "host", bakesMutes: false },
      },
    };
    const [slice] = buildSchedule(
      [
        clip({
          id: "c1",
          mute_regions: [{ start_s: 1, end_s: 2 }],
          off_speaker_mute_regions: [
            { start_s: 3, end_s: 4, fade_out_ms: 20, fade_in_ms: 30 },
          ],
        }),
      ],
      0,
      30,
      m,
    );
    expect(slice.chunk.kind).toBe("artifact");
    expect(slice.chunk.artifactId).toBe(artifactId);
    expect(slice.envelope.mute.map((span) => [span.start, span.end])).toEqual([
      [1, 2],
    ]);
    expect(slice.envelope.automaticMute).toEqual([
      { start: 3, end: 4, fadeOutSec: 0.02, fadeInSec: 0.03 },
    ]);
  });

  it("plays each edge's own curve, and forces linear where a cut or a blended join sets the edge", () => {
    const curved = {
      source_duration_sec: 10,
      fade_in_ms: 400,
      fade_out_ms: 400,
      fade_in_curve: "s" as const,
      fade_out_curve: "equal_power" as const,
    };
    const plain = buildSchedule(
      [clip({ id: "c1", ...curved })],
      0,
      20,
      manifest(),
    );
    expect(plain[0].envelope).toMatchObject({
      fadeInCurve: "s",
      fadeOutCurve: "equal_power",
    });
    const cut = buildSchedule(
      [
        clip({ id: "a", source_end: 2, timeline_end: 2, ...curved }),
        clip({
          id: "b",
          source_start: 2,
          source_end: 4,
          timeline_start: 2,
          timeline_end: 4,
          join_left_clip_id: "a",
          join_in_mode: "cut",
          ...curved,
        }),
      ],
      0,
      20,
      manifest(),
    );
    expect(cut[0].envelope).toMatchObject({
      fadeOutSec: 0,
      fadeOutCurve: "linear",
      fadeInCurve: "s",
    });
    expect(cut[1].envelope).toMatchObject({
      fadeInSec: 0,
      fadeInCurve: "linear",
      fadeOutCurve: "equal_power",
    });
    const blended = buildSchedule(
      [
        clip({ id: "a", source_end: 2, timeline_end: 2, ...curved }),
        clip({
          id: "b",
          source_start: 2,
          source_end: 4,
          timeline_start: 2,
          timeline_end: 4,
          join_left_clip_id: "a",
          join_in_mode: "crossfade",
          join_crossfade_ms: 200,
          join_borrow_sec: 0.1,
          ...curved,
        }),
      ],
      0,
      20,
      manifest(),
    );
    expect(blended[0].envelope).toMatchObject({
      fadeOutSec: expect.closeTo(0.2, 9),
      fadeOutCurve: "linear",
    });
    expect(blended[1].envelope).toMatchObject({
      fadeInSec: expect.closeTo(0.2, 9),
      fadeInCurve: "linear",
    });
  });

  it("blends a crossfade join around the seam and leaves later clips where they are, as render does", () => {
    const join = {
      source_duration_sec: 10,
      join_in_mode: "crossfade" as const,
      join_crossfade_ms: 200,
      join_borrow_sec: 0.1,
      fade_in_ms: 400,
      fade_out_ms: 400,
    };
    const slices = buildSchedule(
      [
        clip({
          id: "a",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
          source_duration_sec: 10,
          fade_out_ms: 400,
        }),
        clip({
          id: "b",
          source_start: 2,
          source_end: 4,
          timeline_start: 2,
          timeline_end: 4,
          join_left_clip_id: "a",
          ...join,
        }),
        clip({
          id: "c",
          source_start: 4,
          source_end: 6,
          timeline_start: 4.5,
          timeline_end: 6.5,
        }),
      ],
      0,
      20,
      manifest(),
    );
    const [a, b, c] = slices;
    expect(a.whenTimelineSec).toBe(0);
    expect(a.envelope.fadeOutSec).toBeCloseTo(0.2, 9);
    expect(a.envelope.timelineEndSec).toBeCloseTo(2.1, 9);
    expect(b.whenTimelineSec).toBeCloseTo(1.9, 9);
    expect(b.envelope.timelineStartSec).toBeCloseTo(1.9, 9);
    expect(b.envelope.sourceStartSec).toBeCloseTo(1.9, 9);
    expect(b.envelope.fadeInSec).toBeCloseTo(0.2, 9);
    expect(c.whenTimelineSec).toBeCloseTo(4.5, 9);
  });

  it("places a crossfaded clip and the clock shift from the render's frontier, not from authored starts", () => {
    const join = {
      source_duration_sec: 10,
      join_in_mode: "crossfade" as const,
      join_crossfade_ms: 200,
      join_borrow_sec: 0.1,
      fade_in_ms: 400,
      fade_out_ms: 400,
    };
    const rows = (bStart: number) => [
      clip({
        id: "a",
        timeline_start: 0,
        timeline_end: 2,
        source_end: 2,
        source_duration_sec: 10,
        fade_out_ms: 400,
      }),
      clip({
        id: "b",
        source_start: 2,
        source_end: 4,
        timeline_start: bStart,
        timeline_end: bStart + 2,
        join_left_clip_id: "a",
        ...join,
      }),
      clip({
        id: "c",
        source_start: 4,
        source_end: 6,
        timeline_start: 4.5,
        timeline_end: 6.5,
      }),
    ];
    const early = buildSchedule(rows(1.9), 0, 20, manifest());
    expect(early.map((s) => s.whenTimelineSec)).toEqual([
      0,
      expect.closeTo(1.9, 9),
      expect.closeTo(4.6, 9),
    ]);
    const late = buildSchedule(rows(2.04), 0, 20, manifest());
    expect(late[1].whenTimelineSec).toBeCloseTo(1.9, 9);
  });

  it("closes a plain join gap inside the tolerance and carries it as render does", () => {
    const slices = buildSchedule(
      [
        clip({ id: "a", timeline_start: 0, timeline_end: 2 }),
        clip({
          id: "b",
          timeline_start: 2.04,
          timeline_end: 4.04,
          join_left_clip_id: "a",
        }),
        clip({ id: "c", timeline_start: 5, timeline_end: 6 }),
      ],
      0,
      20,
      manifest(),
    );
    expect(slices.map((s) => s.whenTimelineSec)).toEqual([
      0,
      2,
      expect.closeTo(4.96, 9),
    ]);
  });

  it("leaves a blocked or other-lane crossfade join where it was authored", () => {
    const rows = [
      clip({ id: "a", timeline_start: 0, timeline_end: 2, fade_out_ms: 100 }),
      clip({
        id: "b",
        timeline_start: 2,
        timeline_end: 4,
        join_left_clip_id: "a",
        join_in_mode: "crossfade",
        join_crossfade_ms: 0,
        join_crossfade_blocked: "no_fade_in",
        fade_in_ms: 0,
      }),
      clip({
        id: "other",
        track_id: "guest",
        timeline_start: 5,
        timeline_end: 6,
        join_left_clip_id: "x",
        join_in_mode: "crossfade",
        join_crossfade_ms: 100,
      }),
    ];
    const base = manifest();
    const m = { ...base, tracks: { ...base.tracks, guest: base.tracks.host } };
    const slices = buildSchedule(rows, 0, 20, m);
    expect(slices.map((s) => s.whenTimelineSec)).toEqual([0, 2, 5]);
    expect(slices[1].envelope.fadeInSec).toBe(0);
  });

  it("carries off-speaker mutes, except on a clip whose occurrence proxy bakes them in", () => {
    const regions = [{ start_s: 1, end_s: 2, fade_out_ms: 20, fade_in_ms: 30 }];
    const [plain] = buildSchedule(
      [clip({ id: "c1", off_speaker_mute_regions: regions })],
      0,
      30,
      manifest(),
    );
    expect(plain.envelope.automaticMute).toEqual([
      { start: 1, end: 2, fadeOutSec: 0.02, fadeInSec: 0.03 },
    ]);
    const artifactId = "b".repeat(16);
    const m = manifest();
    const baked = {
      ...m,
      artifacts: { [artifactId]: m.tracks.host },
      occurrences: {
        c1: { artifactId, outputTrackId: "host", bakesMutes: true },
      },
    };
    const [slice] = buildSchedule(
      [clip({ id: "c1", off_speaker_mute_regions: regions })],
      0,
      30,
      baked,
    );
    expect(slice.envelope.automaticMute).toEqual([]);
  });

  it("reads origin media but plays it through the lane the clip sits on, as render does", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          track_id: "guest",
          origin_track_id: "host",
          source_start: 0,
          source_end: 2,
          timeline_start: 0,
          timeline_end: 2,
        }),
      ],
      0,
      10,
      manifest(),
    );
    expect(slices[0]?.outputTrackId).toBe("guest");
    expect(slices[0]?.chunk.artifactId).toBe("host");
  });
});

describe("manifest boundary and occurrence scheduling", () => {
  it("requires the complete wire shape and a nonnullable history head", () => {
    const valid = manifest();
    expect(parseProxyManifest(valid)).toEqual(valid);
    for (const key of [
      "revision",
      "project_basis",
      "tracks",
      "artifacts",
      "occurrences",
    ]) {
      const raw: Record<string, unknown> = { ...valid };
      delete raw[key];
      expect(() => parseProxyManifest(raw)).toThrow();
    }
    expect(() =>
      parseProxyManifest({
        ...valid,
        project_basis: { ...valid.project_basis, history_head_id: null },
      }),
    ).toThrow();
    expect(() =>
      parseProxyManifest({
        ...valid,
        tracks: { host: { ...valid.tracks.host, urls: ["one"] } },
      }),
    ).toThrow();
    expect(() =>
      parseProxyManifest({
        ...valid,
        tracks: { host: { ...valid.tracks.host, chunk_sec: 0 } },
      }),
    ).toThrow();
    expect(() =>
      parseProxyManifest({
        ...valid,
        tracks: { host: { ...valid.tracks.host, hash: "bad" } },
      }),
    ).toThrow();
    expect(
      parseProxyManifest({
        ...valid,
        tracks: { host: { ...valid.tracks.host, hash: "b".repeat(64) } },
      }).tracks.host.hash,
    ).toHaveLength(64);
  });

  it("rejects an occurrence binding that does not say whether it bakes mutes", () => {
    const artifactId = "b".repeat(64);
    const base = manifest();
    const valid: ProxyManifest = {
      ...base,
      project_basis: {
        ...base.project_basis,
        clips: {
          c1: {
            track_id: "host",
            origin_track_id: "host",
            source_id: null,
            source_start: 0,
            source_end: 1,
            timeline_start: 0,
            timeline_end: 1,
          },
        },
      },
      artifacts: { [artifactId]: { ...base.tracks.host, hash: artifactId } },
      occurrences: {
        c1: { artifactId, outputTrackId: "host", bakesMutes: false },
      },
    };
    expect(parseProxyManifest(valid)).toEqual(valid);
    expect(() =>
      parseProxyManifest({
        ...valid,
        occurrences: { c1: { artifactId, outputTrackId: "host" } },
      }),
    ).toThrow();
  });

  it("resolves only the bound occurrence before geometry and routes to the clip's lane", () => {
    const selected = clip({
      id: "selected",
      track_id: "destination",
      origin_track_id: "host",
      source_start: 3,
      source_end: 9,
      timeline_start: 10,
      timeline_end: 16,
      fade_in_ms: 5000,
    });
    const unselected = clip({
      ...selected,
      id: "unselected",
      timeline_start: 20,
      timeline_end: 26,
    });
    const artifactId = "b".repeat(64);
    const m: ProxyManifest = {
      ...manifest(),
      artifacts: {
        [artifactId]: {
          hash: artifactId,
          chunk_sec: 4,
          overlap_ms: 500,
          chunk_count: 3,
          duration_sec: 12,
          urls: ["variant0", "variant1", "variant2"],
        },
      },
      occurrences: {
        selected: {
          artifactId,
          outputTrackId: "secondary-output",
          bakesMutes: true,
        },
      },
    };
    const slices = buildSchedule([selected, unselected], 0, 30, m);
    expect(slices.map((s) => s.chunk.url)).toEqual([
      "variant0",
      "variant1",
      "variant2",
      "legacy0",
    ]);
    expect(slices.map((s) => s.bufferOffsetSec)).toEqual([3, 0.5, 0.5, 3]);
    expect(slices.map((s) => s.outputTrackId)).toEqual([
      "destination",
      "destination",
      "destination",
      "destination",
    ]);
    expect(slices[1].envelope).toEqual(slices[0].envelope);
    expect(slices[3].chunk).toMatchObject({
      kind: "track",
      artifactId: "host",
      hash: "a".repeat(16),
    });
    expect(() =>
      buildSchedule([selected], 0, 30, { ...m, artifacts: {} }),
    ).toThrow();
  });

  it("builds a public basis without recording identity or private choice state", () => {
    const c = clip({
      id: "a",
      track_id: "guest",
      origin_track_id: "host",
      recording_key: "private",
    });
    const project = minimalProject({
      clips: { tracks: { guest: [c] }, clip_count: 1 },
    });
    const basis = projectProxyBasis(project);
    expect(basis.history_head_id).toBe("root");
    expect(basis.clips.a.origin_track_id).toBe("host");
    expect(JSON.stringify(basis)).not.toContain("private");
    expect(proxyBasisKey(basis)).toBe(
      proxyBasisKey({ ...basis, clips: { a: { ...basis.clips.a } } }),
    );
  });

  it("accepts exactly an ordered placement replay and refuses authored or unsupported changes", () => {
    const c = clip({ id: "a" });
    const basis = projectProxyBasis(
      minimalProject({ clips: { tracks: { host: [c] }, clip_count: 1 } }),
    );
    const m = { ...manifest(), project_basis: basis };
    const moved = {
      ...basis,
      clips: {
        a: {
          ...basis.clips.a,
          track_id: "guest",
          timeline_start: 12,
          timeline_end: 22,
        },
      },
    };
    const queue = [
      {
        type: "MoveClips",
        payload: {
          clips: [{ clip_id: "a", track_id: "host", timeline_start: 3 }],
        },
      },
      {
        type: "MoveClips",
        payload: {
          clips: [{ clip_id: "a", track_id: "guest", timeline_start: 12 }],
        },
      },
    ];
    expect(isQueuedMoveOverlay(m, moved, queue, ["host", "guest"])).toBe(true);
    expect(
      isQueuedMoveOverlay(m, moved, queue.toReversed(), ["host", "guest"]),
    ).toBe(false);
    expect(isQueuedMoveOverlay(m, moved, [], ["host", "guest"])).toBe(false);
    expect(
      isQueuedMoveOverlay(
        m,
        { ...moved, render_hashes: { host: "changed" } },
        queue,
        ["host", "guest"],
      ),
    ).toBe(false);
    expect(
      isQueuedMoveOverlay(
        m,
        {
          ...moved,
          clips: { a: { ...moved.clips.a, source_id: "secondary" } },
        },
        queue,
        ["host", "guest"],
      ),
    ).toBe(false);
    expect(
      isQueuedMoveOverlay(
        m,
        moved,
        [{ type: "Restore", payload: {} }],
        ["host", "guest"],
      ),
    ).toBe(false);
    expect(
      isQueuedMoveOverlay(
        { ...m, artifacts: { variant: m.tracks.host } },
        moved,
        queue,
        ["host", "guest"],
      ),
    ).toBe(false);
  });
});

describe("proxy audio identity", () => {
  function audible() {
    return projectProxyBasis(
      minimalProject({
        clips: {
          tracks: {
            host: [clip({ id: "a", source_id: "src" }), clip({ id: "b" })],
          },
          clip_count: 2,
        },
        render_status: {
          needs_rerender: false,
          reconciliation: { stale: false },
          premix: { exists: false },
          tracks: { host: { render_hash: "h1" }, guest: { render_hash: "g1" } },
        },
      }),
    );
  }

  it("proxyBasisKey ignores history_head_id", () => {
    const basis = audible();
    expect(proxyBasisKey({ ...basis, history_head_id: "after-comment" })).toBe(
      proxyBasisKey(basis),
    );
  });

  it("proxyBasisKey changes for each audible input", () => {
    const basis = audible();
    const key = proxyBasisKey(basis);
    const changed = [
      { ...basis, render_hashes: { ...basis.render_hashes, host: "h2" } },
      {
        ...basis,
        clips: {
          ...basis.clips,
          a: { ...basis.clips.a, timeline_start: 1 },
        },
      },
      {
        ...basis,
        clips: { ...basis.clips, a: { ...basis.clips.a, track_id: "guest" } },
      },
    ];
    for (const next of changed) expect(proxyBasisKey(next)).not.toBe(key);
  });

  it("isQueuedMoveOverlay ignores a differing history_head_id", () => {
    const basis = audible();
    const m = { ...manifest(), project_basis: basis };
    const moved = {
      ...basis,
      history_head_id: "after-comment",
      clips: {
        ...basis.clips,
        a: {
          ...basis.clips.a,
          track_id: "guest",
          timeline_start: 12,
          timeline_end: 22,
        },
      },
    };
    const queue = [
      {
        type: "MoveClips",
        payload: {
          clips: [{ clip_id: "a", track_id: "guest", timeline_start: 12 }],
        },
      },
    ];
    expect(isQueuedMoveOverlay(m, moved, queue, ["host", "guest"])).toBe(true);
  });
});

describe("episodeEndSec", () => {
  const lanes = (...ends: number[]) => ({
    host: ends.map((end, i) => clip({ id: `c${i}`, timeline_end: end })),
  });

  it("keeps a stored duration that is later than every clip", () => {
    expect(episodeEndSec(60, lanes(10, 30))).toBe(60);
  });

  it("uses the last clip end when the stored duration is shorter", () => {
    expect(episodeEndSec(20, lanes(10, 30))).toBe(30);
  });

  it("uses the stored duration when there are no clips", () => {
    expect(episodeEndSec(45, {})).toBe(45);
    expect(episodeEndSec(45, { host: [] })).toBe(45);
  });

  it("uses the last clip end when the stored duration is 0", () => {
    expect(episodeEndSec(0, lanes(12))).toBe(12);
  });

  it("keeps an unknown duration unknown and ignores a non-finite value", () => {
    expect(episodeEndSec(Number.POSITIVE_INFINITY, lanes(30))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(episodeEndSec(Number.NaN, lanes(30))).toBe(30);
    expect(episodeEndSec(20, lanes(Number.NaN, 25))).toBe(25);
  });
});

const KEY = JSON.parse(
  readFileSync(
    join(SRC_ROOT, "../../../tests/fixtures/proxy_basis/key.json"),
    "utf8",
  ),
) as {
  view_hashes: string[];
  manifest_hashes: string[];
  clip_fields: string[];
};

function walk(value: unknown, path: readonly string[]): unknown {
  if (path.length === 0) return value;
  if (!value || typeof value !== "object") return undefined;
  const [head, ...rest] = path;
  const record = value as Record<string, unknown>;
  if (head !== "*") return walk(record[head], rest);
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, item]) => {
      const found = walk(item, rest);
      return found ? [[key, found]] : [];
    }),
  );
}

describe("the proxy key reads what tests/fixtures/proxy_basis/key.json names", () => {
  const row = clip({
    id: "a",
    track_id: "guest",
    origin_track_id: "host",
    source_id: "src",
    source_start: 1,
    source_end: 4,
    timeline_start: 2,
    timeline_end: 5,
  });
  const project = minimalProject({
    clips: { tracks: { guest: [row] }, clip_count: 1 },
    render_status: {
      needs_rerender: false,
      reconciliation: { stale: false },
      premix: { exists: false },
      tracks: {
        host: { render_hash: "stem-host" },
        guest: { render_hash: "" },
      },
      proxy_hashes: { host: "proxy-host", music: "proxy-music" },
    } as ProjectView["render_status"],
  });

  it("takes the per-track hashes from the view path the contract names", () => {
    expect(projectProxyBasis(project).render_hashes).toEqual(
      walk(project, KEY.view_hashes) ?? {},
    );
  });

  it("matches the manifest's hashes at the path the contract names", () => {
    const wire = {
      revision: "r",
      project_basis: {
        history_head_id: "root",
        render_hashes: { host: "proxy-host" },
        clips: {},
      },
      tracks: {},
      artifacts: {},
      occurrences: {},
    };
    expect(parseProxyManifest(wire).project_basis.render_hashes).toEqual(
      walk(wire.project_basis, KEY.manifest_hashes),
    );
  });

  it("keys each clip on exactly the contract's fields", () => {
    const basis = projectProxyBasis(project);
    expect(Object.keys(basis.clips.a).sort()).toEqual(
      [...KEY.clip_fields].sort(),
    );
    const key = proxyBasisKey(basis);
    for (const field of KEY.clip_fields) {
      const changed = {
        ...basis,
        clips: { a: { ...basis.clips.a, [field]: 99 } },
      };
      expect(proxyBasisKey(changed), field).not.toBe(key);
    }
    const unread = Object.keys(row).filter(
      (field) => field !== "id" && !KEY.clip_fields.includes(field),
    );
    expect(unread.length).toBeGreaterThan(0);
    for (const field of unread) {
      const other = minimalProject({
        ...project,
        clips: {
          tracks: { guest: [{ ...row, [field]: "changed" }] },
          clip_count: 1,
        },
      });
      expect(proxyBasisKey(projectProxyBasis(other)), field).toBe(key);
    }
  });
});
