import { beforeEach, describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView, Selection } from "../types/project";
import {
  type BounceRequest,
  bounceBody,
  bounceRequestOf,
  bounceResultCopy,
  bounceTracks,
  EXPORT_RANGE_DEFAULTS,
  EXPORT_RANGE_STORAGE_KEY,
  type ExportScope,
  exportScopeOf,
  readExportRangeChoices,
  usableChoices,
  writeExportRangeChoices,
} from "./exportRange";
import { makeRangeTarget } from "./rangeSelection";

function episode(): ProjectView {
  const tracks = [
    sampleTrack({ id: "host" }),
    sampleTrack({ id: "guest" }),
    sampleTrack({ id: "muted", muted: true }),
    sampleTrack({ id: "bed", role: "music" }),
    sampleTrack({ id: "scratch", role: "scratch" }),
    sampleTrack({
      id: "empty",
      media_path: null,
      duration_sec: 0,
      has_source_audio: false,
    }),
  ];
  return minimalProject({
    tracks,
    clips: {
      tracks: Object.fromEntries(
        tracks.map((t) => [
          t.id,
          [
            clipRow({
              id: `${t.id}-1`,
              track_id: t.id,
              timeline_start: 700,
              timeline_end: 1100,
            }),
          ],
        ]),
      ),
      clip_count: tracks.length,
    },
  });
}

const rangeScope = (trackIds: string[]): ExportScope => ({
  intervals: [{ start: 724, end: 1024 }],
  trackIds,
});
const wholeScope = (trackIds: string[] = []): ExportScope => ({
  intervals: null,
  trackIds,
});

describe("export range choices", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to the full mix as WAV only", () => {
    expect(readExportRangeChoices()).toEqual({
      source: "mix",
      includeMp3: false,
    });
    expect(EXPORT_RANGE_DEFAULTS).toEqual({ source: "mix", includeMp3: false });
  });

  it("round-trips through localStorage", () => {
    writeExportRangeChoices({ source: "soloed", includeMp3: true });
    expect(localStorage.getItem(EXPORT_RANGE_STORAGE_KEY)).toBe(
      '{"source":"soloed","includeMp3":true}',
    );
    expect(readExportRangeChoices()).toEqual({
      source: "soloed",
      includeMp3: true,
    });
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["an unknown source", '{"source":"everything","includeMp3":true}'],
  ])("falls back to the defaults for %s", (_name, raw) => {
    localStorage.setItem(EXPORT_RANGE_STORAGE_KEY, raw);
    expect(readExportRangeChoices().source).toBe("mix");
  });

  it("keeps a valid mp3 flag beside an unknown source", () => {
    localStorage.setItem(
      EXPORT_RANGE_STORAGE_KEY,
      '{"source":"everything","includeMp3":true}',
    );
    expect(readExportRangeChoices()).toEqual({
      source: "mix",
      includeMp3: true,
    });
  });
});

describe("exportScopeOf", () => {
  const range = makeRangeTarget(
    episode(),
    [{ start: 724, end: 1024 }],
    ["host", "guest"],
  )!;

  it("reads a range selection", () => {
    expect(exportScopeOf(episode(), { kind: "range", target: range })).toEqual({
      ok: true,
      scope: {
        intervals: [{ start: 724, end: 1024 }],
        trackIds: ["host", "guest"],
      },
    });
  });

  it("reads a track selection as tracks without a range", () => {
    const selection: Selection = {
      kind: "track",
      trackId: "host",
      trackIds: ["host", "bed"],
    };
    expect(exportScopeOf(episode(), selection)).toEqual({
      ok: true,
      scope: { intervals: null, trackIds: ["host", "bed"] },
    });
  });

  it.each([
    ["nothing", null],
    ["a clip", { kind: "clip", id: "host-1", trackId: "host" } as Selection],
  ])("reads %s as the whole episode", (_name, selection) => {
    expect(exportScopeOf(episode(), selection as Selection)).toEqual({
      ok: true,
      scope: { intervals: null, trackIds: [] },
    });
  });
});

describe("bounceTracks", () => {
  const project = episode();
  const none = {};

  it("mix takes every audible bounceable track", () => {
    expect(bounceTracks(project, wholeScope(), "mix", none)).toEqual({
      ok: true,
      trackIds: ["host", "guest", "bed"],
    });
  });

  it("selected intersects the scope with the bounceable tracks", () => {
    expect(
      bounceTracks(
        project,
        rangeScope(["guest", "muted", "scratch", "empty"]),
        "selected",
        none,
      ),
    ).toEqual({ ok: true, trackIds: ["guest", "muted"] });
  });

  it("soloed intersects the solo set with the bounceable tracks", () => {
    expect(
      bounceTracks(project, wholeScope(), "soloed", {
        bed: true,
        host: false,
        muted: true,
        scratch: true,
      }),
    ).toEqual({ ok: true, trackIds: ["muted", "bed"] });
  });

  it("explains why selected is empty with no tracks", () => {
    expect(bounceTracks(project, wholeScope(), "selected", none)).toEqual({
      ok: false,
      reason: "Select a track first.",
    });
  });

  it("explains why selected is empty when none of them is audible", () => {
    expect(
      bounceTracks(project, rangeScope(["scratch", "empty"]), "selected", none),
    ).toEqual({
      ok: false,
      reason: "The selected tracks have nothing audible.",
    });
  });

  it("explains why soloed is empty", () => {
    expect(bounceTracks(project, wholeScope(), "soloed", none)).toEqual({
      ok: false,
      reason: "Solo one or more tracks first.",
    });
    expect(
      bounceTracks(project, wholeScope(), "soloed", { empty: true }),
    ).toEqual({ ok: false, reason: "The soloed tracks have nothing audible." });
  });

  it("explains why mix is empty", () => {
    const silent = minimalProject({
      tracks: [sampleTrack({ id: "host", muted: true })],
    });
    expect(bounceTracks(silent, wholeScope(), "mix", none)).toEqual({
      ok: false,
      reason: "Nothing audible to export.",
    });
  });
});

