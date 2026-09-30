import { beforeEach, describe, expect, it } from "vitest";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { resetDocumentAuthority } from "./authorityState";
import {
  beginDocumentDraft,
  finishDocumentDraft,
  overlayDocumentDrafts,
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
});
