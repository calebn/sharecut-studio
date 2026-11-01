import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { registerChapterCommands } from "../commands/chapters";
import { clearRegisteredCommands, execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject, sampleComment } from "../test/fixtures";
import type { HistoryEntryId, SocialClipView } from "../types/project";
import { movedMarker } from "./laneMarkers";
import { LiveMarkerLane, MarkerLaneHost } from "./MarkerLaneHost";
import { markerLaneHeight, markerLaneRow, markerRows } from "./timelineMetrics";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    addChapter: vi.fn(),
    updateChapter: vi.fn(),
    updateSocialClip: vi.fn(),
  };
});

const clip: SocialClipView = {
  id: "social",
  track_id: "host",
  review_required: false,
  start: 10,
  end: 14,
  score: 0.5,
  approved: false,
  title_suggestion: "Moment",
};
const base = {
  chapters: [],
  socialClips: [clip],
  comments: [],
  showMarkers: true,
  showComments: false,
  selected: ["social"],
  zoomPxPerSec: 10,
  width: 400,
  duration: 40,
  laneRow: true,
  onSelectChapter: vi.fn(),
  onSelectSocial: vi.fn(),
  onSelectComment: vi.fn(),
};

function nameChapter(container: HTMLElement, title: string) {
  fireEvent.doubleClick(container.querySelector(".sys-markers-track")!, {
    clientX: 100,
  });
  const field = screen.getByRole("textbox", { name: "Chapter name" });
  fireEvent.change(field, { target: { value: title } });
  fireEvent.keyDown(field, { key: "Enter" });
}

