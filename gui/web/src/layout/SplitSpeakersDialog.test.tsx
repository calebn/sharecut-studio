import {
  act,
  render as baseRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  getSpeakerDoctor,
  JobCancelledError,
  startSplitSpeakersJob,
} from "../api";
import { clearRegisteredCommands } from "../commands/execute";
import { executePointerCommand, runPointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { registerSpeakerSplitCommands } from "../commands/speakerSplit";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { TrackInspector } from "../inspector/views/TrackInspector";
import { useDawStore } from "../state/dawStore";
import { expectNoA11yViolations } from "../test/a11y";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../test/renderWithModels";
import type { PipelineJobSnapshot } from "../types/pipeline";
import type { HistoryEntryId } from "../types/project";
import { SplitSpeakersDialog } from "./SplitSpeakersDialog";

const downloadModel = vi.fn();

function render(ui: ReactElement) {
  return renderWithModels(ui, {
    status: modelStatus(registryRows()),
    download: downloadModel,
  });
}

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  startSplitSpeakersJob: vi.fn(),
  getSpeakerDoctor: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));
vi.mock("../commands/pointer", () => ({
  executePointerCommand: vi.fn(),
  runPointerCommand: vi.fn(),
}));
vi.mock("../commands/seek", () => ({ seekTransport: vi.fn() }));
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
  review_spans: [
    {
      start_s: 1,
      end_s: 3,
      speakers: ["room_ben"],
      unsure: true,
      overlapping: false,
      timeline_spans: [
        { start_s: 9, end_s: 10 },
        { start_s: 12, end_s: 13 },
      ],
    },
    {
      start_s: 5,
      end_s: 7,
      speakers: ["room_ben"],
      unsure: false,
      overlapping: true,
      timeline_spans: [],
    },
  ],
  history_head_id: HEAD,
};

const finished: PipelineJobSnapshot = {
  ...started,
  status: "ok",
  result: splitResult,
};

