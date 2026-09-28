import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSocialClip } from "../api";
import {
  PRESENCE_ANCHOR_ATTR,
  resolvePresenceAnchor,
} from "../presence/anchors";
import { presenceCursorFromPointer } from "../presence/usePresenceCursorSource";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleComment } from "../test/fixtures";
import type {
  ChapterMarker,
  SocialClipView,
  TimelineComment,
} from "../types/project";
import { MARKER_ROW_HEIGHT } from "../utils/layout";
import { MarkerLane } from "./MarkerLane";
import { MarkerLaneView } from "./MarkerLaneView";
import { socialSpanAfterDrag } from "./socialDrag";
import type { MarkerRows } from "./timelineMetrics";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  updateSocialClip: vi.fn(async () => undefined),
}));

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

function renderLane(rows: MarkerRows, zoomPxPerSec = 10) {
  return render(
    <MarkerLane
      chapters={chapters}
      socialClips={socialClips}
      comments={comments}
      rows={rows}
      zoomPxPerSec={zoomPxPerSec}
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
      clipping: false,
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
      clipping: false,
    });
    expect(container.querySelector(".marker-lane.empty")).toBeTruthy();
    expect(container.querySelector(".marker-row")).toBeNull();
  });

  it("anchors each row so remote cursors land on it whatever layers are on", () => {
    const all = renderLane({
      chapters: true,
      social: true,
      comments: true,
      clipping: false,
    });
    const row = all.container.querySelector(
      ".marker-row.comments",
    ) as HTMLElement;
    Object.defineProperty(row, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 48, width: 400, height: 24 }),
    });
    const pin = row.querySelector(".comment-marker") as HTMLElement;
    // Viewer A (all rows) hovers the comments row…
    const cursor = presenceCursorFromPointer(pin, 40, 60, null, 0, 10, 60);
    expect(cursor).toEqual({ anchor: "markers:comments", x: 0.1, y: 0.5 });
    expect(
      all.container
        .querySelector(".marker-lane")
        ?.hasAttribute(PRESENCE_ANCHOR_ATTR),
    ).toBe(false);
    all.unmount();

    // …viewer B (Markers off: comments is the only row) resolves that row.
    const onlyComments = renderLane({
      chapters: false,
      social: false,
      comments: true,
      clipping: false,
    });
    expect(
      resolvePresenceAnchor(onlyComments.container, "markers:comments"),
    ).toBe(onlyComments.container.querySelector(".marker-row.comments"));
    expect(
      resolvePresenceAnchor(onlyComments.container, "markers:chapters"),
    ).toBeNull();
  });

  it("keeps a lane anchor on the quiet empty lane", () => {
    const { container } = renderLane({
      chapters: false,
      social: false,
      comments: false,
      clipping: false,
    });
    expect(resolvePresenceAnchor(container, "markers")).toBe(
      container.querySelector(".marker-lane.empty"),
    );
  });

  it("centers point markers with the row height constant", () => {
    const { container } = renderLane({
      chapters: true,
      social: true,
      comments: true,
      clipping: false,
    });
    const chapter = container.querySelector(".chapter-marker") as HTMLElement;
    expect(chapter.style.left).toBe(`${2 * 10 - MARKER_ROW_HEIGHT / 2}px`);
    const pin = container.querySelector(".comment-marker.pin") as HTMLElement;
    expect(pin.style.left).toBe(`${4 * 10 - MARKER_ROW_HEIGHT / 2}px`);
    expect(pin.style.width).toBe(`${MARKER_ROW_HEIGHT}px`);
  });

  describe("social clip drag", () => {
    const rows = {
      chapters: false,
      social: true,
      comments: false,
      clipping: false,
    };
    // jsdom rects are empty, so any press lands on the end edge.
    const dragEnd = (zoom: number, dxPx: number) => {
      const { container } = renderLane(rows, zoom);
      const marker = container.querySelector(".social-marker") as HTMLElement;
      fireEvent.pointerDown(marker, { clientX: 100, pointerId: 4 });
      fireEvent.pointerUp(marker, { clientX: 100 + dxPx, pointerId: 4 });
    };

    beforeEach(() => {
      vi.mocked(updateSocialClip).mockClear();
    });

    it("treats a drag under 3 px as a click", async () => {
      dragEnd(10, 2);
      await new Promise((r) => setTimeout(r, 0));
      expect(updateSocialClip).not.toHaveBeenCalled();
    });

    it("commits a 3 px drag at deep zoom, well under the old 20 ms", async () => {
      dragEnd(48000, 3);
      await waitFor(() => expect(updateSocialClip).toHaveBeenCalledTimes(1));
      const [, id, start, end] = vi.mocked(updateSocialClip).mock.calls[0]!;
      expect(id).toBe("s1");
      expect(start).toBe(1);
      expect(end).toBeCloseTo(3 + 3 / 48000, 12);
    });
  });

  describe("clipping flags", () => {
    const flags = [
      { id: "c1:0", trackId: "t1", label: "Ava", start: 5, end: 6 },
    ];
    const rows = {
      chapters: false,
      social: false,
      comments: false,
      clipping: true,
    };

    it("draws one labelled flag per region and selects it", async () => {
      const onSelect = vi.fn();
      const { container } = render(
        <MarkerLane
          chapters={[]}
          socialClips={[]}
          comments={[]}
          rows={rows}
          zoomPxPerSec={10}
          width={400}
          onSelectChapter={vi.fn()}
          onSelectSocial={vi.fn()}
          onSelectComment={vi.fn()}
          clippingFlags={flags}
          onSelectClipping={onSelect}
        />,
      );
      const flag = container.querySelector(".clipping-marker") as HTMLElement;
      expect(flag.getAttribute("aria-label")).toBe("Clipping on Ava at 0:05");
      expect(flag.style.left).toBe("50px");
      expect(flag.style.width).toBe(`${Math.max(MARKER_ROW_HEIGHT, 10)}px`);
      fireEvent.click(flag);
      expect(onSelect).toHaveBeenCalledWith(flags[0]);
      expect(container.querySelector(".marker-row.clipping")).toBeTruthy();
      await expectNoA11yViolations(container);
    });

    it("says when later clipping was not recorded", () => {
      const { container } = render(
        <MarkerLane
          chapters={[]}
          socialClips={[]}
          comments={[]}
          rows={rows}
          zoomPxPerSec={10}
          width={400}
          onSelectChapter={vi.fn()}
          onSelectSocial={vi.fn()}
          onSelectComment={vi.fn()}
          clippingFlags={[
            {
              id: "c1:0",
              trackId: "t1",
              label: "Ava",
              start: 5,
              end: 6,
              truncated: true,
            },
          ]}
        />,
      );
      const flag = container.querySelector(".clipping-marker") as HTMLElement;
      expect(flag.getAttribute("aria-label")).toBe(
        "Clipping on Ava at 0:05; later clipping not recorded",
      );
    });
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

describe("MarkerLaneView", () => {
  const allRows: MarkerRows = {
    chapters: true,
    social: true,
    comments: true,
    clipping: true,
  };

  function renderView(
    overrides: Partial<Parameters<typeof MarkerLaneView>[0]> = {},
  ) {
    const onMoveChapter = vi.fn();
    const onMoveSocial = vi.fn();
    const onSelectChapter = vi.fn();
    const view = render(
      <MarkerLaneView
        chapters={chapters}
        socialClips={socialClips}
        comments={comments}
        rows={allRows}
        zoomPxPerSec={10}
        width={400}
        editable
        onSelectChapter={onSelectChapter}
        onSelectSocial={vi.fn()}
        onSelectComment={vi.fn()}
        onMoveChapter={onMoveChapter}
        onMoveSocial={onMoveSocial}
        {...overrides}
      />,
    );
    return { ...view, onMoveChapter, onMoveSocial, onSelectChapter };
  }

  it("read-only markers click-select and never drag", () => {
    const { container, onMoveChapter, onSelectChapter } = renderView({
      editable: false,
    });
    const chapter = container.querySelector(".chapter-marker") as HTMLElement;
    fireEvent.pointerDown(chapter, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(chapter, { clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(chapter, { clientX: 150, pointerId: 1 });
    expect(onMoveChapter).not.toHaveBeenCalled();
    fireEvent.click(chapter);
    expect(onSelectChapter).toHaveBeenCalledWith(chapters[0]);
  });

  it("commits an editable chapter drag through onMoveChapter", () => {
    const { container, onMoveChapter } = renderView();
    const chapter = container.querySelector(".chapter-marker") as HTMLElement;
    fireEvent.pointerDown(chapter, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(chapter, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(chapter, { clientX: 130, pointerId: 1 });
    expect(onMoveChapter).toHaveBeenCalledWith({ time: 2, title: "Intro" }, 5);
  });

  it("commits a social end drag through onMoveSocial", () => {
    const { container, onMoveSocial } = renderView();
    const marker = container.querySelector(".social-marker") as HTMLElement;
    fireEvent.pointerDown(marker, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(marker, { clientX: 130, pointerId: 1 });
    fireEvent.pointerUp(marker, { clientX: 130, pointerId: 1 });
    expect(onMoveSocial).toHaveBeenCalledWith("s1", 1, 6);
  });

  it("renders comments and clipping from props and passes axe", async () => {
    const { container } = renderView({
      comments: [
        sampleComment({ id: "cm-pin", author: "Ari", timeline_start: 4 }),
        sampleComment({
          id: "cm-span",
          author: "Mira",
          timeline_start: 10,
          timeline_end: 13,
        }),
      ],
      clippingFlags: [
        {
          id: "f1",
          trackId: "host",
          label: "Host",
          start: 5,
          end: 5.2,
        },
      ],
    });
    await expectNoA11yViolations(container);
  });
});
