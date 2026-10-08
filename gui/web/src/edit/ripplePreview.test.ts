import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractClip,
  type ContractSource,
  type ContractTrack,
  contractClipRow,
  contractTrack,
} from "../test/contractProject";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import type { ClipRow, ProjectView } from "../types/project";
import type { EditMode, TrimEdge } from "./clipEdgePreview";
import {
  laneRipple,
  rippleMoves,
  rippleTrackIds,
  rippleTrimOf,
  trimDraft,
} from "./ripplePreview";

type Contract = {
  scope_cases: {
    name: string;
    tracks: { id: string; role: string; muted?: boolean }[];
    edited: string[];
    scope: string[];
  }[];
  trim_tracks: ContractTrack[];
  trim_sources: ContractSource[];
  trim_cases: {
    name: string;
    clips: Record<string, ContractClip[]>;
    trim: {
      clip_id: string;
      edge: TrimEdge;
      source_sec: number;
      mode: EditMode;
    };
    lanes: Record<string, [number, number, number, number][]>;
    arrows: Record<string, [number, number][]>;
    cuts: Record<string, [number, number]>;
  }[];
};

const CONTRACT = JSON.parse(
  readFileSync(join(SRC_ROOT, "../../../contracts/ripple-scope.json"), "utf8"),
) as Contract;

function caseProject(c: Contract["trim_cases"][number]): ProjectView {
  const lanes: Record<string, ClipRow[]> = {};
  for (const [trackId, rows] of Object.entries(c.clips)) {
    const track = CONTRACT.trim_tracks.find((t) => t.id === trackId)!;
    lanes[trackId] = rows.map((row) =>
      contractClipRow(track, CONTRACT.trim_sources, row),
    );
  }
  return minimalProject({
    tracks: CONTRACT.trim_tracks.map(contractTrack),
    clips: {
      tracks: lanes,
      clip_count: Object.values(lanes).flat().length,
    },
  });
}

const near = (rows: number[][]) =>
  rows.map((row) => row.map((v) => expect.closeTo(v, 9)));

describe("ripple scope matches ripple_track_ids (contracts/ripple-scope.json)", () => {
  it.each(CONTRACT.scope_cases)("$name", ({ tracks, edited, scope }) => {
    expect(
      rippleTrackIds(
        tracks.map((t) => sampleTrack(t)),
        edited,
      ),
    ).toEqual(scope);
  });
});

describe("a trim preview matches what the trim saves (contracts/ripple-scope.json)", () => {
  it.each(CONTRACT.trim_cases)("$name", (c) => {
    const project = caseProject(c);
    const { clip_id, edge, source_sec, mode } = c.trim;
    const trackId = Object.keys(c.clips).find((id) =>
      c.clips[id].some(([cid]) => cid === clip_id),
    )!;
    const clip = project.clips.tracks[trackId].find((r) => r.id === clip_id)!;

    const drafted = trimDraft(
      project,
      trackId,
      clip_id,
      edge,
      source_sec,
      mode,
    );
    for (const [id, rows] of Object.entries(c.lanes)) {
      expect(
        drafted.clips.tracks[id].map((r) => [
          r.timeline_start,
          r.timeline_end,
          r.source_start,
          r.source_end,
        ]),
        id,
      ).toEqual(near(rows));
    }

    const trimmed =
      edge === "in"
        ? { edge, sourceStart: source_sec, sourceEnd: clip.source_end }
        : { edge, sourceStart: clip.source_start, sourceEnd: source_sec };
    const trim = rippleTrimOf(clip, trimmed, mode);
    const scope = rippleTrackIds(project.tracks, [trackId]);
    for (const track of project.tracks) {
      const lane = project.clips.tracks[track.id] ?? [];
      const ripple = trim ? laneRipple(trim, track, lane, scope) : null;
      const arrows = rippleMoves(lane, ripple).map((m) => [m.fromSec, m.toSec]);
      expect(arrows, track.id).toEqual(near(c.arrows[track.id] ?? []));
      const cut = ripple?.cut ? [ripple.cut.start, ripple.cut.end] : null;
      expect(cut, track.id).toEqual(
        c.cuts[track.id] ? near([c.cuts[track.id]])[0] : null,
      );
      // Each arrow lands where the saved trim puts a clip.
      const starts = c.lanes[track.id]?.map(([start]) => start) ?? [];
      for (const [, to] of arrows) {
        expect(
          starts.some((s) => Math.abs(s - to) < 1e-9),
          track.id,
        ).toBe(true);
      }
    }
  });
});

