import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolvePresenceAnchor } from "../presence/anchors";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { chapterMarkerId, laneMarkers } from "./laneMarkers";
import { MarkerLaneHost } from "./MarkerLaneHost";
import { socialSpanAfterDrag } from "./socialDrag";

const chapters = [{ time: 2, title: "Intro" }] as ChapterMarker[];
const socialClips = [
  {
    id: "s1",
    start: 10,
    end: 14,
    score: 0.5,
    approved: false,
    title_suggestion: "Big laugh",
  },
] as SocialClipView[];
const comments = [
  sampleComment({ id: "c1", author: "Ada", timeline_start: 20 }),
  sampleComment({
    id: "c2",
    author: "Mira",
    timeline_start: 24,
    timeline_end: 27,
  }),
] as TimelineComment[];

function setup(over: Record<string, unknown> = {}) {
  const handlers = {
    onSelectChapter: vi.fn(),
    onSelectSocial: vi.fn(),
    onSelectComment: vi.fn(),
    onSelectClipping: vi.fn(),
    onMoveChapter: vi.fn(),
    onMoveSocial: vi.fn(),
  };
  const view = render(
    <MarkerLaneHost
      chapters={chapters}
      socialClips={socialClips}
      comments={comments}
      showMarkers
      showComments
      selected={[]}
      zoomPxPerSec={10}
      width={400}
      duration={40}
      readOnly={false}
      {...handlers}
      {...over}
    />,
  );
  return { ...handlers, ...view };
}

describe("laneMarkers", () => {
  const all = { chapters, socialClips, comments };

  it("maps chapters, social clips and comments onto lane markers", () => {
    expect(
      laneMarkers({ ...all, showMarkers: true, showComments: true }),
    ).toEqual([
      { kind: "chapter", id: "2-Intro", start: 2, title: "Intro" },
      {
        kind: "clip",
        id: "s1",
        start: 10,
        end: 14,
        title: "Big laugh",
        proposed: true,
      },
      { kind: "comment", id: "c1", start: 20, author: "Ada" },
      { kind: "comment", id: "c2", start: 24, end: 27, author: "Mira" },
    ]);
  });

  it("follows the layer toggles", () => {
    expect(
      laneMarkers({ ...all, showMarkers: false, showComments: true }).map(
        (m) => m.kind,
      ),
    ).toEqual(["comment", "comment"]);
    expect(
      laneMarkers({ ...all, showMarkers: true, showComments: false }).map(
        (m) => m.kind,
      ),
    ).toEqual(["chapter", "clip"]);
  });

  it("names a chapter by its time and title", () => {
    expect(chapterMarkerId(chapters[0])).toBe("2-Intro");
  });
});

describe("socialSpanAfterDrag", () => {
  it.each([
    ["move" as const, 1, 3, -5, { start: 0, end: 2 }],
    ["start" as const, 1, 3, 5, { start: 2.95, end: 3 }],
    ["end" as const, 1, 3, -5, { start: 1, end: 1.05 }],
  ])("%s", (mode, originStart, originEnd, dxSec, expected) => {
    const result = socialSpanAfterDrag(mode, originStart, originEnd, dxSec);
    expect(result.start).toBeCloseTo(expected.start);
    expect(result.end).toBeCloseTo(expected.end);
  });
});

