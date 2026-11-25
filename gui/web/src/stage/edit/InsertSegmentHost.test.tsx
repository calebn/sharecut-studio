import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { selectionAnchor } from "../../commands/timelineReveal";
import { insertPreview, LIBRARY } from "../../segments/fixtures";
import { useDawStore } from "../../state/dawStore";
import { editFixtureProject } from "../../test/actionBarFixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ApiError } from "../../utils/apiError";
import { InsertSegmentHost } from "./InsertSegmentHost";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadSegments: vi.fn(),
  previewSegmentInsert: vi.fn(),
  insertSegment: vi.fn(),
}));

const APPLIED = {
  operation: "insert_segment" as const,
  affected_tracks: [],
  clip_count: 1,
  timeline_duration_sec: 622,
  segment_id: "intro-9f3a",
  segment_version: 1,
  at: 0,
  duration_sec: 22,
  tracks: {},
};

beforeEach(() => {
  vi.mocked(api.loadSegments).mockReset().mockResolvedValue(LIBRARY);
  vi.mocked(api.previewSegmentInsert)
    .mockReset()
    .mockImplementation((_path, request) =>
      Promise.resolve(insertPreview({ segment_id: request.segment_id })),
    );
  vi.mocked(api.insertSegment).mockReset();
  stubViewportShell("phone");
  useDawStore.setState({
    project: editFixtureProject(),
    projectPath: "/tmp/episode",
    playheadSec: 7.25,
    feedbackToast: null,
  });
  useDawStore.getState().setInsertSegmentOpen(false);
});

afterEach(() => {
  selectionAnchor.clear();
  document.getElementById("test-anchor")?.remove();
  vi.unstubAllGlobals();
});

const open = () => act(() => useDawStore.getState().setInsertSegmentOpen(true));

const pickIntro = async () => {
  await userEvent.click(
    await screen.findByRole("radio", { name: /Cold open/ }),
  );
  await screen.findByText(/Preview, from the saved episode/);
};

describe("InsertSegmentHost", () => {
  it("renders nothing until opened", () => {
    render(<InsertSegmentHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.loadSegments).not.toHaveBeenCalled();
  });

  it("previews, inserts at the start and toasts with Undo on a phone", async () => {
    vi.mocked(api.insertSegment).mockResolvedValue({
      queued: false,
      applied: APPLIED,
      historyHead: "h-9" as never,
    });
    render(<InsertSegmentHost />);
    open();
    await pickIntro();
    expect(api.previewSegmentInsert).toHaveBeenLastCalledWith(
      "/tmp/episode",
      { segment_id: "intro-9f3a", at: "start" },
      expect.any(AbortSignal),
    );
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.insertSegmentOpen).toBe(false),
    );
    expect(api.insertSegment).toHaveBeenCalledWith("/tmp/episode", {
      segment_id: "intro-9f3a",
      at: "start",
      version: 1,
    });
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Inserted Cold open: 0:22 at 0:00");
    expect(toast?.undo).toBe("h-9");
  });

  it("offers no Undo when the reply has no history head", async () => {
    vi.mocked(api.insertSegment).mockResolvedValue({
      queued: false,
      applied: APPLIED,
      historyHead: null,
    });
    render(<InsertSegmentHost />);
    open();
    await pickIntro();
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.insertSegmentOpen).toBe(false),
    );
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Inserted Cold open: 0:22 at 0:00");
    expect(toast?.undo).toBeFalsy();
  });

  it("says a queued insert waits for a reconnect, with no Undo and no move claim", async () => {
    vi.mocked(api.insertSegment).mockResolvedValue({
      queued: true,
      historyHead: null,
    });
    render(<InsertSegmentHost />);
    open();
    await pickIntro();
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.insertSegmentOpen).toBe(false),
    );
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Insert of Cold open queued. Reconnect to send it.");
    expect(toast?.undo).toBeFalsy();
    expect(toast?.message).not.toMatch(/moved|inserted/i);
  });

  it("keeps the card open and explains a refusal", async () => {
    vi.mocked(api.insertSegment).mockRejectedValue(
      new ApiError("x", "segment_hash_mismatch", 409),
    );
    render(<InsertSegmentHost />);
    open();
    await pickIntro();
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /changed since it was saved/,
    );
    expect(useDawStore.getState().chrome.insertSegmentOpen).toBe(true);
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("holds the playhead and project the card opened with", async () => {
    vi.mocked(api.insertSegment).mockResolvedValue({
      queued: false,
      applied: APPLIED,
      historyHead: null,
    });
    render(<InsertSegmentHost />);
    open();
    await userEvent.click(
      await screen.findByRole("radio", { name: /Acme sponsor read/ }),
    );
    await screen.findByText(/Preview, from the saved episode/);
    act(() =>
      useDawStore.setState({ playheadSec: 300, projectPath: "/tmp/other" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Insert" }));
    await waitFor(() => expect(api.insertSegment).toHaveBeenCalledTimes(1));
    expect(api.insertSegment).toHaveBeenCalledWith("/tmp/episode", {
      segment_id: "sponsor-21bc",
      at: 7.25,
      version: 1,
    });
  });

  it("opens as an anchored dialog on desktop when there is an anchor", async () => {
    stubViewportShell("desktop");
    const el = document.createElement("div");
    el.id = "test-anchor";
    document.body.append(el);
    selectionAnchor.set({ current: el });
    render(<InsertSegmentHost />);
    open();
    const dialog = await screen.findByRole("dialog", {
      name: "Insert segment",
    });
    expect(dialog.closest(".ui-dialog-root--anchored")).not.toBeNull();
    expect(document.querySelector(".bottom-sheet")).toBeNull();
  });

  it("falls back to the bottom sheet on desktop when nothing can anchor it", async () => {
    stubViewportShell("desktop");
    render(<InsertSegmentHost />);
    open();
    await screen.findByRole("radio", { name: /Cold open/ });
    expect(document.querySelector(".ui-dialog-root--anchored")).toBeNull();
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
  });

  it("shows an empty library in plain words", async () => {
    vi.mocked(api.loadSegments).mockResolvedValue([]);
    render(<InsertSegmentHost />);
    open();
    expect(
      await screen.findByText(
        /Your library is empty\. Save clips as a segment/,
      ),
    ).toBeVisible();
  });
});
