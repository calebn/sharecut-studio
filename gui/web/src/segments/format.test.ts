import { describe, expect, it } from "vitest";
import type { SegmentRow } from "../api/segments";
import { formatTimeShort } from "../utils/time";
import { segmentLengthSec, versionTag } from "./format";

function row(over: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: "intro-1",
    name: "Intro",
    kind: "intro",
    version: 1,
    versions: [1],
    clips: [],
    ...over,
  };
}

describe("formatTimeShort", () => {
  it("writes m:ss under an hour and h:mm:ss from one", () => {
    expect(formatTimeShort(0)).toBe("0:00");
    expect(formatTimeShort(7)).toBe("0:07");
    expect(formatTimeShort(75)).toBe("1:15");
    expect(formatTimeShort(3600)).toBe("1:00:00");
    expect(formatTimeShort(3725)).toBe("1:02:05");
  });

  it("rounds 59.6 seconds up to 1:00, never 0:60", () => {
    expect(formatTimeShort(59.6)).toBe("1:00");
    expect(formatTimeShort(59.4)).toBe("0:59");
  });

  it("treats a negative or fractional zero as 0:00", () => {
    expect(formatTimeShort(-3)).toBe("0:00");
    expect(formatTimeShort(0.2)).toBe("0:00");
  });
});

describe("segmentLengthSec", () => {
  it("is the end of the last clip, not the sum of durations", () => {
    expect(
      segmentLengthSec(
        row({
          clips: [
            { audio: "a.flac", offset_sec: 0, duration_sec: 4 },
            { audio: "b.flac", offset_sec: 10, duration_sec: 2.5 },
          ],
        }),
      ),
    ).toBe(12.5);
  });

  it("is zero without clips", () => {
    expect(segmentLengthSec(row())).toBe(0);
  });
});

describe("versionTag", () => {
  it("shows only the version when there is one", () => {
    expect(versionTag(row({ version: 1, versions: [1] }))).toBe("v1");
  });

  it("adds the count when there are more", () => {
    expect(versionTag(row({ version: 3, versions: [1, 2, 3] }))).toBe(
      "v3 · 3 versions",
    );
  });
});
