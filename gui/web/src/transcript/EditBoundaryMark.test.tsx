import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { EditBoundaryMark } from "./EditBoundaryMark";
import { EditBoundaryMarkView } from "./EditBoundaryMarkView";

vi.mock("../api", () => ({
  trimClipEdge: vi.fn(async () => undefined),
  rollClipJoin: vi.fn(async () => undefined),
  refreshProject: vi.fn(async () => minimalProject()),
}));

import * as api from "../api";

function clip(overrides: Partial<ClipRow> & Pick<ClipRow, "id">): ClipRow {
  return {
    track_id: "host",
    source_start: 10,
    source_end: 20,
    timeline_start: 0,
    timeline_end: 10,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
    ...overrides,
  };
}

const boundary: EditBoundaryView = {
  id: "eb:left:right",
  track_id: "host",
  left_clip_id: "left",
  right_clip_id: "right",
  timeline_join_sec: 10,
  cutaway_source_start: 20,
  cutaway_source_end: 25,
  has_cutaway: true,
  cutaway_word_ids: [
    {
      track_id: "host",
      word_index: 3,
      text: "ghostly",
      start: 20.1,
      end: 20.6,
    },
    {
      track_id: "host",
      word_index: 4,
      text: "words",
      start: 20.7,
      end: 21.2,
    },
  ],
};

describe("EditBoundaryMark", () => {
  beforeEach(() => {
    vi.mocked(api.trimClipEdge).mockClear();
    vi.mocked(api.rollClipJoin).mockClear();
    vi.mocked(api.refreshProject).mockClear();
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    useDawStore.setState({
      project: minimalProject({
        clips: { tracks: { host: [left, right] }, clip_count: 2 },
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 80,
            fx_count: 0,
            stem_is_fresh: null,
          },
        ],
      }),
      projectPath: "/tmp/ep",
      setProject: vi.fn(),
    });
  });

  it("commits RollClipJoin when both neighbors exist", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const { getByRole, container } = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const mark = getByRole("button");

    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    expect(mark.className).toContain("dragging");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(container.querySelector(".edit-ghost-words")?.textContent).toContain(
      "ghostly",
    );
    expect(container.querySelector(".edit-ghost-words")?.textContent).toContain(
      "words",
    );
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });

    await waitFor(() => {
      expect(api.rollClipJoin).toHaveBeenCalled();
    });
    expect(api.rollClipJoin).toHaveBeenCalledWith(
      "/tmp/ep",
      "left",
      "right",
      expect.any(Number),
    );
    expect(api.trimClipEdge).not.toHaveBeenCalled();
    const delta = vi.mocked(api.rollClipJoin).mock.calls[0]?.[3];
    expect(typeof delta).toBe("number");
    expect(delta as number).toBeGreaterThan(0);
  });

  it("falls back to TrimClipEdge when only left clip exists", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const { getByRole } = render(
      <EditBoundaryMark boundary={boundary} leftClip={left} rightClip={null} />,
    );
    fireEvent.pointerDown(getByRole("button"), {
      pointerId: 1,
      clientX: 100,
    });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => {
      expect(api.trimClipEdge).toHaveBeenCalled();
    });
    expect(api.rollClipJoin).not.toHaveBeenCalled();
  });

  it("no-ops when clips are missing", () => {
    const { getByRole } = render(
      <EditBoundaryMark boundary={boundary} leftClip={null} rightClip={null} />,
    );
    fireEvent.pointerDown(getByRole("button"), {
      pointerId: 1,
      clientX: 100,
    });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 200 });
    expect(api.trimClipEdge).not.toHaveBeenCalled();
    expect(api.rollClipJoin).not.toHaveBeenCalled();
  });

  it("clamps a roll to the project as it is at drag start", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const { getByRole } = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const project = useDawStore.getState().project!;
    const after = clip({
      id: "after",
      source_start: 50,
      source_end: 60,
      timeline_start: 26,
      timeline_end: 36,
    });
    useDawStore.setState({
      project: {
        ...project,
        clips: {
          tracks: { host: [left, right, after] },
          clip_count: 3,
        },
        tracks: project.tracks.map((t) => ({ ...t, duration_sec: 20.5 })),
      },
    });
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(api.rollClipJoin).toHaveBeenCalled());
    expect(vi.mocked(api.rollClipJoin).mock.calls[0]?.[3]).toBeCloseTo(0.5, 6);
  });
});

describe("EditBoundaryMarkView", () => {
  const getRollBounds = () => ({
    prevSourceEnd: 0,
    nextSourceStart: 80,
    mediaEnd: 80,
  });

  it("previews restored words and commits a roll through onRoll", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const onRoll = vi.fn();
    const onTrim = vi.fn();
    const { getByRole } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={right}
        getRollBounds={getRollBounds}
        onRoll={onRoll}
        onTrim={onTrim}
      />,
    );
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    expect(mark).toHaveAttribute("aria-grabbed", "true");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(
      getByRole("group", { name: "Preview restored words" }),
    ).toHaveTextContent("ghostly");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(onRoll).toHaveBeenCalled());
    expect(mark).toHaveAttribute("aria-grabbed", "false");
    expect(onRoll).toHaveBeenCalledWith("left", "right", expect.any(Number));
    const delta = onRoll.mock.calls[0]?.[2];
    expect(delta).toBeGreaterThan(0);
    expect(onTrim).not.toHaveBeenCalled();
    expect(document.body.classList.contains("is-boundary-dragging")).toBe(
      false,
    );
  });

  it("trims through onTrim with only a left clip", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const onRoll = vi.fn();
    const onTrim = vi.fn();
    const { getByRole } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={null}
        getRollBounds={getRollBounds}
        onRoll={onRoll}
        onTrim={onTrim}
      />,
    );
    fireEvent.pointerDown(getByRole("button"), { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(onTrim).toHaveBeenCalled());
    expect(onTrim).toHaveBeenCalledWith("left", "out", expect.any(Number));
    const value = onTrim.mock.calls[0]?.[2];
    expect(value).toBeGreaterThan(20);
  });

  it("passes axe at rest", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const { container } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={right}
        getRollBounds={getRollBounds}
        onRoll={vi.fn()}
        onTrim={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("reads roll bounds only when a roll drag starts", () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const bounds = vi.fn(getRollBounds);
    const { getByRole, rerender } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={right}
        getRollBounds={bounds}
        onRoll={vi.fn()}
        onTrim={vi.fn()}
      />,
    );
    rerender(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={right}
        getRollBounds={bounds}
        onRoll={vi.fn()}
        onTrim={vi.fn()}
      />,
    );
    expect(bounds).not.toHaveBeenCalled();
    fireEvent.pointerDown(getByRole("button"), { pointerId: 1, clientX: 100 });
    expect(bounds).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });
  });

  it("removes its window drag listeners when unmounted mid-drag", () => {
    const left = clip({ id: "left", source_end: 20 });
    const remove = vi.spyOn(window, "removeEventListener");
    const { getByRole, unmount } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={null}
        getRollBounds={getRollBounds}
        onRoll={vi.fn()}
        onTrim={vi.fn()}
      />,
    );
    fireEvent.pointerDown(getByRole("button"), { pointerId: 1, clientX: 100 });
    unmount();
    const types = remove.mock.calls.map((c) => c[0]);
    expect(types).toEqual(
      expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]),
    );
    expect(document.body.classList.contains("is-boundary-dragging")).toBe(
      false,
    );
    remove.mockRestore();
  });
});
