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
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId, SocialClipView } from "../types/project";
import { LiveMarkerLane, MarkerLaneHost } from "./MarkerLaneHost";
import { markerLaneHeight, markerLaneRow, markerRows } from "./timelineMetrics";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, addChapter: vi.fn() };
});

const clip = {
  id: "social",
  start: 10,
  end: 14,
  score: 0.5,
  approved: false,
  title_suggestion: "Moment",
} as SocialClipView;
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
    const fit = { kind: "touchShort" } as const;
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
      vi.mocked(api.addChapter).mockReturnValue(pending.promise);
      const view = render(<LiveMarkerLane {...base} />);
      nameChapter(view.container, "Old opening");
      await waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());
      act(() => {
        useDawStore.getState().hydrate("/tmp/marker-a.json", minimalProject());
        useDawStore.getState().setSelection({ kind: "track", id: "host" });
        useDawStore.getState().announceStatus("New opening");
        useDawStore.getState().setChapterAddPending(true);
      });
      await act(async () => {
        if (settlement === "resolve") pending.resolve(null);
        else pending.reject(new Error("Old opening failed"));
      });
      expect(useDawStore.getState().selection).toEqual({
        kind: "track",
        id: "host",
      });
      expect(useDawStore.getState().statusAnnouncement).toBe("New opening");
      expect(useDawStore.getState().chapterAddPending).toBe(true);
    },
  );
});
