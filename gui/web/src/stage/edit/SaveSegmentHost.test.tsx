import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { selectionAnchor } from "../../commands/timelineReveal";
import { useDawStore } from "../../state/dawStore";
import { editFixtureProject, MIRA } from "../../test/actionBarFixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ApiError } from "../../utils/apiError";
import { SaveSegmentHost } from "./SaveSegmentHost";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  saveSegment: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.saveSegment).mockReset();
  stubViewportShell("phone");
  useDawStore.setState({
    project: editFixtureProject(),
    projectPath: "/tmp/episode",
    selection: { kind: "clip", id: "a", trackId: MIRA },
    feedbackToast: null,
  });
  useDawStore.getState().setSaveSegmentOpen(false);
});

afterEach(() => {
  selectionAnchor.clear();
  document.getElementById("test-anchor")?.remove();
});

function mountAnchor() {
  const el = document.createElement("div");
  el.id = "test-anchor";
  document.body.append(el);
  selectionAnchor.set({ current: el });
}

const nameField = async () => {
  const field = await screen.findByRole("textbox", { name: "Name" });
  await waitFor(() => expect(field).toHaveFocus());
  return field;
};

const open = () => act(() => useDawStore.getState().setSaveSegmentOpen(true));

describe("SaveSegmentHost", () => {
  it("renders nothing until opened", () => {
    render(<SaveSegmentHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("saves the selected clips and toasts without an Undo", async () => {
    vi.mocked(api.saveSegment).mockResolvedValue({
      status: "new_version",
      id: "cold-open-1",
      version: 2,
    });
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Cold open{Enter}");
    await waitFor(() =>
      expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(false),
    );
    expect(api.saveSegment).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/tmp/episode",
        name: "Cold open",
        kind: "intro",
        clip_ids: ["a"],
      }),
    );
    const toast = useDawStore.getState().feedbackToast;
    expect(toast?.message).toBe("Saved Cold open as version 2");
    expect(toast?.undo).toBeFalsy();
  });

  it("sends the kind the user picked instead of the guess", async () => {
    vi.mocked(api.saveSegment).mockResolvedValue({
      status: "added",
      id: "ad-read-1",
      version: 1,
    });
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Ad read");
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Kind" }),
      "sponsor",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.saveSegment).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Ad read", kind: "sponsor" }),
      ),
    );
  });

  it("keeps the card and shows a failure when the selection changes during a save", async () => {
    let fail!: (error: unknown) => void;
    vi.mocked(api.saveSegment).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Intro{Enter}");
    act(() => useDawStore.setState({ selection: null }));
    expect(screen.getByRole("textbox", { name: "Name" })).toBeVisible();
    await act(async () => fail(new ApiError("x", "segment_busy", 409)));
    expect(await screen.findByText(/library is busy/i)).toBeVisible();
    expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(true);
  });

  it("keeps the card open and explains a refusal", async () => {
    vi.mocked(api.saveSegment).mockRejectedValue(
      new ApiError("x", "segment_busy", 409),
    );
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Cold open{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/busy/);
    expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(true);
    expect(useDawStore.getState().feedbackToast).toBeNull();
  });

  it("closes itself when the selection no longer fits", async () => {
    render(<SaveSegmentHost />);
    open();
    await screen.findByRole("dialog", { name: "Save as segment" });
    act(() => useDawStore.setState({ selection: null }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(false),
    );
  });

  it("opens as an anchored dialog on desktop when the selection has an anchor", async () => {
    stubViewportShell("desktop");
    mountAnchor();
    vi.mocked(api.saveSegment).mockResolvedValue({
      status: "added",
      id: "intro-1",
      version: 1,
    });
    render(<SaveSegmentHost />);
    open();
    const dialog = await screen.findByRole("dialog", {
      name: "Save as segment",
    });
    expect(dialog.closest(".ui-dialog-root--anchored")).not.toBeNull();
    expect(document.querySelector(".bottom-sheet")).toBeNull();
    await userEvent.type(await nameField(), "Intro{Enter}");
    await waitFor(() =>
      expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(false),
    );
    expect(api.saveSegment).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Intro", clip_ids: ["a"] }),
    );
  });

  it("falls back to the bottom sheet on desktop when there is no anchor", async () => {
    stubViewportShell("desktop");
    render(<SaveSegmentHost />);
    open();
    await nameField();
    expect(document.querySelector(".ui-dialog-root--anchored")).toBeNull();
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
  });

  it("saves the clips and the project the save started with, even if both change", async () => {
    let finish!: (value: api.SegmentSaveResult) => void;
    vi.mocked(api.saveSegment).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Intro{Enter}");
    act(() =>
      useDawStore.setState({
        projectPath: "/tmp/other",
        selection: { kind: "clip", id: "b", trackId: MIRA },
      }),
    );
    await act(async () => finish({ status: "added", id: "i", version: 1 }));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.saveSegmentOpen).toBe(false),
    );
    expect(api.saveSegment).toHaveBeenCalledTimes(1);
    expect(api.saveSegment).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/tmp/episode", clip_ids: ["a"] }),
    );
  });

  it("retries a failed save with the first selection and project", async () => {
    vi.mocked(api.saveSegment)
      .mockRejectedValueOnce(new ApiError("x", "segment_busy", 409))
      .mockResolvedValue({ status: "added", id: "i", version: 1 });
    render(<SaveSegmentHost />);
    open();
    await userEvent.type(await nameField(), "Intro{Enter}");
    await screen.findByRole("alert");
    act(() =>
      useDawStore.setState({
        projectPath: "/tmp/other",
        selection: { kind: "clip", id: "b", trackId: MIRA },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveSegment).toHaveBeenCalledTimes(2));
    expect(api.saveSegment).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/tmp/episode", clip_ids: ["a"] }),
    );
  });
});