describe("bounceRequestOf", () => {
  const project = episode();
  const choices = { source: "mix", includeMp3: false } as const;

  it("builds the range from the audible tracks for the full mix", () => {
    const made = bounceRequestOf(project, rangeScope(["host"]), choices, {});
    const expected = makeRangeTarget(
      project,
      [{ start: 724, end: 1024 }],
      ["host", "guest", "bed"],
    );
    expect(made).toEqual({
      ok: true,
      request: {
        range: expected,
        trackIds: ["host", "guest", "bed"],
        source: "mix",
        includeMp3: false,
      },
    });
    expect(expected?.track_ids).toEqual(["host", "guest", "bed"]);
  });

  it("keeps the selected tracks for selected tracks", () => {
    const made = bounceRequestOf(
      project,
      rangeScope(["host", "muted"]),
      { source: "selected", includeMp3: true },
      {},
    );
    expect(made.ok && made.request.range?.track_ids).toEqual(["host", "muted"]);
    expect(made.ok && made.request.includeMp3).toBe(true);
  });

  it("leaves the range null for the whole episode", () => {
    expect(bounceRequestOf(project, wholeScope(), choices, {})).toEqual({
      ok: true,
      request: {
        range: null,
        trackIds: null,
        source: "mix",
        includeMp3: false,
      },
    });
  });

  it("exports a track selection whole-length as the selected tracks", () => {
    expect(
      bounceRequestOf(project, wholeScope(["guest"]), choices, {}),
    ).toEqual({
      ok: true,
      request: {
        range: null,
        trackIds: ["guest"],
        source: "selected",
        includeMp3: false,
      },
    });
  });

  it("passes the solo ids for soloed", () => {
    const made = bounceRequestOf(
      project,
      wholeScope(),
      { source: "soloed", includeMp3: false },
      { bed: true },
    );
    expect(made.ok && made.request.trackIds).toEqual(["bed"]);
  });

  it("refuses a range that overlaps no clip", () => {
    expect(
      bounceRequestOf(
        project,
        { intervals: [{ start: 90000, end: 90100 }], trackIds: ["host"] },
        choices,
        {},
      ),
    ).toEqual({ ok: false, reason: "Nothing audible in this range." });
  });

  it("carries the reason when no track applies", () => {
    expect(
      bounceRequestOf(
        project,
        wholeScope(),
        { source: "soloed", includeMp3: false },
        {},
      ),
    ).toEqual({ ok: false, reason: "Solo one or more tracks first." });
  });
});

describe("bounceBody", () => {
  const range = makeRangeTarget(
    episode(),
    [{ start: 724, end: 1024 }],
    ["host"],
  )!;
  const request = (over: Partial<BounceRequest>): BounceRequest => ({
    range: null,
    trackIds: null,
    source: "mix",
    includeMp3: false,
    ...over,
  });

  it("sends the exact range alone for a range", () => {
    expect(bounceBody(request({ range, trackIds: ["host"] }))).toEqual({
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
      exact_range: range,
    });
  });

  it("sends no track ids for the whole mix", () => {
    expect(bounceBody(request({ includeMp3: true }))).toEqual({
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav", "mp3"],
    });
  });

  it("sends the chosen tracks for a whole-length export of them", () => {
    expect(
      bounceBody(request({ trackIds: ["host", "bed"], source: "selected" })),
    ).toEqual({
      track_ids: ["host", "bed"],
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
  });
});

describe("bounceResultCopy", () => {
  const range = makeRangeTarget(
    episode(),
    [{ start: 724, end: 1024 }],
    ["host"],
  )!;

  it("names the range, the source and the format", () => {
    expect(
      bounceResultCopy({
        range,
        trackIds: ["host"],
        source: "mix",
        includeMp3: false,
      }),
    ).toBe("Exported 12:04–17:04 (full mix) as WAV");
  });

  it("names the selected tracks and both formats", () => {
    expect(
      bounceResultCopy({
        range,
        trackIds: ["host"],
        source: "selected",
        includeMp3: true,
      }),
    ).toBe("Exported 12:04–17:04 (selected tracks) as WAV and MP3");
  });

  it("describes the whole episode without a range", () => {
    expect(
      bounceResultCopy({
        range: null,
        trackIds: null,
        source: "mix",
        includeMp3: false,
      }),
    ).toBe("Exported the full mix as WAV");
    expect(
      bounceResultCopy({
        range: null,
        trackIds: ["bed"],
        source: "soloed",
        includeMp3: true,
      }),
    ).toBe("Exported the soloed tracks as WAV and MP3");
  });
});

describe("usableChoices", () => {
  const project = episode();

  it("keeps a source that has tracks", () => {
    expect(
      usableChoices(
        project,
        wholeScope(),
        { source: "soloed", includeMp3: true },
        { bed: true },
      ),
    ).toEqual({ source: "soloed", includeMp3: true });
  });

  it.each(["soloed", "selected"] as const)(
    "falls back to the full mix when %s has no tracks, keeping MP3",
    (source) => {
      expect(
        usableChoices(project, wholeScope(), { source, includeMp3: true }, {}),
      ).toEqual({ source: "mix", includeMp3: true });
    },
  );
});
