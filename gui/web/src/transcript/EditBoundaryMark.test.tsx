import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, EditBoundaryView } from "../types/project";
import { EditBoundaryMark } from "./EditBoundaryMark";

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
});