describe("ripple preview on a multi-track project (#1135)", () => {
  const host = sampleTrack({ id: "host" });
  const guest = sampleTrack({ id: "guest" });
  const music = sampleTrack({ id: "music", role: "music" });
  const row = (id: string, trackId: string, start: number, end: number) =>
    clipRow({
      id,
      track_id: trackId,
      timeline_start: start,
      timeline_end: end,
      source_start: start,
      source_end: end,
    });
  const lanes = {
    host: [
      row("a", "host", 0, 10),
      row("b", "host", 10, 20),
      row("c", "host", 25, 30),
    ],
    guest: [row("g1", "guest", 0, 18), row("g2", "guest", 22, 30)],
    music: [row("m", "music", 0, 30)],
  };
  const scope = rippleTrackIds([host, guest, music], ["host"]);

  it("shortening a clip's end moves every dialogue lane's later clips by the same amount", () => {
    const trim = rippleTrimOf(
      lanes.host[0],
      { edge: "out", sourceStart: 0, sourceEnd: 8 },
      "ripple",
    );
    expect(trim).toEqual({
      clipId: "a",
      trackId: "host",
      edge: "out",
      startSec: 0,
      endSec: 10,
      deltaSec: -2,
    });
    const moves = (track: typeof host, lane: ClipRow[]) =>
      rippleMoves(lane, laneRipple(trim!, track, lane, scope));
    expect(moves(host, lanes.host)).toEqual([
      { key: "b", fromSec: 10, toSec: 8 },
      { key: "c", fromSec: 25, toSec: 23 },
    ]);
    expect(moves(guest, lanes.guest)).toEqual([
      { key: "g1:tail", fromSec: 10, toSec: 8 },
      { key: "g2", fromSec: 22, toSec: 20 },
    ]);
    expect(moves(music, lanes.music)).toEqual([]);
    expect(laneRipple(trim!, guest, lanes.guest, scope)?.cut).toEqual({
      start: 8,
      end: 10,
    });
    expect(laneRipple(trim!, host, lanes.host, scope)?.cut).toBeNull();
  });

  it("lengthening a start opens the same time on the other lanes", () => {
    const trim = rippleTrimOf(
      { ...lanes.host[2], source_start: 30, source_end: 35 },
      { edge: "in", sourceStart: 27, sourceEnd: 35 },
      "ripple",
    );
    const ripple = laneRipple(trim!, guest, lanes.guest, scope);
    expect(ripple).toEqual({
      fromSec: 25,
      deltaSec: 3,
      peer: null,
      cut: null,
    });
    expect(rippleMoves(lanes.guest, ripple)).toEqual([
      { key: "g2:tail", fromSec: 25, toSec: 28 },
    ]);
  });

  it("a gap trim moves nothing downstream", () => {
    expect(
      rippleTrimOf(
        lanes.host[0],
        { edge: "out", sourceStart: 0, sourceEnd: 8 },
        "gap",
      ),
    ).toBeNull();
    expect(rippleMoves(lanes.guest, null)).toEqual([]);
  });

  it("moves nothing for a trim back to where it started", () => {
    expect(
      rippleTrimOf(
        lanes.host[1],
        { edge: "out", sourceStart: 10, sourceEnd: 20 },
        "ripple",
      ),
    ).toBeNull();
  });

  it("draws no zero-length clip where another lane's clip starts a float rounding before the removed span", () => {
    const noisy = 8 - 8.9e-16;
    const project = minimalProject({
      tracks: [host, guest],
      clips: {
        tracks: {
          host: [row("a", "host", 0, 10)],
          guest: [
            clipRow({
              id: "g",
              track_id: "guest",
              timeline_start: noisy,
              timeline_end: 20,
              source_start: noisy,
              source_end: 20,
            }),
          ],
        },
        clip_count: 2,
      },
    });
    const drafted = trimDraft(project, "host", "a", "out", 8, "ripple");
    expect(
      drafted.clips.tracks.guest.map((c) => [
        c.id,
        c.timeline_start,
        c.timeline_end,
        c.source_start,
        c.source_end,
      ]),
    ).toEqual([
      [
        "g",
        expect.closeTo(8, 9),
        expect.closeTo(18, 9),
        expect.closeTo(10, 9),
        expect.closeTo(20, 9),
      ],
    ]);
  });
});