function splitProject() {
  return minimalProject({
    tracks: [
      sampleTrack({ id: "room", speaker_split_id: "split_1" }),
      sampleTrack({ id: "room_ben", speaker_split_id: "split_1" }),
    ],
    clips: {
      tracks: {
        room_ben: [
          {
            id: "ben_clip",
            track_id: "room_ben",
            source_start: 0,
            source_end: 10,
            timeline_start: 8,
            timeline_end: 18,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
            source_duration_sec: 10,
            recording_key: null,
          },
        ],
      },
      clip_count: 1,
    },
    history: {
      cursor: 2,
      head_id: HEAD,
      can_undo: true,
      can_redo: false,
      groups: [],
    },
  });
}

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
  const button = await screen.findByRole("button", { name: "Split speakers" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

describe("SplitSpeakersDialog", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject({
        tracks: [sampleTrack({ id: "room", label: "Room", duration_sec: 60 })],
      }),
      splitSpeakersTrackId: null,
      splitSpeakersReview: null,
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
      spokenJobResultIds: [],
      feedbackToast: null,
    });
    clearRegisteredCommands();
    registerSpeakerSplitCommands();
    vi.mocked(startSplitSpeakersJob).mockReset().mockResolvedValue(started);
    vi.mocked(getSpeakerDoctor)
      .mockReset()
      .mockResolvedValue({
        available_backends: ["speechbrain-ecapa"],
        recommended: "speechbrain-ecapa",
      });
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
    vi.mocked(runPointerCommand).mockReset();
    vi.mocked(executePointerCommand).mockReset();
    vi.mocked(seekTransport).mockReset();
    vi.mocked(refreshDocumentProject)
      .mockReset()
      .mockImplementation(async () => {
        const next = splitProject();
        useDawStore.setState({ project: next });
        return next;
      });
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

  it("blocks splitting and links to setup when speaker recognition is unavailable", async () => {
    vi.mocked(getSpeakerDoctor).mockResolvedValue({
      available_backends: ["mock"],
      recommended: "mock",
    });
    render(<SplitSpeakersDialog />);
    openFor("room");

    expect(
      await screen.findByText(
        "Speaker recognition isn't available on this computer.",
      ),
    ).toBeTruthy();
    const setup = screen.getByRole("link", {
      name: "Read the speaker setup instructions",
    });
    expect(setup.getAttribute("href")).toBe(
      "https://github.com/calebn/sharecut-studio/blob/main/docs/setup.md#optional-downloads-and-extras",
    );
    expect(
      screen.getByRole("button", { name: "Split speakers" }),
    ).toBeDisabled();
    expect(getSpeakerDoctor).toHaveBeenCalledTimes(1);
    expect(startSplitSpeakersJob).not.toHaveBeenCalled();
  });

  it("downloads the speaker model from the dialog and then allows the split", async () => {
    const user = userEvent.setup();
    vi.mocked(getSpeakerDoctor)
      .mockReset()
      .mockResolvedValueOnce({ available_backends: [], recommended: null })
      .mockResolvedValue({
        available_backends: ["ecapa-onnx"],
        recommended: "ecapa-onnx",
      });
    downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
    render(<SplitSpeakersDialog />);
    openFor("room");

    await user.click(
      await screen.findByRole("button", { name: "Download speaker model" }),
    );
    expect(downloadModel).toHaveBeenCalledWith(["speaker-ecapa"], undefined);
    await waitFor(() => expect(getSpeakerDoctor).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Download speaker model" }),
      ).toBeNull(),
    );
    expect(
      screen.queryByText(
        "Speaker recognition isn't available on this computer.",
      ),
    ).toBeNull();
  });

  it("does not recheck speaker recognition when the download failed", async () => {
    const user = userEvent.setup();
    vi.mocked(getSpeakerDoctor)
      .mockReset()
      .mockResolvedValue({ available_backends: [], recommended: null });
    downloadModel
      .mockReset()
      .mockResolvedValue({ kind: "failed", failed: ["speaker-ecapa"] });
    render(<SplitSpeakersDialog />);
    openFor("room");

    await user.click(
      await screen.findByRole("button", { name: "Download speaker model" }),
    );
    await waitFor(() => expect(downloadModel).toHaveBeenCalled());
    expect(
      screen.getByRole("button", { name: "Split speakers" }),
    ).toBeDisabled();
    expect(getSpeakerDoctor).toHaveBeenCalledTimes(1);
  });

  it("shows the plain reason the speaker model download failed", async () => {
    vi.mocked(getSpeakerDoctor)
      .mockReset()
      .mockResolvedValue({ available_backends: [], recommended: null });
    renderWithModels(<SplitSpeakersDialog />, {
      status: modelStatus(registryRows()),
      failures: {
        "speaker-ecapa": {
          kind: "http",
          plain: "The download server doesn't have the speaker model.",
        },
      },
    });
    openFor("room");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The download server doesn't have the speaker model.",
    );
    expect(
      screen.getByRole("button", { name: "Download speaker model" }),
    ).toBeEnabled();
  });

  it("shows the live byte bar while the speaker model downloads", async () => {
    vi.mocked(getSpeakerDoctor)
      .mockReset()
      .mockResolvedValue({ available_backends: [], recommended: null });
    renderWithModels(<SplitSpeakersDialog />, {
      status: modelStatus(registryRows()),
      job: {
        id: "j",
        kind: "bootstrap",
        components: ["speaker-ecapa"],
        whisper_model: "large-v3-turbo",
        status: "running",
        download: {
          component: "speaker-ecapa",
          bytes: 40_000_000,
          total: 80_000_000,
        },
      },
    });
    openFor("room");

    expect(
      await screen.findByRole("progressbar", { name: "Speaker model" }),
    ).toHaveAttribute("aria-valuetext", "40 MB of 80 MB");
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
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
      enrollment: null,
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
    expect(screen.getAllByText("Unsure stretch")).toHaveLength(2);
    expect(screen.getByText("Timeline 0:09 · 0:01")).toBeTruthy();
    expect(screen.getByText("Timeline 0:12 · 0:01")).toBeTruthy();
    expect(screen.getByText("Recording 0:05 · 0:02")).toBeTruthy();
    expect(screen.getAllByText("Ben")).toHaveLength(4);
    const goToButtons = screen.getAllByRole("button", { name: "Go to" });
    expect(goToButtons).toHaveLength(3);
    expect(goToButtons[2]).toBeDisabled();
    await user.click(goToButtons[0]!);
    await user.click(goToButtons[1]!);
    expect(seekTransport).toHaveBeenNthCalledWith(1, 9);
    expect(seekTransport).toHaveBeenNthCalledWith(2, 12);
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
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Split Room into 2 tracks: Ana and Ben.",
      undo: HEAD,
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    expect(useDawStore.getState().spokenJobResultIds).toContain("s1");
    await expectNoA11yViolations(baseElement);
  });

  it("seeds the split with a voice sample taken from the selected range", async () => {
    const user = userEvent.setup();
    const roomClip = {
      id: "room_clip",
      track_id: "room",
      source_start: 4,
      source_end: 64,
      timeline_start: 10,
      timeline_end: 70,
      fade_in_ms: 0,
      fade_out_ms: 0,
      join_in_mode: "fade" as const,
      source_id: null,
      source_duration_sec: 60,
      recording_key: null,
    };
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack({ id: "room", label: "Room", duration_sec: 60 })],
        clips: { tracks: { room: [roomClip] }, clip_count: 1 },
      }),
    });
    const { baseElement } = render(<SplitSpeakersDialog />);
    await openWithFocusSettled();
    const mark = screen.getByRole("button", {
      name: "Use selection as Speaker 1's voice",
    });
    expect(mark).toBeDisabled();
    act(() =>
      useDawStore.getState().setSelection({
        kind: "range",
        target: {
          kind: "exact_range",
          intervals: [{ start: 12, end: 18 }],
          track_ids: ["room"],
          clips: [],
          media_seals: {},
        },
      }),
    );
    await waitFor(() => expect(mark).toBeEnabled());
    await user.click(mark);
    expect(screen.getByText("Voice sample 0:12 · 0:06")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Listen to Speaker 1's voice sample",
      }),
    ).toBeTruthy();
    await expectNoA11yViolations(baseElement);
    await user.click(screen.getByRole("button", { name: "Split speakers" }));
    expect(startSplitSpeakersJob).toHaveBeenCalledWith(PATH, {
      trackId: "room",
      speakerCount: 2,
      names: ["Speaker 1", "Speaker 2"],
      enrollment: { "Speaker 1": [[6, 12]] },
    });
  });

  it("clears a voice sample", async () => {
    const user = userEvent.setup();
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack({ id: "room", label: "Room", duration_sec: 60 })],
        clips: {
          tracks: {
            room: [
              {
                id: "c",
                track_id: "room",
                source_start: 0,
                source_end: 60,
                timeline_start: 0,
                timeline_end: 60,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade" as const,
                source_id: null,
                source_duration_sec: 60,
                recording_key: null,
              },
            ],
          },
          clip_count: 1,
        },
      }),
      selection: {
        kind: "range",
        target: {
          kind: "exact_range",
          intervals: [{ start: 2, end: 5 }],
          track_ids: ["room"],
          clips: [],
          media_seals: {},
        },
      },
    });
    render(<SplitSpeakersDialog />);
    await openWithFocusSettled();
    await user.click(
      screen.getByRole("button", {
        name: "Use selection as Speaker 2's voice",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Clear Speaker 2's voice sample" }),
    );
    await user.click(screen.getByRole("button", { name: "Split speakers" }));
    expect(startSplitSpeakersJob).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ names: null, enrollment: null }),
    );
  });

  it("names the track as it was called before the split renamed it to the first speaker", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    vi.mocked(refreshDocumentProject).mockImplementation(async () => {
      const renamed = splitProject();
      renamed.tracks[0]!.label = "Ana";
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
    act(() => useDawStore.setState({ project: splitProject() }));

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
    const newer = splitProject();
    newer.history = {
      cursor: 3,
      head_id: "h3" as HistoryEntryId,
      can_undo: true,
      can_redo: false,
      groups: [],
    };
    act(() => useDawStore.setState({ project: newer }));

    expect(
      await screen.findByRole("button", { name: "Split speakers" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo split" })).toBeNull();
    expect(screen.queryByText("Review these stretches")).toBeNull();
  });

  it("keeps the review list available after closing to listen and reopening", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    render(
      <>
        <TrackInspector
          track={sampleTrack({
            id: "room",
            label: "Room",
            media_path: "raw/room.wav",
            speaker_split_id: "split_1",
          })}
          effects={[]}
        />
        <SplitSpeakersDialog />
      </>,
    );
    await splitTwo(user);
    await act(async () => settle().ok(finished));

    await user.click(screen.getAllByRole("button", { name: "Go to" })[0]!);
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(useDawStore.getState().splitSpeakersReview).toEqual({
      trackId: "room",
      splitId: "split_1",
      historyHeadId: HEAD,
    });
    const historyHead = useDawStore.getState().project?.history?.head_id;
    await user.click(screen.getByRole("button", { name: "Solo room" }));
    expect(runPointerCommand).toHaveBeenCalledWith("track.soloToggle", {
      trackId: "room",
    });
    expect(useDawStore.getState().project?.history?.head_id).toBe(historyHead);
    await user.click(screen.getByRole("button", { name: "Review split…" }));
    expect(await screen.findByText("Review these stretches")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Go to" })[1]!);
    expect(seekTransport).toHaveBeenNthCalledWith(2, 12);
  });

  it("drops result spans if the project changes while the job finishes", async () => {
    const user = userEvent.setup();
    const settle = heldFollow();
    vi.mocked(refreshDocumentProject).mockImplementation(async () => {
      const newer = splitProject();
      newer.history = {
        ...newer.history!,
        head_id: "newer-head" as HistoryEntryId,
      };
      useDawStore.setState({ project: newer });
      return newer;
    });
    render(<SplitSpeakersDialog />);
    await splitTwo(user);
    await act(async () => settle().ok(finished));

    expect(screen.queryByText("Review these stretches")).toBeNull();
    expect(screen.getByRole("button", { name: "Split speakers" })).toBeTruthy();
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

describe("SplitSpeakersDialog without a models provider (share-review guests)", () => {
  it("renders without throwing (the hook runs before the open check)", () => {
    useDawStore.setState({ splitSpeakersTrackId: null });
    const { container } = baseRender(<SplitSpeakersDialog />);
    expect(container).toBeTruthy();
  });
});
