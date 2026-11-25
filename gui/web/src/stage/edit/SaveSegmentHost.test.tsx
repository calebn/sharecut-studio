import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
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
});
