import { describe, expect, it } from "vitest";
import type { ChapterMarker } from "../types/project";
import { chapterLabelRoomPx } from "./chapterLabels";

function chapter(time: number, title = "Chapter"): ChapterMarker {
  return { time, title } as ChapterMarker;
}

describe("chapterLabelRoomPx", () => {
  it("computes room between two chapters", () => {
    const chapters = [chapter(0), chapter(10)];
    const room = chapterLabelRoomPx(chapters, 10, 400, 24);
    expect(room).toEqual([72, 288]);
  });

  it("handles unsorted input", () => {
    const chapters = [chapter(10), chapter(0)];
    const room = chapterLabelRoomPx(chapters, 10, 400, 24);
    expect(room).toEqual([288, 72]);
  });

  it("returns null when chapters are too close", () => {
    const chapters = [chapter(0), chapter(1)];
    const room = chapterLabelRoomPx(chapters, 10, 400, 24);
    expect(room[0]).toBeNull();
  });

  it("returns null for a duplicate time", () => {
    const chapters = [chapter(5, "First"), chapter(5, "Second")];
    const room = chapterLabelRoomPx(chapters, 10, 400, 24);
    expect(room[0]).not.toBeNull();
    expect(room[1]).toBeNull();
  });

  it("returns an empty array for an empty list", () => {
    expect(chapterLabelRoomPx([], 10, 400, 24)).toEqual([]);
  });
});
