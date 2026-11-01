import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { resolvePresenceAnchor } from "../presence/anchors";
import { expectNoA11yViolations } from "../test/a11y";
import { sampleComment } from "../test/fixtures";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { chapterMarkerId, laneMarkers, movedMarker } from "./laneMarkers";
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
      laneRow
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

describe("movedMarker", () => {
  const chapter = {
    kind: "chapter",
    id: "c",
    start: 2,
    title: "Intro",
  } as const;
  const clip = {
    kind: "clip",
    id: "s",
    start: 10,
    end: 14,
    title: "T",
  } as const;

  it("holds a chapter to the episode", () => {
    expect(movedMarker(chapter, "move", -5, 40).start).toBe(0);
    expect(movedMarker(chapter, "move", 100, 40).start).toBe(40);
    expect(movedMarker(chapter, "move", 1.5, 40).start).toBe(3.5);
  });

  it("moves a clip whole or by one bound and keeps its minimum span", () => {
    expect(movedMarker(clip, "move", 2, 40)).toMatchObject({
      start: 12,
      end: 16,
    });
    expect(movedMarker(clip, "end", 3, 40)).toMatchObject({
      start: 10,
      end: 17,
    });
    const squeezed = movedMarker(clip, "end", -10, 40);
    expect(
      squeezed.kind === "clip" && squeezed.end - squeezed.start,
    ).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(movedMarker(clip, "end", 100, 40)).toMatchObject({ end: 40 });
  });

  it("never moves a comment", () => {
    const comment = {
      kind: "comment",
      id: "m",
      start: 4,
      author: "Ada",
    } as const;
    expect(movedMarker(comment, "move", 3, 40)).toBe(comment);
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

  it("leaves the system lane out when the metrics give its row away", () => {
    const { container } = setup({ laneRow: false });
    expect(container.querySelector(".sys-markers")).toBeNull();
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

  it("draws the held marker where the keys have put it, and lets it go once saved", async () => {
    const { onMoveChapter } = setup({ selected: ["2-Intro"] });
    const chapter = screen.getByRole("button", { name: /^Chapter Intro,/ });
    const before = chapter.getAttribute("aria-label");
    chapter.focus();
    fireEvent.keyDown(chapter, { key: "ArrowRight", shiftKey: true });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /^Chapter Intro,/ })
          .getAttribute("aria-label"),
      ).not.toBe(before),
    );
    fireEvent.keyUp(chapter, { key: "ArrowRight" });
    expect(onMoveChapter).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /^Chapter Intro,/ })
          .getAttribute("aria-label"),
      ).toBe(before),
    );
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

  it("names a chapter added by a double-click on the empty lane", () => {
    const onAddChapter = vi.fn();
    const { container } = setup({ onAddChapter });
    const track = container.querySelector(".sys-markers-track")!;
    fireEvent.doubleClick(track, { clientX: 300 });
    const field = screen.getByRole("textbox", { name: "Chapter name" });
    fireEvent.change(field, { target: { value: "Outro" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onAddChapter).toHaveBeenCalledTimes(1);
    expect(onAddChapter.mock.calls[0]![1]).toBe("Outro");
    expect(screen.queryByRole("textbox", { name: "Chapter name" })).toBeNull();
  });

  it("drops an unnamed add with Escape, and never adds for a guest", () => {
    const onAddChapter = vi.fn();
    const { container, unmount } = setup({ onAddChapter });
    const track = container.querySelector(".sys-markers-track")!;
    fireEvent.doubleClick(track, { clientX: 300 });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Chapter name" }), {
      key: "Escape",
    });
    expect(onAddChapter).not.toHaveBeenCalled();
    unmount();
    const guest = setup({ onAddChapter, readOnly: true });
    fireEvent.doubleClick(
      guest.container.querySelector(".sys-markers-track")!,
      {
        clientX: 300,
      },
    );
    expect(screen.queryByRole("textbox", { name: "Chapter name" })).toBeNull();
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
