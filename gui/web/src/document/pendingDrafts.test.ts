import { beforeEach, describe, expect, it } from "vitest";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
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
});
