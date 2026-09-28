import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addChapter } from "../api";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { OverlayLegend } from "./OverlayLegend";

vi.mock("../api", () => ({
  addChapter: vi.fn().mockResolvedValue(undefined),
}));

const addChapterMock = vi.mocked(addChapter);

describe("OverlayLegend", () => {
  beforeEach(() => {
    addChapterMock.mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      statusAnnouncement: "",
      selection: null,
      chapterAddPending: false,
    });
  });

  it("adds a chapter at the playhead time current when clicked, not when rendered", async () => {
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    act(() => {
      useDawStore.setState({ playheadSec: 12 });
    });
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    expect(addChapterMock).toHaveBeenCalledWith(
      "/tmp/p.json",
      12,
      "Chapter 12.0s",
    );
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Chapter added at 12.0s",
      ),
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Chapter 12.0s",
      time: 12,
    });
  });

  it("marks + Chapter aria-disabled and ignores repeat clicks while an add is in flight", async () => {
    let resolveAdd: () => void = () => {};
    addChapterMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    const button = screen.getByRole("button", { name: "+ Chapter" });
    act(() => {
      useDawStore.setState({ playheadSec: 0 });
    });
    await userEvent.click(button);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Adding chapter at 0.0s…",
    );
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("aria-busy");
    await userEvent.click(button);
    expect(addChapterMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAdd();
    });
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(addChapterMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the in-flight guard across a remount (View menu close/reopen)", async () => {
    let resolveAdd: () => void = () => {};
    addChapterMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    const legend = () => (
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <div role="menu" aria-label="View menu">
          <OverlayLegend menu />
        </div>
      </DawProvider>
    );
    const first = render(legend());
    await userEvent.click(screen.getByRole("menuitem", { name: "+ Chapter" }));
    first.unmount();
    render(legend());
    const reopened = screen.getByRole("menuitem", { name: "+ Chapter" });
    expect(reopened).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(reopened);
    expect(addChapterMock).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().chapterAddPending).toBe(true);
    await act(async () => {
      resolveAdd();
    });
    expect(useDawStore.getState().chapterAddPending).toBe(false);
    expect(reopened).not.toHaveAttribute("aria-disabled");
  });

  it("keeps keyboard focus on + Chapter while the add is in flight", async () => {
    let resolveAdd: () => void = () => {};
    addChapterMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    const button = screen.getByRole("button", { name: "+ Chapter" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(addChapterMock).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("{Enter}");
    expect(addChapterMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveAdd();
    });
    expect(document.activeElement).toBe(button);
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("drops a settled add after a project switch and leaves the new project's flag alone", async () => {
    let resolveAdd: () => void = () => {};
    addChapterMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveAdd = resolve;
        }),
    );
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    act(() => {
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    });
    expect(useDawStore.getState().chapterAddPending).toBe(false);
    act(() => {
      useDawStore.setState({ chapterAddPending: true, statusAnnouncement: "" });
    });
    await act(async () => {
      resolveAdd();
    });
    expect(useDawStore.getState().chapterAddPending).toBe(true);
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe("");
  });

  it("drops a rejected add after a project switch and leaves the new project's flag alone", async () => {
    let rejectAdd: (err: unknown) => void = () => {};
    addChapterMock.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    act(() => {
      useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    });
    act(() => {
      useDawStore.setState({ chapterAddPending: true, statusAnnouncement: "" });
    });
    await act(async () => {
      rejectAdd(new Error("boom"));
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    expect(useDawStore.getState().chapterAddPending).toBe(true);
  });

  it("announces a failed add and does not select a chapter", async () => {
    addChapterMock.mockRejectedValueOnce(new Error("boom"));
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <OverlayLegend />
      </DawProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Add chapter failed: boom",
      ),
    );
    expect(useDawStore.getState().selection).toBeNull();
    // The guard is released after a failure, so a retry goes through.
    await userEvent.click(screen.getByRole("button", { name: "+ Chapter" }));
    expect(addChapterMock).toHaveBeenCalledTimes(2);
  });
});