describe("MarkerLaneHost", () => {
  it("draws one lane for every kind, and the clipping row only with flags", () => {
    const { container } = setup();
    expect(container.querySelectorAll(".sys-markers")).toHaveLength(1);
    expect(container.querySelector(".marker-row.clipping")).toBeNull();
  });

  it("collapses to the quiet lane when nothing shows", () => {
    const { container } = setup({
      chapters: [],
      socialClips: [],
      comments: [],
    });
    expect(container.querySelector(".marker-lane.empty")).not.toBeNull();
  });

  it("anchors the lane for remote cursors, and the clipping row apart", () => {
    const { container } = setup({
      clippingFlags: [
        { id: "f1", trackId: "host", label: "Host", start: 5, end: 5.2 },
      ],
    });
    expect(resolvePresenceAnchor(container, "markers")).toBe(
      container.querySelector(".sys-markers"),
    );
    expect(resolvePresenceAnchor(container, "markers:clipping")).toBe(
      container.querySelector(".marker-row.clipping"),
    );
  });

  it("routes a click to the matching select callback", () => {
    const { onSelectChapter, onSelectSocial, onSelectComment } = setup();
    fireEvent.click(screen.getByRole("button", { name: /Intro/ }));
    expect(onSelectChapter).toHaveBeenCalledWith(chapters[0]);
    fireEvent.click(screen.getByRole("button", { name: /Big laugh/ }));
    expect(onSelectSocial).toHaveBeenCalledWith(socialClips[0]);
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }));
    expect(onSelectComment).toHaveBeenCalledWith(comments[0]);
  });

  it("marks each marker as a hit target for the touch chooser", () => {
    setup({ selected: ["2-Intro"] });
    const chapter = screen.getByRole("button", { name: /Intro/ });
    expect(chapter).toHaveAttribute("data-hit-kind", "chapter");
    expect(chapter).toHaveAttribute("data-hit-id", "2-Intro");
    expect(chapter).toHaveAttribute("data-hit-selected", "true");
    expect(screen.getByRole("button", { name: /Big laugh/ })).toHaveAttribute(
      "data-hit-kind",
      "social-clip",
    );
    expect(screen.getByRole("button", { name: /Ada/ })).toHaveAttribute(
      "data-hit-kind",
      "comment",
    );
  });

  it("commits a chapter nudge once, when the arrow is released", () => {
    const { onMoveChapter } = setup({ selected: ["2-Intro"] });
    const chapter = screen.getByRole("button", { name: /Intro/ });
    chapter.focus();
    fireEvent.keyDown(chapter, { key: "ArrowRight" });
    fireEvent.keyDown(chapter, { key: "ArrowRight", repeat: true });
    expect(onMoveChapter).not.toHaveBeenCalled();
    fireEvent.keyUp(chapter, { key: "ArrowRight" });
    expect(onMoveChapter).toHaveBeenCalledTimes(1);
    const [from, next] = onMoveChapter.mock.calls[0];
    expect(from).toEqual({ time: 2, title: "Intro" });
    expect(next).toBeCloseTo(2.2);
  });

  it("commits a social clip nudge as new bounds", () => {
    const { onMoveSocial } = setup({ selected: ["s1"] });
    const clip = screen.getByRole("button", { name: /Big laugh/ });
    clip.focus();
    fireEvent.keyDown(clip, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyUp(clip, { key: "ArrowLeft" });
    expect(onMoveSocial).toHaveBeenCalledTimes(1);
    const [id, start, end] = onMoveSocial.mock.calls[0];
    expect(id).toBe("s1");
    expect(start).toBeCloseTo(9);
    expect(end).toBeCloseTo(13);
  });

  it("never moves a marker for a guest", () => {
    const { onMoveChapter, onSelectChapter } = setup({
      readOnly: true,
      selected: ["2-Intro"],
    });
    const chapter = screen.getByRole("button", { name: /Intro/ });
    chapter.focus();
    fireEvent.keyDown(chapter, { key: "ArrowRight" });
    fireEvent.keyUp(chapter, { key: "ArrowRight" });
    fireEvent.click(chapter);
    expect(onMoveChapter).not.toHaveBeenCalled();
    expect(onSelectChapter).toHaveBeenCalled();
  });

  it("selects a clipping flag", () => {
    const flag = {
      id: "f1",
      trackId: "host",
      label: "Host",
      start: 5,
      end: 5.2,
    };
    const { onSelectClipping } = setup({ clippingFlags: [flag] });
    fireEvent.click(screen.getByRole("button", { name: /Clipping on Host/ }));
    expect(onSelectClipping).toHaveBeenCalledWith(flag);
  });

  it("passes axe with every kind and a clipping flag", async () => {
    const { container } = setup({
      clippingFlags: [
        { id: "f1", trackId: "host", label: "Host", start: 5, end: 5.2 },
      ],
    });
    await expectNoA11yViolations(container);
  });
});
