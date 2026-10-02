import { describe, expect, it } from "vitest";
import { clipRow, sampleTrack } from "../test/fixtures";
import { clipIdentityTrack, clipLabels } from "./clipLabels";

describe("clip labels", () => {
  const clip = clipRow({
    id: "internal-clip-id",
    source_start: 30,
    source_end: 36,
    timeline_start: 4,
    timeline_end: 10,
  });

  it("names the speaker, timeline bounds and full source duration", () => {
    expect(
      clipLabels({
        clip,
        trackSpeaker: " Host ",
        trackLabel: "Internal microphone",
        role: "dialogue",
      }),
    ).toEqual({
      speaker: "Host",
      start: "00:04.000",
      end: "00:10.000",
      duration: "6s",
      select: "Select Host clip at 00:04.000, 6s",
      heading: "Host clip, 00:04.000 to 00:10.000",
    });
  });

  it("uses a human track label then role without using internal IDs", () => {
    expect(
      clipLabels({
        clip,
        trackSpeaker: " ",
        trackLabel: " Guest ",
        role: "dialogue",
      }).select,
    ).toBe("Select Guest clip at 00:04.000, 6s");
    expect(clipLabels({ clip, trackLabel: " ", role: "music" }).heading).toBe(
      "Music clip, 00:04.000 to 00:10.000",
    );
    expect(clipLabels({ clip, role: "" }).select).toBe(
      "Select Audio clip at 00:04.000, 6s",
    );
  });

  it("resolves a moved clip's origin before its destination lane", () => {
    const tracks = [
      sampleTrack({ id: "guest", speaker: "Guest" }),
      sampleTrack({ id: "host", speaker: "Host" }),
    ];
    const moved = { ...clip, track_id: "guest", origin_track_id: "host" };
    expect(clipIdentityTrack({ clip: moved, tracks })?.speaker).toBe("Host");
    expect(
      clipIdentityTrack({
        clip: { ...moved, origin_track_id: "missing" },
        tracks,
      })?.speaker,
    ).toBe("Guest");
  });
});
