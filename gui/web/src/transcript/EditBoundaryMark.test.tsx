import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
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
}));

const { loadBoundaryContext } = vi.hoisted(() => ({
  loadBoundaryContext: vi.fn(),
}));
vi.mock("../api/boundary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/boundary")>();
  return { ...actual, loadBoundaryContext };
});

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
      source_id: null,
      word_index: 3,
      text: "ghostly",
      start: 20.1,
      end: 20.6,
    },
    {
      track_id: "host",
      source_id: null,
      word_index: 4,
      text: "words",
      start: 20.7,
      end: 21.2,
    },
  ],
};

beforeEach(() => {
  loadBoundaryContext.mockReset();
  loadBoundaryContext.mockResolvedValue({ token: "boundary-token" });
});

describe("EditBoundaryMark", () => {
  beforeEach(() => {
    vi.mocked(api.trimClipEdge).mockClear();
    vi.mocked(api.rollClipJoin).mockClear();
    loadBoundaryContext.mockResolvedValue({
      target: { kind: "roll", left_clip_id: "left", right_clip_id: "right" },
      token: "a".repeat(64),
      track_id: "host",
      geometry: [],
      current: { source_sec: 20, timeline_sec: 10 },
      limits: { min: -1, max: 1, fine_step_sec: 0.001, regular_step_sec: 0.01 },
    });
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
    const { getByRole } = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const mark = getByRole("button");

    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    expect(mark.className).not.toContain("dragging");
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(mark.className).toContain("dragging");
    expect(document.querySelector(".edit-ghost-words")?.textContent).toContain(
      "ghostly",
    );
    expect(document.querySelector(".edit-ghost-words")?.textContent).toContain(
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
      "a".repeat(64),
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

  it("opens the precision dialog on a tap and keeps a drag on the quick edit path", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
    });
    const { getByRole, unmount } = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });
    fireEvent.click(mark);
    expect(
      await screen.findByRole("dialog", { name: "Adjust boundary" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mark).toHaveFocus());
    unmount();

    const second = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const dragMark = second.getByRole("button");
    fireEvent.pointerDown(dragMark, { pointerId: 2, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 180 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 180 });
    expect(
      screen.queryByRole("dialog", { name: "Adjust boundary" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(api.rollClipJoin).toHaveBeenCalled());
  });

  it("starts a fresh context load before showing editable controls on reopen", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({ id: "right", source_start: 25, timeline_start: 10 });
    render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const mark = screen.getByRole("button", { name: /roll/i });
    fireEvent.click(mark);
    await screen.findByRole("spinbutton");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    let resolveReload: ((value: unknown) => void) | undefined;
    loadBoundaryContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReload = resolve;
        }),
    );
    fireEvent.click(mark);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Preparing boundary controls",
    );
    resolveReload?.({
      target: { kind: "roll", left_clip_id: "left", right_clip_id: "right" },
      token: "b".repeat(64),
      track_id: "host",
      geometry: [],
      current: { source_sec: 20, timeline_sec: 10 },
      limits: { min: -1, max: 1, fine_step_sec: 0.001, regular_step_sec: 0.01 },
    });
    expect(await screen.findByRole("spinbutton")).toHaveValue(0);
  });

  it("allows authorized guest quick drags while keeping precision host-only", async () => {
    useDawStore.setState({
      projectPath: "share:edit-token",
      guestMode: "edit",
      shareCapabilities: ["edit"],
    });
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const view = render(
      <EditBoundaryMark
        boundary={boundary}
        leftClip={left}
        rightClip={right}
      />,
    );
    const mark = view.getByRole("button");
    expect(mark).toBeEnabled();
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(api.rollClipJoin).toHaveBeenCalled());
    expect(loadBoundaryContext).toHaveBeenCalledWith(
      "share:edit-token",
      { kind: "roll", left_clip_id: "left", right_clip_id: "right" },
      expect.any(Array),
    );
    fireEvent.click(mark);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
    });
  });

  it.each(["{Enter}", " "])(
    "opens the precision dialog with native keyboard activation %s",
    async (key) => {
      const user = userEvent.setup();
      const left = clip({ id: "left", source_end: 20 });
      const right = clip({ id: "right", source_start: 25, timeline_start: 10 });
      render(
        <EditBoundaryMark
          boundary={boundary}
          leftClip={left}
          rightClip={right}
        />,
      );
      const mark = screen.getByRole("button");
      mark.focus();
      await user.keyboard(key);
      expect(
        await screen.findByRole("dialog", { name: "Adjust boundary" }),
      ).toBeInTheDocument();
    },
  );

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
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(mark).toHaveAttribute("aria-grabbed", "true");
    expect(
      getByRole("group", { name: "Preview restored words" }),
    ).toHaveTextContent("ghostly");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(onRoll).toHaveBeenCalled());
    expect(mark).toHaveAttribute("aria-grabbed", "false");
    expect(onRoll).toHaveBeenCalledWith(
      "left",
      "right",
      expect.any(Number),
      "boundary-token",
    );
    const delta = onRoll.mock.calls[0]?.[2];
    expect(delta).toBeGreaterThan(0);
    expect(onTrim).not.toHaveBeenCalled();
    expect(document.body.classList.contains("is-boundary-dragging")).toBe(
      false,
    );
  });

  it("discards a cancelled gesture without creating an edit", () => {
    const onTrim = vi.fn();
    const { getByRole } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={clip({ id: "left", source_end: 20 })}
        rightClip={null}
        getRollBounds={getRollBounds}
        onRoll={vi.fn()}
        onTrim={onTrim}
      />,
    );
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    fireEvent.pointerCancel(window, { pointerId: 1, clientX: 180 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    expect(onTrim).not.toHaveBeenCalled();
    expect(mark).toHaveAttribute("aria-grabbed", "false");
    expect(document.body).not.toHaveClass("is-boundary-dragging");
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
    expect(onTrim).toHaveBeenCalledWith(
      "left",
      "out",
      expect.any(Number),
      "ripple",
      "boundary-token",
    );
    const value = onTrim.mock.calls[0]?.[2];
    expect(value).toBeGreaterThan(20);
  });

  it("preflights a quick drag with the geometry captured at pointer down", async () => {
    const priorProjectPath = useDawStore.getState().projectPath;
    useDawStore.setState({ projectPath: "/tmp/captured-project" });
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const props = {
      projectPath: "/tmp/captured-project",
      boundary,
      leftClip: left,
      rightClip: right,
      getRollBounds,
      onRoll: vi.fn(),
      onTrim: vi.fn(),
    };
    const view = render(<EditBoundaryMarkView {...props} />);
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    view.rerender(
      <EditBoundaryMarkView
        {...props}
        rightClip={{ ...right, source_start: 26 }}
      />,
    );
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(loadBoundaryContext).toHaveBeenCalled());
    expect(loadBoundaryContext).toHaveBeenCalledWith(
      "/tmp/captured-project",
      { kind: "roll", left_clip_id: "left", right_clip_id: "right" },
      [
        {
          id: "left",
          source_start: 10,
          source_end: 20,
          timeline_start: 0,
          source_id: null,
        },
        {
          id: "right",
          source_start: 25,
          source_end: 40,
          timeline_start: 10,
          source_id: null,
        },
      ],
    );
    useDawStore.setState({ projectPath: priorProjectPath });
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

  it("keeps aria-grabbed as axe needs-review, not a violation, while dragging", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const right = clip({
      id: "right",
      source_start: 25,
      source_end: 40,
      timeline_start: 10,
      timeline_end: 25,
    });
    const { container, getByRole } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={right}
        getRollBounds={getRollBounds}
        onRoll={vi.fn()}
        onTrim={vi.fn()}
      />,
    );
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(mark).toHaveAttribute("aria-grabbed", "true");
    // docs/design-system.md (Templates/EditBoundaryMark): if an axe upgrade
    // turns this into a violation, replace aria-grabbed with a drag message.
    const results = await axe.run(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
    const allowedAttr = results.incomplete.find(
      (r) => r.id === "aria-allowed-attr",
    );
    const checks =
      allowedAttr?.nodes.flatMap((n) => n.all.map((c) => c.id)) ?? [];
    expect(checks).toContain("aria-no-deprecated-attr");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });
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

  const DRAG_TYPES = ["pointermove", "pointerup", "pointercancel"];

  function expectDragListenersRemoved(
    add: { mock: { calls: unknown[][] } },
    remove: { mock: { calls: unknown[][] } },
  ) {
    const added = add.mock.calls.filter((c) =>
      DRAG_TYPES.includes(c[0] as string),
    );
    expect(added.length).toBeGreaterThan(0);
    for (const [type, fn] of added) {
      expect(
        remove.mock.calls.some((r) => r[0] === type && r[1] === fn),
        `${String(type)} listener removed`,
      ).toBe(true);
    }
  }

  it("ignores a second pointer and leaks no listeners", async () => {
    const left = clip({ id: "left", source_end: 20 });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onTrim = vi.fn();
    const { getByRole } = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={left}
        rightClip={null}
        getRollBounds={getRollBounds}
        onRoll={vi.fn()}
        onTrim={onTrim}
      />,
    );
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    fireEvent.pointerDown(mark, { pointerId: 2, clientX: 300 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 300 });
    expect(mark).toHaveAttribute("aria-grabbed", "true");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
    expectDragListenersRemoved(add, remove);
    add.mockRestore();
    remove.mockRestore();
  });

  it("removes every drag listener when unmounted mid-drag with two pointers down", () => {
    const left = clip({ id: "left", source_end: 20 });
    const add = vi.spyOn(window, "addEventListener");
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
    const mark = getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerDown(mark, { pointerId: 2, clientX: 300 });
    unmount();
    expectDragListenersRemoved(add, remove);
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("boundary gesture lifecycle", () => {
  function setup(onTrim = vi.fn()) {
    const view = render(
      <div className="transcript-list">
        <EditBoundaryMarkView
          boundary={boundary}
          leftClip={clip({ id: "left", source_end: 20 })}
          rightClip={null}
          getRollBounds={() => ({
            prevSourceEnd: 0,
            nextSourceStart: 80,
            mediaEnd: 80,
          })}
          onRoll={vi.fn()}
          onTrim={onTrim}
        />
      </div>,
    );
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    return { ...view, mark, onTrim };
  }

  it.each(["blur", "resize", "scroll", "lostpointercapture", "escape"])(
    "cancels on %s",
    (reason) => {
      const { mark, onTrim } = setup();
      if (reason === "escape") fireEvent.keyDown(mark, { key: "Escape" });
      else if (reason === "lostpointercapture")
        fireEvent(mark, new PointerEvent(reason, { pointerId: 1 }));
      else if (reason === "scroll")
        fireEvent.scroll(mark.closest(".transcript-list") ?? document);
      else fireEvent(window, new Event(reason));
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
      expect(onTrim).not.toHaveBeenCalled();
      expect(mark).toHaveAttribute("aria-grabbed", "false");
      expect(document.body).not.toHaveClass("is-boundary-dragging");
    },
  );

  it("keeps feedback outside the text flow and reports exact delta", () => {
    const { mark, container } = setup();
    expect(mark.textContent).toBe("¦");
    expect(mark.style.transform).toBe("translateX(5rem)");
    expect(container.querySelector(".edit-boundary-preview")).toBeNull();
    expect(document.querySelector(".edit-boundary-preview")).toHaveTextContent(
      "Trim out +1.00s",
    );
    fireEvent.pointerCancel(window, { pointerId: 1 });
  });

  it("blocks another gesture while saving and presents rejected commits", async () => {
    let rejectSave: (reason: Error) => void = () => undefined;
    const onTrim = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const { mark, getByRole } = setup(onTrim);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    expect(mark).toBeDisabled();
    expect(getByRole("status")).toHaveTextContent("Saving boundary edit");
    fireEvent.pointerDown(mark, { pointerId: 2, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 180 });
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
    rejectSave(new Error("offline"));
    await waitFor(() =>
      expect(getByRole("alert")).toHaveTextContent("offline"),
    );
    expect(mark).not.toBeDisabled();
  });

  it("cancels when focus leaves the boundary", () => {
    const { mark, onTrim } = setup();
    fireEvent.blur(mark);
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    expect(onTrim).not.toHaveBeenCalled();
    expect(mark).toHaveAttribute("aria-grabbed", "false");
    expect(document.body).not.toHaveClass("is-boundary-dragging");
  });

  it("bounds a long error and dismisses it with focus restored", async () => {
    const onTrim = vi.fn(async () => {
      throw new Error("Detailed server failure ".repeat(200));
    });
    const { mark, getByRole, queryByRole } = setup(onTrim);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 180 });
    const alert = await waitFor(() => getByRole("alert"));
    expect(alert).toHaveTextContent(
      "Detailed server failure ".repeat(200).trim(),
    );
    expect(
      getByRole("region", { name: "Boundary edit feedback" }),
    ).toContainElement(alert);
    await expectNoA11yViolations(document.body);
    const preview = alert.closest<HTMLElement>(".edit-boundary-preview");
    expect(preview?.style.maxHeight).toBeTruthy();
    expect(preview).toHaveClass("edit-boundary-preview-error");
    fireEvent.click(getByRole("button", { name: "Dismiss boundary error" }));
    expect(queryByRole("alert")).toBeNull();
    expect(mark).toHaveFocus();
  });

  it("trims a right edge inward with frozen source math", async () => {
    const onTrim = vi.fn();
    const view = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={null}
        rightClip={clip({ id: "right", source_start: 25, source_end: 40 })}
        getRollBounds={() => ({
          prevSourceEnd: 0,
          nextSourceStart: 80,
          mediaEnd: 80,
        })}
        onRoll={vi.fn()}
        onTrim={onTrim}
      />,
    );
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20 });
    expect(view.getByRole("status")).toHaveTextContent("Trim in -1.00s");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20 });
    await waitFor(() =>
      expect(onTrim).toHaveBeenCalledWith(
        "right",
        "in",
        24,
        "ripple",
        "boundary-token",
      ),
    );
  });

  it("freezes legal movement and reports the reached limit", async () => {
    const onRoll = vi.fn();
    const bounds = () => ({
      prevSourceEnd: 0,
      nextSourceStart: 80,
      mediaEnd: 20.5,
    });
    const view = render(
      <EditBoundaryMarkView
        boundary={boundary}
        leftClip={clip({ id: "left", source_end: 20 })}
        rightClip={clip({ id: "right", source_start: 25, source_end: 40 })}
        getRollBounds={bounds}
        onRoll={onRoll}
        onTrim={vi.fn()}
      />,
    );
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 180 });
    expect(mark.style.transform).toBe("translateX(5rem)");
    expect(view.getByRole("status")).toHaveTextContent(
      "+0.50s · Limit reached",
    );
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300 });
    expect(mark.style.transform).toBe("translateX(12.5rem)");
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300 });
    await waitFor(() =>
      expect(onRoll).toHaveBeenCalledWith(
        "left",
        "right",
        0.5,
        "boundary-token",
      ),
    );
  });

  it("uses fine Shift motion mid-gesture while the mark stays under the pointer", async () => {
    useDawStore.setState({ projectPath: "/tmp/fine-drag" });
    const onRoll = vi.fn();
    const view = render(
      <EditBoundaryMarkView
        projectPath="/tmp/fine-drag"
        boundary={boundary}
        leftClip={clip({ id: "left", source_end: 20 })}
        rightClip={clip({ id: "right", source_start: 25, source_end: 40 })}
        getRollBounds={() => ({
          prevSourceEnd: 0,
          nextSourceStart: 80,
          mediaEnd: 80,
        })}
        onRoll={onRoll}
        onTrim={vi.fn()}
      />,
    );
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 106,
      shiftKey: false,
    });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 107,
      shiftKey: true,
    });
    expect(view.getByRole("status")).toHaveTextContent(
      "Roll join +0.076s · Fine drag",
    );
    expect(mark.style.transform).toBe("translateX(0.4375rem)");
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 107,
      shiftKey: true,
    });
    await waitFor(() => expect(onRoll).toHaveBeenCalled());
    expect(onRoll.mock.calls[0]?.[2]).toBeCloseTo(0.076, 9);
    useDawStore.setState({ projectPath: "/tmp/ep" });
  });

  it("keeps raw pointer tracking while fine semantic motion reaches its bound", async () => {
    useDawStore.setState({ projectPath: "/tmp/fine-bound" });
    const onRoll = vi.fn();
    const view = render(
      <EditBoundaryMarkView
        projectPath="/tmp/fine-bound"
        boundary={boundary}
        leftClip={clip({ id: "left", source_end: 20 })}
        rightClip={clip({ id: "right", source_start: 25, source_end: 40 })}
        getRollBounds={() => ({
          prevSourceEnd: 0,
          nextSourceStart: 30,
          mediaEnd: 20.1,
        })}
        onRoll={onRoll}
        onTrim={vi.fn()}
      />,
    );
    const mark = view.getByRole("button");
    fireEvent.pointerDown(mark, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(window, {
      pointerId: 1,
      clientX: 300,
      shiftKey: true,
    });
    expect(view.getByRole("status")).toHaveTextContent(
      "Roll join +0.100s · Limit reached",
    );
    expect(mark.style.transform).toBe("translateX(12.5rem)");
    fireEvent.pointerUp(window, {
      pointerId: 1,
      clientX: 300,
      shiftKey: true,
    });
    await waitFor(() => expect(onRoll).toHaveBeenCalled());
    expect(onRoll.mock.calls[0]?.[2]).toBeCloseTo(0.1, 9);
    useDawStore.setState({ projectPath: "/tmp/ep" });
  });

  it("no-ops at the original position and commits only once", async () => {
    const { mark, onTrim } = setup();
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 100 });
    expect(onTrim).not.toHaveBeenCalled();
    fireEvent.pointerDown(mark, { pointerId: 3, clientX: 100 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 180 });
    fireEvent.pointerUp(window, { pointerId: 3, clientX: 180 });
    await waitFor(() => expect(onTrim).toHaveBeenCalledTimes(1));
  });
});
