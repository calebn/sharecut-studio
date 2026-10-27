import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  addChapter: vi.fn(async () => null),
  updateChapter: vi.fn(async () => {}),
  deleteChapter: vi.fn(async () => {}),
  updateSocialClip: vi.fn(async () => {}),
  deleteSocialClip: vi.fn(async () => {}),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type { HistoryEntryId } from "../../types/project";
import { DeliverStage } from "./DeliverStage";

const PATH = "/tmp/deliver-host/episode.project.json";

const CLIP = {
  id: "s1",
  track_id: "t1",
  start: 10,
  end: 40,
  score: 0.9,
  title_suggestion: "A line",
  approved: false,
  review_required: false,
};

function projectAt(
  head: string,
  over: {
    chapters?: { time: number; title: string }[];
    social_clips?: (typeof CLIP)[];
  } = {},
) {
  const base = minimalProject();
  return minimalProject({
    tracks: [sampleTrack()],
    timeline_duration_sec: 600,
    chapters: over.chapters ?? [
      { time: 0, title: "Intro" },
      { time: 120, title: "Middle" },
    ],
    social_clips: over.social_clips ?? [CLIP],
    history: { ...base.history, head_id: head as HistoryEntryId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(PATH, projectAt("h1"));
  useDawStore.setState({ stage: "deliver", guestMode: null, playheadSec: 300 });
});

describe("Deliver host write-back", () => {
  it("saves nothing on mount", () => {
    render(<DeliverStage />);
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });

  it("deletes a removed chapter by its time and title", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    await waitFor(() =>
      expect(api.deleteChapter).toHaveBeenCalledWith(PATH, 120, "Middle"),
    );
    expect(api.addChapter).not.toHaveBeenCalled();
  });

  it("adds a chapter at the playhead", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: /Add at playhead/ }),
    );
    await waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());
    expect(api.addChapter.mock.calls[0]?.slice(0, 2)).toEqual([PATH, 300]);
  });

  it("deletes a removed clip", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(api.deleteSocialClip).toHaveBeenCalledWith(PATH, "s1"),
    );
  });

  it("says so when a save fails", async () => {
    api.deleteChapter.mockRejectedValueOnce(new Error("offline"));
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save your changes: offline",
    );
  });
});

describe("Deliver host re-seed", () => {
  const setProject = (project: ReturnType<typeof projectAt>) =>
    act(() => useDawStore.getState().setProject(project));

  it("shows the chapters Undo brings back, with their exact titles", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    await waitFor(() => expect(api.deleteChapter).toHaveBeenCalledOnce());
    // The save lands, then the user undoes it elsewhere.
    setProject(projectAt("h2", { chapters: [{ time: 0, title: "Intro" }] }));
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    setProject(projectAt("h3"));
    expect(
      await screen.findByRole("button", { name: "Remove Middle" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove Intro" }),
    ).toBeInTheDocument();
    expect(api.addChapter).not.toHaveBeenCalled();
  });

  it("shows the clip Undo brings back", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "More for A line" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(api.deleteSocialClip).toHaveBeenCalledWith(PATH, "s1"),
    );
    setProject(projectAt("h2", { social_clips: [] }));
    expect(screen.queryByDisplayValue("A line")).toBeNull();
    setProject(projectAt("h3"));
    expect(await screen.findByDisplayValue("A line")).toBeInTheDocument();
    expect(api.deleteSocialClip).toHaveBeenCalledOnce();
  });

  it("keeps the page when the project only catches up with a save", async () => {
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    await waitFor(() => expect(api.deleteChapter).toHaveBeenCalledOnce());
    setProject(projectAt("h2", { chapters: [{ time: 0, title: "Intro" }] }));
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
  });

  it("keeps an unsaved edit when a revision arrives during the save", async () => {
    let finish: () => void = () => {};
    api.deleteChapter.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    render(<DeliverStage />);
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    await waitFor(() => expect(api.deleteChapter).toHaveBeenCalledOnce());
    // Someone else's revision lands while our delete is in flight.
    setProject(projectAt("h2"));
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    // The save settles and the project catches up.
    setProject(projectAt("h3", { chapters: [{ time: 0, title: "Intro" }] }));
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Remove Middle" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove Intro" }),
    ).toBeInTheDocument();
    expect(api.deleteChapter).toHaveBeenCalledOnce();
  });
});
