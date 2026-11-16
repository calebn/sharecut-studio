import { beforeEach, describe, expect, it } from "vitest";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../test/fixtures";
import { resetDocumentAuthority } from "./authorityState";
import {
  beginDocumentDraft,
  clearPreviewDraft,
  finishDocumentDraft,
  overlayDocumentDrafts,
  setPreviewDraft,
} from "./pendingDrafts";

beforeEach(() => resetDocumentAuthority("/tmp/drafts.json"));
const project = () =>
  minimalProject({ tracks: [sampleTrack({ id: "a", fader_db: 0 })] });
describe("pending document display drafts", () => {
  it("rejects nonfinite values and wrong envelope lanes without changing the authoritative view", () => {
    const before = project();
    for (const value of [NaN, Infinity, -Infinity]) {
      beginDocumentDraft("fader", "SetTrackFader", {
        track_id: "a",
        fader_db: value,
      });
      beginDocumentDraft("move", "MoveClips", {
        clips: [{ track_id: "a", clip_id: "clip", timeline_start: value }],
      });
      beginDocumentDraft("point", "SetEnvelope", {
        track_id: "a",
        points: [{ id: "p", time: 0, value }],
      });
    }
    beginDocumentDraft("lane", "SetEnvelope", {
      track_id: "a",
      parameter: "pan",
      points: [{ id: "p", time: 0, value: 1 }],
    });
    expect(overlayDocumentDrafts(before)).toBe(before);
  });
  it("finishes only the acknowledged field draft and clears all drafts on scope change", () => {
    const before = project();
    beginDocumentDraft("older", "SetTrackFader", {
      track_id: "a",
      fader_db: -2,
    });
    beginDocumentDraft("newer", "SetTrackFader", {
      track_id: "a",
      fader_db: -4,
    });
    beginDocumentDraft("mute", "SetTrackMute", { track_id: "a", muted: true });
    finishDocumentDraft("older");
    expect(overlayDocumentDrafts(before).tracks[0]).toMatchObject({
      fader_db: -4,
      muted: true,
    });
    finishDocumentDraft("newer");
    expect(overlayDocumentDrafts(before).tracks[0]).toMatchObject({
      fader_db: 0,
      muted: true,
    });
    resetDocumentAuthority("/tmp/other.json");
    expect(overlayDocumentDrafts(before)).toBe(before);
  });
  it("bounds the total retained geometry before admitting another draft", () => {
    const clips = Array.from({ length: 10_000 }, (_, i) => ({
      track_id: "a",
      clip_id: String(i),
      timeline_start: i,
    }));
    beginDocumentDraft("one", "MoveClips", { clips });
    beginDocumentDraft("two", "MoveClips", { clips });
    expect(() => beginDocumentDraft("three", "MoveClips", { clips })).toThrow(
      /pending edits/,
    );
    finishDocumentDraft("one");
    expect(() =>
      beginDocumentDraft("three", "MoveClips", { clips }),
    ).not.toThrow();
  });
  it("does not let an older outbox replay replace the latest collapsed field draft", () => {
    const before = project();
    beginDocumentDraft("old", "SetTrackFader", { track_id: "a", fader_db: -2 });
    beginDocumentDraft("new", "SetTrackFader", { track_id: "a", fader_db: -4 });
    beginDocumentDraft(
      "old",
      "SetTrackFader",
      { track_id: "a", fader_db: -2 },
      true,
    );
    finishDocumentDraft("old");
    expect(overlayDocumentDrafts(before).tracks[0].fader_db).toBe(-4);
    beginDocumentDraft(
      "new",
      "SetTrackFader",
      { track_id: "a", fader_db: -4 },
      true,
    );
    finishDocumentDraft("new");
    expect(overlayDocumentDrafts(before)).toBe(before);
  });
  it("shows a queued clip fade over a snapshot that does not hold it yet", () => {
    const base = minimalProject({
      tracks: [sampleTrack({ id: "a" })],
      clips: {
        tracks: { a: [clipRow({ id: "c", track_id: "a", fade_in_ms: 5 })] },
        clip_count: 1,
      },
    });
    beginDocumentDraft("fade", "SetClipFade", {
      clip_id: "c",
      fade_in_ms: 40,
      fade_out_ms: 7,
    });
    expect(overlayDocumentDrafts(base).clips.tracks.a?.[0]).toMatchObject({
      fade_in_ms: 40,
      fade_out_ms: 7,
    });
    beginDocumentDraft("bad", "SetClipFade", {
      clip_id: "c",
      fade_in_ms: Number.NaN,
      fade_out_ms: 7,
    });
    finishDocumentDraft("fade");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });
  it("shows a clicked fade curve at once and ignores an unknown one", () => {
    const base = minimalProject({
      tracks: [sampleTrack({ id: "a" })],
      clips: {
        tracks: { a: [clipRow({ id: "c", track_id: "a" })] },
        clip_count: 1,
      },
    });
    beginDocumentDraft("fade", "SetClipFade", {
      clip_id: "c",
      fade_in_ms: 0,
      fade_out_ms: 0,
      fade_out_curve: "s",
      fade_in_curve: "bogus",
    });
    const clip = overlayDocumentDrafts(base).clips.tracks.a?.[0];
    expect(clip?.fade_out_curve).toBe("s");
    expect(clip).not.toHaveProperty("fade_in_curve");
    finishDocumentDraft("fade");
  });
  it("shows a queued clip gain over a snapshot that does not hold it yet", () => {
    const base = minimalProject({
      tracks: [sampleTrack({ id: "a" })],
      clips: {
        tracks: {
          a: [
            clipRow({ id: "c", track_id: "a" }),
            clipRow({ id: "d", track_id: "a", gain_db: -3 }),
          ],
        },
        clip_count: 2,
      },
    });
    beginDocumentDraft("gain", "SetClipGain", { clip_id: "c", gain_db: 6 });
    expect(overlayDocumentDrafts(base).clips.tracks.a?.[0]?.gain_db).toBe(6);
    beginDocumentDraft("bad", "SetClipGain", {
      clip_id: "c",
      gain_db: Number.NaN,
    });
    finishDocumentDraft("gain");
    expect(overlayDocumentDrafts(base)).toBe(base);
    beginDocumentDraft("many", "SetClipsGain", {
      gains: [
        { clip_id: "c", gain_db: 2 },
        { clip_id: "d", gain_db: 0 },
        { clip_id: "missing", gain_db: 1 },
      ],
    });
    const lane = overlayDocumentDrafts(base).clips.tracks.a;
    expect(lane?.map((clip) => clip.gain_db ?? 0)).toEqual([2, 0]);
    beginDocumentDraft("bad-many", "SetClipsGain", {
      gains: [{ clip_id: "c", gain_db: "x" }],
    });
    finishDocumentDraft("many");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });
  it("lays a held preview over whatever project it is given, until it is cleared", () => {
    const before = project();
    const owner = Symbol("k");
    setPreviewDraft("k", owner, (p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, fader_db: -9 })),
    }));
    expect(overlayDocumentDrafts(before).tracks[0]?.fader_db).toBe(-9);
    const newer = minimalProject({
      tracks: [sampleTrack({ id: "a", fader_db: 3, label: "newer" })],
    });
    expect(overlayDocumentDrafts(newer).tracks[0]).toMatchObject({
      fader_db: -9,
      label: "newer",
    });
    expect(clearPreviewDraft("k", Symbol("other"))).toBe(false);
    expect(overlayDocumentDrafts(before).tracks[0]?.fader_db).toBe(-9);
    expect(clearPreviewDraft("k", owner)).toBe(true);
    expect(clearPreviewDraft("k", owner)).toBe(false);
    expect(overlayDocumentDrafts(before)).toBe(before);
  });
  it("keeps a preview over a command draft that was begun after it", () => {
    const base = minimalProject({
      tracks: [sampleTrack({ id: "a", fader_db: 0 })],
    });
    const owner = Symbol("k");
    setPreviewDraft("k", owner, (p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({ ...t, fader_db: -9 })),
    }));
    beginDocumentDraft("cmd", "SetTrackFader", {
      track_id: "a",
      fader_db: -3,
    });
    expect(overlayDocumentDrafts(base).tracks[0]?.fader_db).toBe(-9);
    expect(overlayDocumentDrafts(base, false).tracks[0]?.fader_db).toBe(-3);
    clearPreviewDraft("k", owner);
    finishDocumentDraft("cmd");
  });
  it("shows the trimmed new project name until the command finishes", () => {
    const before = project();
    beginDocumentDraft("rename", "RenameProject", { name: "  Finale " });
    expect(overlayDocumentDrafts(before).meta.name).toBe("Finale");
    expect(before.meta.name).not.toBe("Finale");
    finishDocumentDraft("rename");
    expect(overlayDocumentDrafts(before)).toBe(before);
  });
});

