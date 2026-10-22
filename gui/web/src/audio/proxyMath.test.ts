import { describe, expect, it } from "vitest";
import { minimalProject } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import {
  buildSchedule,
  chunkFileStartSec,
  chunkIndexForSource,
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
      occurrences: { c1: { artifactId, outputTrackId: "host" } },
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

  it("marks equalPower for crossfade joins", () => {
    const slices = buildSchedule(
      [
        clip({
          id: "c1",
          join_in_mode: "crossfade",
          fade_in_ms: 30,
        }),
      ],
      0,
      20,
      manifest(),
    );
    expect(slices[0].envelope.gainCurve).toBe("equalPower");
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
    // Each side borrows half the 0.2 s blend from its recording past the seam.
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
    // b authored 0.1 s early: the blend still starts at the seam less the borrow,
    // and c moves 0.1 s later with the frontier.
    const early = buildSchedule(rows(1.9), 0, 20, manifest());
    expect(early.map((s) => s.whenTimelineSec)).toEqual([
      0,
      expect.closeTo(1.9, 9),
      expect.closeTo(4.6, 9),
    ]);
    // b authored 0.04 s late (inside the join tolerance) still starts at 1.9.
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
      occurrences: { c1: { artifactId, outputTrackId: "host" } },
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
        selected: { artifactId, outputTrackId: "secondary-output" },
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
        { ...moved, history_head_id: "first-restore" },
        queue,
        ["host", "guest"],
      ),
    ).toBe(false);
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
