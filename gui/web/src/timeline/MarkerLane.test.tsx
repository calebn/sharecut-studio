import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { MarkerLane } from "./MarkerLane";
import type { MarkerRows } from "./timelineMetrics";

const chapters = [{ time: 2, title: "Intro" }] as ChapterMarker[];
const socialClips = [
  { id: "s1", start: 1, end: 3, score: 0.5, approved: false },
] as SocialClipView[];
const comments = [
  {
    id: "c1",
    author: "Ada",
    body: "Tighten",
    timeline_start: 4,
    timeline_end: null,
    resolved: false,
    action_items: [],
  },
] as unknown as TimelineComment[];

function renderLane(rows: MarkerRows) {
  return render(
    <MarkerLane
      chapters={chapters}
      socialClips={socialClips}
      comments={comments}
      rows={rows}
      zoomPxPerSec={10}
      width={400}
      onSelectChapter={vi.fn()}
      onSelectSocial={vi.fn()}
      onSelectComment={vi.fn()}
    />,
  );
}

describe("MarkerLane", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("draws exactly the rows TimelineView sized the lane for", () => {
    const { container } = renderLane({
      chapters: true,
      social: false,
      comments: true,
    });
    const rows = [...container.querySelectorAll(".marker-row")].map(
      (el) => el.classList[1],
    );
    expect(rows).toEqual(["chapters", "comments"]);
  });

  it("collapses to one quiet lane when no row has content", () => {
    const { container } = renderLane({
      chapters: false,
      social: false,
      comments: false,
    });
    expect(container.querySelector(".marker-lane.empty")).toBeTruthy();
    expect(container.querySelector(".marker-row")).toBeNull();
  });

  it("centers point markers with the row height constant", () => {
    const { container } = renderLane({
      chapters: true,
      social: true,
      comments: true,
    });
    const chapter = container.querySelector(".chapter-marker") as HTMLElement;
    expect(chapter.style.left).toBe(`${2 * 10 - MARKER_ROW_HEIGHT / 2}px`);
    const pin = container.querySelector(".comment-marker.pin") as HTMLElement;
    expect(pin.style.left).toBe(`${4 * 10 - MARKER_ROW_HEIGHT / 2}px`);
    expect(pin.style.width).toBe(`${MARKER_ROW_HEIGHT}px`);
  });
});
