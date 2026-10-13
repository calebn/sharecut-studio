import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  startSplitSpeakersJob,
} from "../api";
import { executePointerCommand } from "../commands/pointer";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { HistoryEntryId } from "../types/project";
import { SplitSpeakersDialog } from "./SplitSpeakersDialog";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  startSplitSpeakersJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));
vi.mock("../commands/pointer", () => ({ executePointerCommand: vi.fn() }));
vi.mock("../document/applyDocumentUpdate", () => ({
  refreshDocumentProject: vi.fn(),
}));

const PATH = "/tmp/ep/episode.project.json";
const HEAD = "h2" as HistoryEntryId;

const started: PipelineJobSnapshot = {
  id: "s1",
  project_path: PATH,
  from_step: null,
  only_step: null,
  kind: "split_speakers",
  status: "running",
  current: 10,
  total: 40,
  message: "Embedding 38 windows",
  error: null,
  elapsed_sec: 20,
  steps: [],
};

const splitResult = {
  split_id: "split_1",
  lanes: [
    { track_id: "room", name: "Ana", muted_sec: 20 },
    { track_id: "room_ben", name: "Ben", muted_sec: 40 },
  ],
  crosstalk_sec: 6,
  low_confidence_sec: 0,
  history_head_id: HEAD,
};

const finished: PipelineJobSnapshot = {
  ...started,
  status: "ok",
  result: splitResult,
};

