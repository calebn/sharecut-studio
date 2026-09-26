import { describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow, ProjectView } from "../types/project";
import { mergeProjectPatch, projectFromDocumentSnapshot } from "./projectPatch";
import { reuseUnchanged } from "./reuseUnchanged";

function clip(
  id: string,
  start: number,
  extra: Partial<ClipRow> = {},
): ClipRow {
  return {
    id,
    track_id: "host",
    source_start: start,
    source_end: start + 1,
    timeline_start: start,
    timeline_end: start + 1,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...extra,
  };
}

function project(): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: {
      tracks: {
        host: [
          clip("a", 0, { mute_regions: [{ start_s: 0.1, end_s: 0.2 }] }),
          clip("b", 1),
        ],
        guest: [clip("c", 0, { track_id: "guest" })],
      },
      clip_count: 3,
    },
  });
}

/** A deep copy, as a fresh server projection arrives. */
function fresh(p: ProjectView): ProjectView {
  return structuredClone(p);
}

describe("reuseUnchanged", () => {
  it("takes a changed clips field other than the lanes", () => {
    const prev = project();
    const next = fresh(prev);
    (next.clips as unknown as Record<string, unknown>).gap_sec = 2;
    const out = reuseUnchanged(prev, next);
    expect(out.clips).not.toBe(prev.clips);
    expect((out.clips as unknown as Record<string, unknown>).gap_sec).toBe(2);
    expect(out.clips.tracks).toBe(prev.clips.tracks);
  });

  it("returns next when there is no previous projection", () => {
    const next = project();
    expect(reuseUnchanged(null, next)).toBe(next);
  });

  it("reuses tracks, lanes and clips of an equal projection", () => {
    const prev = project();
    const out = reuseUnchanged(prev, fresh(prev));
    expect(out.tracks).toBe(prev.tracks);
    expect(out.clips).toBe(prev.clips);
  });

  it("replaces only the changed clip; its lane is new, others are kept", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.host![1] = {
      ...next.clips.tracks.host![1]!,
      fade_in_ms: 20,
    };
    const out = reuseUnchanged(prev, next);
    const host = out.clips.tracks.host!;
    expect(host).not.toBe(prev.clips.tracks.host);
    expect(host[0]).toBe(prev.clips.tracks.host![0]);
    expect(host[1]).not.toBe(prev.clips.tracks.host![1]);
    expect(host[1]!.fade_in_ms).toBe(20);
    expect(out.clips.tracks.guest).toBe(prev.clips.tracks.guest);
    expect(out.tracks).toBe(prev.tracks);
  });

  it("compares mute regions element by element", () => {
    const prev = project();
    const same = fresh(prev);
    expect(reuseUnchanged(prev, same).clips.tracks.host![0]).toBe(
      prev.clips.tracks.host![0],
    );
    const moved = fresh(prev);
    moved.clips.tracks.host![0]!.mute_regions = [{ start_s: 0.1, end_s: 0.3 }];
    expect(reuseUnchanged(prev, moved).clips.tracks.host![0]).not.toBe(
      prev.clips.tracks.host![0],
    );
  });

  it("compares clipping regions element by element", () => {
    const prev = project();
    prev.clips.tracks.host![1]!.clipping_regions = [{ start_s: 1, end_s: 2 }];
    const same = fresh(prev);
    expect(reuseUnchanged(prev, same).clips.tracks.host![1]).toBe(
      prev.clips.tracks.host![1],
    );
    const moved = fresh(prev);
    moved.clips.tracks.host![1]!.clipping_regions = [{ start_s: 1, end_s: 3 }];
    expect(reuseUnchanged(prev, moved).clips.tracks.host![1]).not.toBe(
      prev.clips.tracks.host![1],
    );
  });

  it("keeps an unchanged track by id when another track changes", () => {
    const prev = project();
    const next = fresh(prev);
    next.tracks[1] = { ...next.tracks[1]!, muted: true };
    const out = reuseUnchanged(prev, next);
    expect(out.tracks).not.toBe(prev.tracks);
    expect(out.tracks[0]).toBe(prev.tracks[0]);
    expect(out.tracks[1]!.muted).toBe(true);
  });

  it("builds a new array when items are reordered", () => {
    const prev = project();
    const next = fresh(prev);
    next.tracks.reverse();
    const out = reuseUnchanged(prev, next);
    expect(out.tracks).not.toBe(prev.tracks);
    expect(out.tracks[0]).toBe(prev.tracks[1]);
    expect(out.tracks[1]).toBe(prev.tracks[0]);
  });

  it("does not reuse a clip whose keys differ", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.guest![0] = {
      ...next.clips.tracks.guest![0]!,
      origin_track_id: "host",
    };
    const out = reuseUnchanged(prev, next);
    expect(out.clips.tracks.guest![0]).not.toBe(prev.clips.tracks.guest![0]);
    expect(out.clips.tracks.host).toBe(prev.clips.tracks.host);
  });

  it("keeps new lanes and a changed clip count", () => {
    const prev = project();
    const next = fresh(prev);
    next.clips.tracks.extra = [clip("d", 0, { track_id: "extra" })];
    next.clips.clip_count = 4;
    const out = reuseUnchanged(prev, next);
    expect(out.clips).not.toBe(prev.clips);
    expect(out.clips.clip_count).toBe(4);
    expect(out.clips.tracks.host).toBe(prev.clips.tracks.host);
    expect(out.clips.tracks.extra).toBe(next.clips.tracks.extra);
  });

  it("runs on document snapshots and projection patches", () => {
    const prev = project();
    const snap = projectFromDocumentSnapshot(prev, { project: fresh(prev) });
    expect(snap?.clips).toBe(prev.clips);
    expect(snap?.tracks).toBe(prev.tracks);
    const patched = mergeProjectPatch(prev, {
      clips: fresh(prev).clips,
      tracks: fresh(prev).tracks,
    });
    expect(patched.clips).toBe(prev.clips);
    expect(patched.tracks).toBe(prev.tracks);
    const viaPatch = projectFromDocumentSnapshot(prev, {
      patch: { clips: fresh(prev).clips },
    });
    expect(viaPatch?.clips).toBe(prev.clips);
  });
});
