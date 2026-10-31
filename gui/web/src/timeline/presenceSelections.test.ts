import { describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import type { ClipRow } from "../types/project";
import type { SessionClient, SessionSelection } from "../types/session";
import { presenceSelections } from "./presenceSelections";

const clip = (over: Partial<ClipRow> = {}): ClipRow =>
  clipRow({
    id: "c1",
    track_id: "guest",
    source_end: 5,
    timeline_start: 10,
    timeline_end: 15,
    ...over,
  });

function project() {
  return minimalProject({
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    clips: { tracks: { host: [], guest: [clip()] }, clip_count: 1 },
    envelopes: [
      {
        track_id: "guest",
        parameter: "volume",
        points: [{ id: "p1", time: 7, value: -3 }],
      },
    ],
  });
}

const client = (
  selection: SessionSelection | null,
  id = "bea",
  colorIndex = 2,
): SessionClient => ({
  client_id: id,
  role: "viewer",
  meta: { selection, color_index: colorIndex },
});

describe("presenceSelections", () => {
  it("maps a clip to its track and real span, keyed by the client", () => {
    expect(
      presenceSelections([client({ kind: "clip", id: "c1" })], project(), 10),
    ).toEqual([
      {
        id: "bea",
        personId: "bea",
        laneId: "guest",
        start: 10,
        end: 15,
        colorIndex: 2,
      },
    ]);
  });

  it("widens pending and applied points to 2 px and an envelope point to 5 px", () => {
    const sel = (s: SessionSelection) =>
      presenceSelections([client(s)], project(), 10)[0]!;
    const pending = sel({ kind: "pending", track_id: "host", time: 3 });
    expect(pending.start).toBe(3);
    expect(pending.end).toBeCloseTo(3 + 2 / 10);
    const applied = sel({ kind: "applied", track_id: "host", time: 4 });
    expect(applied.end).toBeCloseTo(4 + 2 / 10);
    const point = sel({ kind: "envelopePoint", track_id: "guest", id: "p1" });
    expect(point.laneId).toBe("guest");
    expect(point.start).toBe(7);
    expect(point.end).toBeCloseTo(7 + 5 / 10);
  });

  it("keeps the px minimum at any zoom by rebuilding in seconds", () => {
    const at = (zoom: number) =>
      presenceSelections(
        [client({ kind: "pending", track_id: "host", time: 3 })],
        project(),
        zoom,
      )[0]!;
    expect((at(100).end - 3) * 100).toBeCloseTo(2);
    expect((at(4).end - 3) * 4).toBeCloseTo(2);
  });

  it("gives a zero-length clip the 2 px span minimum, and keeps a longer span as it is", () => {
    const p = project();
    p.clips.tracks.guest = [clip({ timeline_start: 10, timeline_end: 10 })];
    const [zero] = presenceSelections(
      [client({ kind: "clip", id: "c1" })],
      p,
      20,
    );
    expect(zero!.end).toBeCloseTo(10 + 2 / 20);
    const [long] = presenceSelections(
      [client({ kind: "clip", id: "c1" })],
      project(),
      20,
    );
    expect(long!.end).toBe(15);
  });

  it("omits a selection whose clip, point or track is gone", () => {
    const p = project();
    const gone: SessionSelection[] = [
      { kind: "clip", id: "missing" },
      { kind: "envelopePoint", track_id: "guest", id: "nope" },
      { kind: "pending", track_id: "ghost", time: 1 },
      { kind: "applied", track_id: "host" },
      { kind: "comment", id: "x" },
    ];
    for (const s of gone) {
      expect(presenceSelections([client(s)], p, 10)).toEqual([]);
    }
    p.tracks = [p.tracks[0]!];
    expect(
      presenceSelections([client({ kind: "clip", id: "c1" })], p, 10),
    ).toEqual([]);
  });

  it("returns nothing without a project, a selection or a usable zoom", () => {
    expect(
      presenceSelections([client({ kind: "clip", id: "c1" })], null, 10),
    ).toEqual([]);
    expect(presenceSelections([client(null)], project(), 10)).toEqual([]);
    expect(
      presenceSelections([client({ kind: "clip", id: "c1" })], project(), 0),
    ).toEqual([]);
  });

  it("takes colour 0 for a client with none", () => {
    const c: SessionClient = {
      client_id: "x",
      role: "viewer",
      meta: { selection: { kind: "clip", id: "c1" } },
    };
    expect(presenceSelections([c], project(), 10)[0]!.colorIndex).toBe(0);
  });
});