function heldFollow() {
  let settle!: {
    ok: (job: PipelineJobSnapshot) => void;
    fail: (e: Error) => void;
  };
  vi.mocked(followJobToOk).mockImplementation(
    (_id, _label, opts) =>
      new Promise((resolve, reject) => {
        settle = { ok: resolve, fail: reject };
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  return () => settle;
}

function openFor(trackId: string) {
  act(() => useDawStore.getState().setSplitSpeakersTrackId(trackId));
}

/** The dialog moves focus to the count on the next frame; typing before then would be lost. */
async function openWithFocusSettled() {
  openFor("room");
  const count = await screen.findByRole("spinbutton", {
    name: "Number of speakers",
  });
  await waitFor(() => expect(count).toHaveFocus());
  return count;
}

async function splitTwo(user: ReturnType<typeof userEvent.setup>) {
  openFor("room");
  await user.click(
    await screen.findByRole("button", { name: "Split speakers" }),
  );
}

describe("SplitSpeakersDialog", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject({
        tracks: [sampleTrack({ id: "room", label: "Room", duration_sec: 60 })],
      }),
      splitSpeakersTrackId: null,
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
      spokenJobResultIds: [],
      feedbackToast: null,
    });
    vi.mocked(startSplitSpeakersJob).mockReset().mockResolvedValue(started);
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
    vi.mocked(executePointerCommand).mockReset();
    vi.mocked(refreshDocumentProject)
      .mockReset()
      .mockResolvedValue(minimalProject());
  });

  it("asks for the speaker count and names before anything starts", async () => {
    const { baseElement } = render(<SplitSpeakersDialog />);
    openFor("room");

    const dialog = await screen.findByRole("dialog", {
      name: "Split speakers",
    });
    expect(dialog.textContent).toContain(
      "Splits Room into one track per speaker",
    );
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Number of speakers",
        }) as HTMLInputElement
      ).value,
    ).toBe("2");
    expect(screen.getByRole("textbox", { name: "Speaker 1" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Speaker 2" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Speaker 3" })).toBeNull();
    expect(startSplitSpeakersJob).not.toHaveBeenCalled();
    await expectNoA11yViolations(baseElement);
  });

  it("grows the name fields with the count and refuses a count out of range", async () => {
    const user = userEvent.setup();
    render(<SplitSpeakersDialog />);
    const count = await openWithFocusSettled();
    await user.clear(count);
    await user.type(count, "4");
    expect(screen.getByRole("textbox", { name: "Speaker 4" })).toBeTruthy();

    await user.clear(count);
    await user.type(count, "9");
    const button = screen.getByRole("button", { name: "Split speakers" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "Enter 2 to 8 speakers.",
    );
    expect(count.getAttribute("aria-invalid")).toBe("true");
    expect(screen.queryByRole("textbox", { name: "Speaker 1" })).toBeNull();
  });

  it("splits with the typed count and names, then shows the tracks and announces with Undo", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    const { baseElement } = render(<SplitSpeakersDialog />);
    await openWithFocusSettled();
    await user.type(screen.getByRole("textbox", { name: "Speaker 1" }), "Ana");
    await user.type(screen.getByRole("textbox", { name: "Speaker 2" }), "Ben");
    await user.click(screen.getByRole("button", { name: "Split speakers" }));

    expect(startSplitSpeakersJob).toHaveBeenCalledWith(PATH, {
      trackId: "room",
      speakerCount: 2,
      names: ["Ana", "Ben"],
    });
    expect(await screen.findByText("Finding who is talking…")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Split progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("25");
    expect(useDawStore.getState().activityJob?.id).toBe("s1");

    await act(async () => settle().ok(finished));
    expect(await screen.findByText("Split Room into 2 tracks.")).toBeTruthy();
    expect(refreshDocumentProject).toHaveBeenCalledWith(PATH);
    expect(screen.getByText("Plays 0:40 of 1:00")).toBeTruthy();
    expect(screen.getByText("Plays 0:20 of 1:00")).toBeTruthy();
    expect(
      screen.getByText(/6 s where people talk over each other/),
    ).toBeTruthy();
    expect(useDawStore.getState().feedbackToast).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Split Room into 2 tracks: Ana and Ben.",
    );
    act(() =>
      useDawStore.setState({
        project: minimalProject({
          tracks: [sampleTrack({ id: "room" })],
          history: {
            cursor: 2,
            head_id: HEAD,
            can_undo: true,
            can_redo: false,
            groups: [],
          },
        }),
      }),
    );
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Split Room into 2 tracks: Ana and Ben.",
      undo: HEAD,
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    expect(useDawStore.getState().spokenJobResultIds).toContain("s1");
    await expectNoA11yViolations(baseElement);
  });

  it("names the track as it was called before the split renamed it to the first speaker", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    vi.mocked(refreshDocumentProject).mockImplementation(async () => {
      const renamed = minimalProject({
        tracks: [sampleTrack({ id: "room", label: "Ana" })],
      });
      useDawStore.setState({ project: renamed });
      return renamed;
    });
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await act(async () => settle().ok(finished));

    expect(await screen.findByText("Split Room into 2 tracks.")).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Split Room into 2 tracks: Ana and Ben.",
    );
  });

  it("undoes the split from the result and returns to the settings", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    vi.mocked(executePointerCommand).mockResolvedValue({ status: "ok" });
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await act(async () => settle().ok(finished));
    act(() =>
      useDawStore.setState({
        project: minimalProject({
          tracks: [sampleTrack({ id: "room", label: "Room" })],
          history: {
            cursor: 2,
            head_id: HEAD,
            can_undo: true,
            can_redo: false,
            groups: [],
          },
        }),
      }),
    );

    await user.click(await screen.findByRole("button", { name: "Undo split" }));
    expect(executePointerCommand).toHaveBeenCalledWith("history.undo", {
      expectedHeadId: HEAD,
    });
    expect(
      await screen.findByRole("button", { name: "Split speakers" }),
    ).toBeTruthy();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Undone: speaker split",
    );
  });

  it("offers no Undo once something else is the latest change", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await act(async () => settle().ok(finished));

    expect(
      await screen.findByText(/Something else changed since the split/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo split" })).toBeNull();
  });

  it("cancels the running job and says nothing changed", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await user.click(
      await screen.findByRole("button", { name: "Cancel split" }),
    );
    expect(cancelPipelineRun).toHaveBeenCalledWith("s1");

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...started, status: "cancelled" },
          "Split speakers cancelled",
        ),
      ),
    );
    expect(
      await screen.findByText("Split cancelled. Room is unchanged."),
    ).toBeTruthy();
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    await user.click(screen.getByRole("button", { name: "Split again" }));
    expect(
      await screen.findByRole("button", { name: "Split speakers" }),
    ).toBeTruthy();
  });

  it("treats a cancel that arrived after the split landed as a finished split", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await user.click(
      await screen.findByRole("button", { name: "Cancel split" }),
    );

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...finished, status: "cancelled" },
          "Split speakers cancelled",
        ),
      ),
    );
    expect(await screen.findByText("Split Room into 2 tracks.")).toBeTruthy();
    expect(refreshDocumentProject).toHaveBeenCalled();
  });

  it("names a refusal from the server and offers Try again", async () => {
    const user = userEvent.setup();
    vi.mocked(startSplitSpeakersJob).mockRejectedValue(
      new Error(
        "speaker split needs a speaker embedding: install the [speaker] extra",
      ),
    );
    render(<SplitSpeakersDialog />);
    await splitTwo(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Split failed: speaker split needs a speaker embedding: install the [speaker] extra",
    );
    expect(useDawStore.getState().activityJob).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("button", { name: "Split speakers" }),
    ).toBeTruthy();
  });

  it("names a failure mid-job and lets the chip speak it", async () => {
    const user = userEvent.setup();
    vi.mocked(followJobToOk).mockRejectedValue(new Error("out of memory"));
    render(<SplitSpeakersDialog />);
    await splitTwo(user);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Split failed: out of memory",
    );
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });

  it("keeps splitting when the dialog closes, and shows it again on reopen", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await screen.findByRole("button", { name: "Cancel split" });

    act(() => useDawStore.getState().setSplitSpeakersTrackId(null));
    expect(screen.queryByRole("dialog")).toBeNull();
    openFor("room");
    expect(
      await screen.findByRole("button", { name: "Cancel split" }),
    ).toBeTruthy();
    expect(startSplitSpeakersJob).toHaveBeenCalledTimes(1);
    act(() => useDawStore.getState().setSplitSpeakersTrackId(null));

    await act(async () => settle().ok(finished));
    expect(useDawStore.getState().feedbackToast?.undo).toBe(HEAD);
  });

  it("returns to the settings when the project changes mid-split", async () => {
    const user = userEvent.setup();
    heldFollow();
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await screen.findByRole("button", { name: "Cancel split" });

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() =>
      expect(useDawStore.getState().pendingJobResults).toEqual({}),
    );
    act(() => useDawStore.setState({ projectPath: PATH }));
    expect(
      await screen.findByRole("button", { name: "Split speakers" }),
    ).toBeTruthy();
  });
});