describe("marker lane regression contracts", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerChapterCommands();
    vi.mocked(api.addChapter).mockReset();
    useDawStore.getState().hydrate("/tmp/marker-reset.json", minimalProject());
    useDawStore.getState().hydrate("/tmp/marker-a.json", minimalProject());
  });

  it("hides clipping with Markers off and agrees with short-screen height accounting", () => {
    const input = {
      ...base,
      showMarkers: false,
      clippingFlags: [
        { id: "flag", trackId: "host", label: "Host", start: 5, end: 5.2 },
      ],
    };
    const rows = markerRows(input);
    const fit = { kind: "touchShort", floorPx: 48 } as const;
    const view = render(
      <MarkerLaneHost
        {...input}
        laneRow={markerLaneRow(rows, fit)}
        readOnly={false}
      />,
    );
    expect(markerLaneHeight(rows, fit)).toBe(0);
    expect(
      screen.queryByRole("button", { name: /Clipping on Host/ }),
    ).toBeNull();
    expect(view.container.querySelector(".marker-lane.empty")).not.toBeNull();
    view.rerender(<MarkerLaneHost {...input} showMarkers readOnly={false} />);
    expect(
      screen.getByRole("button", { name: /Clipping on Host/ }),
    ).toBeVisible();
  });

  it("preserves the whole clip span when repeated keyboard nudges reach the episode end", () => {
    const onMoveSocial = vi.fn();
    render(
      <MarkerLaneHost
        {...base}
        socialClips={[{ ...clip, start: 34, end: 38 }]}
        readOnly={false}
        onMoveSocial={onMoveSocial}
      />,
    );
    const button = screen.getByRole("button", { name: /Clip idea Moment/ });
    button.focus();
    for (let n = 0; n < 7; n++)
      fireEvent.keyDown(button, {
        key: "ArrowRight",
        shiftKey: true,
        repeat: n > 0,
      });
    fireEvent.keyUp(button, { key: "ArrowRight" });
    expect(onMoveSocial).toHaveBeenCalledOnce();
    expect(onMoveSocial).toHaveBeenCalledWith("social", 36, 40);
  });

  it.each(["collaborator", "zoom"])(
    "cancels an obsolete drag after a %s change",
    (change) => {
      const onMoveSocial = vi.fn();
      const view = render(
        <MarkerLaneHost
          {...base}
          readOnly={false}
          onMoveSocial={onMoveSocial}
        />,
      );
      const button = screen.getByRole("button", { name: /Clip idea Moment/ });
      const track = view.container.querySelector(".sys-markers-track")!;
      fireEvent.pointerDown(button, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 100,
        clientY: 12,
      });
      fireEvent.pointerMove(track, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 130,
        clientY: 12,
      });
      expect(view.container.querySelector(".sys-readout")).not.toBeNull();
      view.rerender(
        <MarkerLaneHost
          {...base}
          socialClips={
            change === "collaborator"
              ? [{ ...clip, start: 20, end: 24 }]
              : [clip]
          }
          zoomPxPerSec={change === "zoom" ? 20 : 10}
          readOnly={false}
          onMoveSocial={onMoveSocial}
        />,
      );
      fireEvent.pointerUp(track, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 130,
        clientY: 12,
      });
      expect(onMoveSocial).not.toHaveBeenCalled();
      expect(view.container.querySelector(".sys-readout")).toBeNull();
    },
  );

  it("shares one pending add across inline names and the global command", async () => {
    const pending = deferred<HistoryEntryId | null>();
    vi.mocked(api.addChapter).mockReturnValue(pending.promise);
    const view = render(<LiveMarkerLane {...base} />);
    nameChapter(view.container, "First");
    await waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());
    const command = execute(
      "edit.addChapter",
      { atTime: 12 },
      { skipWhen: true },
    );
    try {
      expect(api.addChapter).toHaveBeenCalledOnce();
      fireEvent.doubleClick(
        view.container.querySelector(".sys-markers-track")!,
        { clientX: 150 },
      );
      expect(
        screen.queryByRole("textbox", { name: "Chapter name" }),
      ).toBeNull();
    } finally {
      await act(async () => pending.resolve(null));
    }
    expect(await command).toEqual({
      status: "disabled",
      reason: "Add already in progress",
    });
    await waitFor(() =>
      expect(useDawStore.getState().chapterAddPending).toBe(false),
    );
  });

  it("refuses an inline name while the global command is pending", async () => {
    const pending = deferred<HistoryEntryId | null>();
    vi.mocked(api.addChapter).mockReturnValue(pending.promise);
    const command = execute(
      "edit.addChapter",
      { atTime: 8 },
      { skipWhen: true },
    );
    const view = render(<LiveMarkerLane {...base} />);
    fireEvent.doubleClick(view.container.querySelector(".sys-markers-track")!, {
      clientX: 150,
    });
    expect(screen.queryByRole("textbox", { name: "Chapter name" })).toBeNull();
    expect(api.addChapter).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(null));
    await command;
  });

  it.each(["resolve", "reject"])(
    "ignores an inline add's stale %s after reopening a project",
    async (settlement) => {
      const pending = deferred<HistoryEntryId | null>();
      const newer = deferred<HistoryEntryId | null>();
      vi.mocked(api.addChapter)
        .mockReturnValueOnce(pending.promise)
        .mockReturnValueOnce(newer.promise);
      const view = render(<LiveMarkerLane {...base} />);
      nameChapter(view.container, "Old opening");
      await waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());
      let newerRun: ReturnType<typeof execute> | undefined;
      act(() => {
        useDawStore
          .getState()
          .hydrate("/tmp/marker-away.json", minimalProject());
        useDawStore.getState().hydrate("/tmp/marker-a.json", minimalProject());
        newerRun = execute(
          "edit.addChapter",
          { atTime: 20, title: "New chapter" },
          { skipWhen: true },
        );
        useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
        useDawStore.getState().announceStatus("New opening");
      });
      await act(async () => {
        if (settlement === "resolve") pending.resolve(null);
        else pending.reject(new Error("Old opening failed"));
      });
      expect(useDawStore.getState().selection).toEqual({
        kind: "track",
        trackId: "host",
      });
      expect(useDawStore.getState().statusAnnouncement).toBe("New opening");
      expect(useDawStore.getState().chapterAddPending).toBe(true);
      expect(api.addChapter).toHaveBeenCalledTimes(2);
      await act(async () => {
        newer.resolve(null);
        await newerRun;
      });
      expect(useDawStore.getState().chapterAddPending).toBe(false);
    },
  );
  it("reverses immediately after a held body nudge reaches the episode end", () => {
    const onMoveSocial = vi.fn();
    render(
      <MarkerLaneHost
        {...base}
        socialClips={[{ ...clip, start: 34, end: 38 }]}
        readOnly={false}
        onMoveSocial={onMoveSocial}
      />,
    );
    const button = screen.getByRole("button", { name: /Clip idea Moment/ });
    for (let n = 0; n < 7; n++)
      fireEvent.keyDown(button, {
        key: "ArrowRight",
        shiftKey: true,
        repeat: n > 0,
      });
    expect(button).toHaveAccessibleName(/0:36.0 to 0:40.0/);
    fireEvent.keyDown(button, { key: "ArrowLeft", shiftKey: true });
    expect(button).toHaveAccessibleName(/0:35.0 to 0:39.0/);
    fireEvent.keyUp(button, { key: "ArrowLeft" });
    expect(onMoveSocial).toHaveBeenCalledExactlyOnceWith("social", 35, 39);
  });

  it.each(["collaborator", "zoom"])(
    "cancels a press before threshold after a %s change",
    (change) => {
      const onMoveSocial = vi.fn();
      const props = { ...base, readOnly: false, onMoveSocial };
      const view = render(<MarkerLaneHost {...props} />);
      const button = screen.getByRole("button", { name: /Clip idea Moment/ });
      const track = view.container.querySelector(".sys-markers-track")!;
      fireEvent.pointerDown(button, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 100,
      });
      view.rerender(
        <MarkerLaneHost
          {...props}
          socialClips={
            change === "collaborator"
              ? [{ ...clip, start: 20, end: 24 }]
              : [clip]
          }
          zoomPxPerSec={change === "zoom" ? 20 : 10}
        />,
      );
      fireEvent.pointerMove(track, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 130,
      });
      fireEvent.pointerUp(track, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 130,
      });
      expect(onMoveSocial).not.toHaveBeenCalled();
      expect(view.container.querySelector(".sys-readout")).toBeNull();
    },
  );

  it("keeps its own preview and identical refreshed source valid", () => {
    const onMoveSocial = vi.fn();
    const props = { ...base, readOnly: false, onMoveSocial };
    const view = render(<MarkerLaneHost {...props} />);
    const button = screen.getByRole("button", { name: /Clip idea Moment/ });
    const track = view.container.querySelector(".sys-markers-track")!;
    fireEvent.pointerDown(button, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
    });
    fireEvent.pointerMove(track, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 130,
    });
    expect(button).toHaveAccessibleName(/0:13.0 to 0:17.0/);
    view.rerender(
      <MarkerLaneHost
        {...props}
        socialClips={[{ ...clip }]}
        chapters={[{ time: 30, title: "Unrelated" }]}
      />,
    );
    expect(button).toHaveAccessibleName(/0:13.0 to 0:17.0/);
    fireEvent.pointerUp(track, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 130,
    });
    expect(onMoveSocial).toHaveBeenCalledExactlyOnceWith("social", 13, 17);
  });

  it("cancels held keys and suppresses their repeats after source changes", () => {
    const onMoveSocial = vi.fn();
    const props = { ...base, readOnly: false, onMoveSocial };
    const view = render(<MarkerLaneHost {...props} />);
    const button = screen.getByRole("button", { name: /Clip idea Moment/ });
    fireEvent.keyDown(button, { key: "ArrowRight" });
    view.rerender(
      <MarkerLaneHost
        {...props}
        socialClips={[{ ...clip, start: 20, end: 24 }]}
      />,
    );
    fireEvent.keyDown(button, { key: "ArrowRight", repeat: true });
    expect(button).toHaveAccessibleName(/0:20.0 to 0:24.0/);
    fireEvent.keyUp(button, { key: "ArrowRight" });
    expect(onMoveSocial).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "ArrowLeft" });
    fireEvent.blur(button);
    expect(onMoveSocial).toHaveBeenCalledExactlyOnceWith("social", 19.9, 23.9);
  });

  it("an older save settlement cannot erase a newer held preview", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const onMoveSocial = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const props = { ...base, readOnly: false, onMoveSocial };
    const view = render(<MarkerLaneHost {...props} />);
    const button = screen.getByRole("button", { name: /Clip idea Moment/ });
    fireEvent.keyDown(button, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(button, { key: "ArrowRight" });
    view.rerender(
      <MarkerLaneHost
        {...props}
        socialClips={[{ ...clip, start: 11, end: 15 }]}
      />,
    );
    fireEvent.keyDown(button, { key: "ArrowRight", shiftKey: true });
    expect(button).toHaveAccessibleName(/0:12.0 to 0:16.0/);
    await act(async () => first.resolve());
    expect(button).toHaveAccessibleName(/0:12.0 to 0:16.0/);
    fireEvent.keyUp(button, { key: "ArrowRight" });
    expect(onMoveSocial.mock.calls).toEqual([
      ["social", 11, 15],
      ["social", 12, 16],
    ]);
    await act(async () => second.resolve());
  });

  it.each(["chapter", "social"])(
    "ignores a live %s move completion after switching away and reopening",
    async (kind) => {
      const pending = deferred<void>();
      const request =
        kind === "chapter"
          ? vi.mocked(api.updateChapter)
          : vi.mocked(api.updateSocialClip);
      request.mockReset().mockReturnValue(pending.promise);
      const view = render(
        <LiveMarkerLane
          {...base}
          chapters={[{ time: 2, title: "Intro" }]}
          selected={kind === "chapter" ? ["2-Intro"] : ["social"]}
        />,
      );
      const button = screen.getByRole("button", {
        name: kind === "chapter" ? /^Chapter Intro/ : /Clip idea Moment/,
      });
      fireEvent.keyDown(button, { key: "ArrowRight" });
      fireEvent.keyUp(button, { key: "ArrowRight" });
      expect(request).toHaveBeenCalledOnce();
      act(() => {
        useDawStore
          .getState()
          .hydrate("/tmp/marker-away.json", minimalProject());
        useDawStore.getState().hydrate("/tmp/marker-a.json", minimalProject());
        useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
      });
      await act(async () => pending.resolve());
      expect(useDawStore.getState().selection).toEqual({
        kind: "track",
        trackId: "host",
      });
      view.unmount();
    },
  );

  it.each([
    {
      showMarkers: true,
      showComments: false,
      socialClips: [],
      comments: [],
      flags: true,
    },
    {
      showMarkers: false,
      showComments: true,
      socialClips: [],
      comments: [sampleComment({ id: "comment", timeline_start: 2 })],
      flags: true,
    },
    {
      showMarkers: false,
      showComments: false,
      socialClips: [],
      comments: [],
      flags: true,
    },
  ])(
    "draws exactly the rows reserved by short-screen metrics $showMarkers/$showComments",
    (input) => {
      const props = {
        ...base,
        ...input,
        clippingFlags: [
          { id: "flag", trackId: "host", label: "Host", start: 5, end: 5.2 },
        ],
      };
      const rows = markerRows(props);
      const fit = { kind: "touchShort", floorPx: 48 } as const;
      const view = render(
        <MarkerLaneHost
          {...props}
          laneRow={markerLaneRow(rows, fit)}
          readOnly={false}
        />,
      );
      expect(
        view.container.querySelectorAll(".sys-markers, .marker-row.clipping"),
      ).toHaveLength(markerLaneHeight(rows, fit) / 24);
    },
  );

  it.each([
    { duration: 40, delta: 30, start: 36, end: 40 },
    { duration: 40, delta: -30, start: 0, end: 4 },
    { duration: 0, delta: -30, start: -20, end: -16 },
    { duration: 3, delta: 30, start: 40, end: 44 },
    { duration: 40, delta: Number.NaN, start: 10, end: 14 },
  ])(
    "preserves shared bounds semantics for $duration seconds and $delta delta",
    ({ duration, delta, start, end }) => {
      expect(
        movedMarker(
          { kind: "clip", id: "social", start: 10, end: 14, title: "Moment" },
          "move",
          delta,
          duration,
        ),
      ).toMatchObject({ start, end });
    },
  );
});