describe("a queued pending-edit range draft", () => {
  const saved = pendingEditView({
    id: "p1",
    track_id: "a",
    track_ids: ["a"],
    source_start: 20,
    source_end: 24,
    source_start_timeline: 20,
    source_end_timeline: 24,
    timeline_start: 20,
    timeline_end: 24,
    timeline_spans: [{ start: 20, end: 24 }],
  });
  const base = minimalProject({
    tracks: [sampleTrack({ id: "a" })],
    pending_edits: [saved],
  });
  const range = (p: typeof base) => {
    const e = p.pending_edits[0];
    return [e.source_start, e.source_end, e.timeline_end];
  };
  const expected = {
    track_id: "a",
    type: "remove",
    timebase: "source",
    start: 20,
    end: 24,
  };
  const save = (id: string, payload: Record<string, unknown>) =>
    beginDocumentDraft(id, "UpdatePendingEdit", {
      id: "p1",
      start: 20,
      end: 24,
      snap: false,
      ...payload,
    });

  it("shows the saved range over a snapshot that does not hold it yet, until its command finishes", () => {
    save("c1", { end: 25, expected });
    expect(range(overlayDocumentDrafts(base))).toEqual([20, 25, 25]);
    finishDocumentDraft("c1");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });

  it("collapses a second save of the same edit, and finishing the older command keeps the newer", () => {
    save("c1", { end: 25, expected });
    save("c2", { end: 26, expected });
    expect(range(overlayDocumentDrafts(base))).toEqual([20, 26, 26]);
    finishDocumentDraft("c1");
    expect(range(overlayDocumentDrafts(base))).toEqual([20, 26, 26]);
    finishDocumentDraft("c2");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });

  it("holds both bounds when the save carries no baseline", () => {
    save("c1", { start: 19, end: 25 });
    expect(range(overlayDocumentDrafts(base))).toEqual([19, 25, 25]);
  });

  it("holds only the bound that differs from the baseline, so a peer retime of the other stands", () => {
    save("c1", { start: 20, end: 25, expected });
    const peer = {
      ...base,
      pending_edits: [
        {
          ...saved,
          source_start: 18,
          source_start_timeline: 18,
          timeline_start: 18,
          timeline_spans: [{ start: 18, end: 24 }],
        },
      ],
    };
    const shown = overlayDocumentDrafts(peer).pending_edits[0];
    expect([shown.source_start, shown.source_end]).toEqual([18, 25]);
  });

  it("registers nothing for a snapped save, a split save, an unchanged range or a bad value", () => {
    save("snap", { snap: true, end: 25 });
    save("split", { track_ids: ["a", "b"], end: 25 });
    save("same", { expected });
    save("nan", { end: Number.NaN });
    save("inf", { start: Number.POSITIVE_INFINITY });
    save("text", { end: "25" });
    beginDocumentDraft("noid", "UpdatePendingEdit", {
      start: 20,
      end: 25,
      snap: false,
    });
    expect(overlayDocumentDrafts(base)).toBe(base);
  });

  it("does not let a replay replace a newer save of the same edit", () => {
    save("newer", { end: 26, expected });
    beginDocumentDraft(
      "older",
      "UpdatePendingEdit",
      { id: "p1", start: 20, end: 25, snap: false, expected },
      true,
    );
    expect(range(overlayDocumentDrafts(base))).toEqual([20, 26, 26]);
  });

  it("lays a held start-edge preview over an end-edge draft", () => {
    save("c1", { end: 25, expected });
    const owner = Symbol("start");
    setPreviewDraft("start", owner, (p) => ({
      ...p,
      pending_edits: p.pending_edits.map((e) => ({
        ...e,
        source_start: 21,
      })),
    }));
    const shown = overlayDocumentDrafts(base).pending_edits[0];
    expect([shown.source_start, shown.source_end]).toEqual([21, 25]);
    expect(
      overlayDocumentDrafts(base, false).pending_edits[0].source_start,
    ).toBe(20);
    clearPreviewDraft("start", owner);
  });

  it("holds both bounds of two queued saves on alternating edges until each command finishes", () => {
    save("c1", { end: 25, expected });
    save("c2", {
      start: 19,
      end: 25,
      expected: { ...expected, end: 25 },
    });
    expect(range(overlayDocumentDrafts(base))).toEqual([19, 25, 25]);
    finishDocumentDraft("c1");
    expect(range(overlayDocumentDrafts(base))).toEqual([19, 24, 24]);
    finishDocumentDraft("c2");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });

  it("drops a failed first save's bound and keeps the second save's", () => {
    save("c1", { end: 25, expected });
    save("c2", { start: 19, expected: { ...expected, end: 25 } });
    finishDocumentDraft("c1");
    expect(range(overlayDocumentDrafts(base))).toEqual([19, 24, 24]);
  });

  it("keeps a replayed older save of one edge beside a newer save of the other", () => {
    save("newer", { start: 19, expected });
    beginDocumentDraft(
      "older",
      "UpdatePendingEdit",
      { id: "p1", start: 20, end: 25, snap: false, expected },
      true,
    );
    expect(range(overlayDocumentDrafts(base))).toEqual([19, 25, 25]);
  });

  it("is cleared by a scope change", () => {
    save("c1", { end: 25, expected });
    resetDocumentAuthority("/tmp/other.json");
    expect(overlayDocumentDrafts(base)).toBe(base);
  });
});
