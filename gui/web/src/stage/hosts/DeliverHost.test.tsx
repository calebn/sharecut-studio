import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  addChapter: vi.fn(async () => null),
  updateChapter: vi.fn(async () => {}),
  deleteChapter: vi.fn(async () => {}),
  updateSocialClip: vi.fn(async () => {}),
  deleteSocialClip: vi.fn(async () => {}),
  loadPipelineConfig: vi.fn(),
  startExportJob: vi.fn(),
  startBounceJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));

import { JobCancelledError } from "../../api";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import type { HistoryEntryId } from "../../types/project";
import { BounceFlowProvider } from "./bounceFlow";
import { DeliverStage } from "./DeliverStage";
import { ExportFlowProvider } from "./exportFlow";

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

function mount() {
  return render(
    <ExportFlowProvider>
      <BounceFlowProvider>
        <DeliverStage />
      </BounceFlowProvider>
    </ExportFlowProvider>,
  );
}

const CONFIG = {
  config: {
    export: {
      wav: true,
      formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
    },
    master: { integrated_lufs: -16, true_peak_db: -1.5 },
  },
} as unknown as PipelineConfigResponse;

const JOB: PipelineJobSnapshot = {
  id: "x1",
  project_path: PATH,
  from_step: null,
  only_step: null,
  kind: "export",
  status: "running",
  current: 1,
  total: 2,
  message: "Writing deliverables…",
  error: null,
  elapsed_sec: 12,
  steps: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.followJobToOk.mockReset();
  api.loadPipelineConfig.mockResolvedValue(CONFIG);
  api.startExportJob.mockResolvedValue(JOB);
  api.startBounceJob.mockResolvedValue({ ...JOB, id: "b1", kind: "bounce" });
  stubViewportShell("desktop");
  clearRegisteredCommands();
  registerDawCommands();
  useDawStore.getState().hydrate(PATH, projectAt("h1"));
  useDawStore.setState({ stage: "deliver", guestMode: null, playheadSec: 300 });
});

describe("Deliver host write-back", () => {
  it("saves nothing on mount", () => {
    mount();
    for (const fn of [
      api.addChapter,
      api.updateChapter,
      api.deleteChapter,
      api.updateSocialClip,
      api.deleteSocialClip,
    ])
      expect(fn).not.toHaveBeenCalled();
  });

  it("deletes a removed chapter by its time and title", async () => {
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove Middle" }),
    );
    await waitFor(() =>
      expect(api.deleteChapter).toHaveBeenCalledWith(PATH, 120, "Middle"),
    );
    expect(api.addChapter).not.toHaveBeenCalled();
  });

  it("adds a chapter at the playhead", async () => {
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: /Add at playhead/ }),
    );
    await waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());
    expect(api.addChapter.mock.calls[0]?.slice(0, 2)).toEqual([PATH, 300]);
  });

  it("deletes a removed clip", async () => {
    mount();
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
    mount();
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
    mount();
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
    mount();
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
    mount();
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
    mount();
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

describe("Deliver host export", () => {
  const FINISHED: PipelineJobSnapshot = {
    ...JOB,
    status: "ok",
    current: 2,
    result: {
      paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
      master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
    },
  };
  const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };

  function heldFollow() {
    let settle!: {
      ok: (job: PipelineJobSnapshot) => void;
      fail: (e: Error) => void;
    };
    api.followJobToOk.mockImplementation(
      (_id: string, _label: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          settle = { ok: resolve, fail: reject };
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    return () => settle;
  }

  const exportButton = () =>
    screen.getAllByRole("button", { name: /^Export/ })[0];

  it("offers the project's formats and says what the backend sets", async () => {
    mount();
    const group = await screen.findByRole("group", { name: "Formats" });
    expect(
      await within(group).findByRole("button", { name: /^MP3 · 128 kbps/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(group).getByRole("button", { name: /^M4A \(AAC\) · 128 kbps/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(group).getByRole("button", { name: /^FLAC · lossless/ }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(within(group).getByRole("button", { name: "WAV" })).toBeDisabled();
    expect(
      screen.getByText(
        "Mastered to −16.0 LUFS, peaks under −1.5 dBTP. Change the target in the Pipeline tab.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Loudness" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Range" })).toBeNull();
    expect(screen.queryByText(/Saves to/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("holds Export while the settings load", async () => {
    let load!: (res: PipelineConfigResponse) => void;
    api.loadPipelineConfig.mockReturnValue(
      new Promise((resolve) => {
        load = resolve;
      }),
    );
    mount();
    expect(screen.getByText("Loading export settings…")).toBeInTheDocument();
    expect(exportButton()).toHaveAttribute(
      "title",
      "Wait for the settings to load.",
    );
    await act(async () => load(CONFIG));
    expect(exportButton()).toBeEnabled();
  });

  it("explains a settings error and still exports the saved formats", async () => {
    api.loadPipelineConfig.mockRejectedValue(new Error("offline"));
    heldFollow();
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Export settings did not load: offline. Export uses this project's saved formats.",
    );
    await userEvent.click(exportButton());
    await waitFor(() =>
      expect(api.startExportJob).toHaveBeenCalledWith(PATH, null),
    );
  });

  it("exports the chosen formats, shows progress, then what it wrote and measured", async () => {
    const settle = heldFollow();
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: /^FLAC · lossless/ }),
    );
    await userEvent.click(exportButton());

    expect(api.startExportJob).toHaveBeenCalledWith(PATH, [
      MP3,
      { ext: "flac", codec: "flac" },
    ]);
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    await act(async () => settle().ok(FINISHED));
    expect(
      await screen.findByText("Exported 2 files to export/"),
    ).toBeInTheDocument();
    expect(screen.getByText("ep.wav")).toBeInTheDocument();
    expect(screen.getByText("ep.mp3")).toBeInTheDocument();
    expect(
      screen.getByText("Measured −16.1 LUFS, true peak −1.6 dBTP."),
    ).toBeInTheDocument();
    expect(screen.getByText("−16.1 LUFS")).toBeInTheDocument();
    expect(screen.getByText("−1.6 dBTP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Exported 2 files to export/",
    });
  });

  it("keeps the export going when the stage is left, and shows it again on return", async () => {
    const settle = heldFollow();
    const flowed = (show: boolean) => (
      <ExportFlowProvider>
        <BounceFlowProvider>
          {show ? <DeliverStage /> : null}
        </BounceFlowProvider>
      </ExportFlowProvider>
    );
    const view = render(flowed(true));
    await screen.findByRole("button", { name: /^MP3/ });
    await userEvent.click(exportButton());
    await screen.findByText("Exporting");

    view.rerender(flowed(false));
    expect(screen.queryByText("Exporting")).toBeNull();
    view.rerender(flowed(true));
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
    expect(api.startExportJob).toHaveBeenCalledOnce();

    await act(async () => settle().ok(FINISHED));
    expect(
      await screen.findByText("Exported 2 files to export/"),
    ).toBeInTheDocument();
  });

  it("cancels the running job and says nothing was written", async () => {
    const settle = heldFollow();
    api.cancelPipelineRun.mockResolvedValue(JOB);
    mount();
    await screen.findByRole("button", { name: /^MP3/ });
    await userEvent.click(exportButton());
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    expect(api.cancelPipelineRun).toHaveBeenCalledWith("x1");

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...JOB, status: "cancelled" },
          "Export cancelled",
        ),
      ),
    );
    expect(
      await screen.findByText(
        "Export cancelled. Files from an earlier export are unchanged.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export again" }));
    expect(
      await screen.findByRole("button", { name: /^MP3/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Export cancelled")).toBeNull();
  });

  it("names a failure and offers Try again", async () => {
    api.followJobToOk.mockRejectedValue(new Error("ffmpeg exited 1"));
    mount();
    await screen.findByRole("button", { name: /^MP3/ });
    await userEvent.click(exportButton());
    expect(await screen.findByText("ffmpeg exited 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("ffmpeg exited 1")).toBeNull();
  });

  it("starts the export a command asked for, once the formats are in", async () => {
    heldFollow();
    useDawStore.getState().setExportRequested(true);
    mount();
    await waitFor(() =>
      expect(api.startExportJob).toHaveBeenCalledWith(PATH, [MP3]),
    );
    expect(useDawStore.getState().chrome.exportRequested).toBe(false);
    expect(await screen.findByText("Exporting")).toBeInTheDocument();
  });

  it("does not start a second export for a command while one runs", async () => {
    heldFollow();
    mount();
    await screen.findByRole("button", { name: /^MP3/ });
    await userEvent.click(exportButton());
    await screen.findByText("Exporting");
    act(() => useDawStore.getState().setExportRequested(true));
    await waitFor(() =>
      expect(useDawStore.getState().chrome.exportRequested).toBe(false),
    );
    expect(api.startExportJob).toHaveBeenCalledOnce();
  });
});

describe("Deliver host bounce", () => {
  const BOUNCED: PipelineJobSnapshot = {
    ...JOB,
    id: "b1",
    kind: "bounce",
    status: "ok",
    result: { paths: ["/tmp/ep/export/bounces/mix.wav"] },
  };

  function heldFollow() {
    let settle!: {
      ok: (job: PipelineJobSnapshot) => void;
      fail: (e: Error) => void;
    };
    api.followJobToOk.mockImplementation(
      (_id: string, _label: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          settle = { ok: resolve, fail: reject };
          opts?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    return () => settle;
  }

  const bounceButton = () => screen.getByRole("button", { name: "Bounce" });

  beforeEach(() => {
    useDawStore.setState({
      selection: null,
      soloTracks: {},
      sessionRegion: null,
      bounceRangeTarget: null,
      pendingJobResults: {},
    });
  });

  it("sits in the Bounce section with the project's counts, and no longer in the host row", () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "t1", trackIds: ["t1"] },
      soloTracks: { t1: true, t2: true },
    });
    mount();
    expect(screen.getByRole("heading", { name: "Bounce" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Selected tracks (1)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Soloed tracks (2)" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Bounce…" })).toBeNull();
  });

  it("bounces the entire mix, follows the job, then lists what it wrote", async () => {
    const settle = heldFollow();
    mount();
    await userEvent.click(bounceButton());
    expect(api.startBounceJob).toHaveBeenCalledWith(PATH, {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
    expect(await screen.findByText("Bouncing")).toBeInTheDocument();
    expect(bounceButton()).toBeDisabled();

    await act(async () => settle().ok(BOUNCED));
    expect(
      await screen.findByText("Bounced 1 file(s) to export/bounces/"),
    ).toBeInTheDocument();
    expect(screen.getByText("mix.wav")).toBeInTheDocument();
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Bounced 1 file(s) to export/bounces/",
    });
  });

  it("keeps the bounce going when the stage is left, and shows it again on return", async () => {
    const settle = heldFollow();
    const flowed = (show: boolean) => (
      <ExportFlowProvider>
        <BounceFlowProvider>
          {show ? <DeliverStage /> : null}
        </BounceFlowProvider>
      </ExportFlowProvider>
    );
    const view = render(flowed(true));
    await userEvent.click(bounceButton());
    await screen.findByText("Bouncing");

    view.rerender(flowed(false));
    view.rerender(flowed(true));
    expect(await screen.findByText("Bouncing")).toBeInTheDocument();
    expect(api.startBounceJob).toHaveBeenCalledOnce();

    await act(async () => settle().ok(BOUNCED));
    expect(
      await screen.findByText("Bounced 1 file(s) to export/bounces/"),
    ).toBeInTheDocument();
  });

  it("cancels the running job and says nothing was written", async () => {
    const settle = heldFollow();
    api.cancelPipelineRun.mockResolvedValue(JOB);
    mount();
    await userEvent.click(bounceButton());
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toBeEnabled());
    await userEvent.click(cancel);
    expect(api.cancelPipelineRun).toHaveBeenCalledWith("b1");

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...JOB, status: "cancelled" },
          "Bounce cancelled",
        ),
      ),
    );
    expect(
      await screen.findByText(
        "Bounce cancelled. Files from an earlier bounce are unchanged.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Bounce again" }));
    expect(screen.queryByText("Bounce cancelled")).toBeNull();
  });

  it("names a failure and offers Try again", async () => {
    api.followJobToOk.mockRejectedValue(new Error("ffmpeg exited 1"));
    mount();
    await userEvent.click(bounceButton());
    expect(await screen.findByText("ffmpeg exited 1")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByText("ffmpeg exited 1")).toBeNull();
  });

  it("explains why Bounce waits for tracks, and sends the soloed ones", async () => {
    heldFollow();
    mount();
    await userEvent.click(
      screen.getByRole("button", { name: "Soloed tracks (0)" }),
    );
    expect(bounceButton()).toBeDisabled();
    expect(
      screen.getByText("Solo one or more tracks first."),
    ).toBeInTheDocument();
    act(() => useDawStore.setState({ soloTracks: { t1: true } }));
    await userEvent.click(bounceButton());
    expect(api.startBounceJob).toHaveBeenCalledWith(
      PATH,
      expect.objectContaining({ track_ids: ["t1"] }),
    );
  });

  it("fixes the bounce to a range from Edit, and lets it go", async () => {
    useDawStore.setState({
      bounceRangeTarget: {
        kind: "exact_range",
        intervals: [{ start: 1, end: 2.5 }],
        track_ids: ["t1"],
        clips: [],
      } as never,
    });
    mount();
    expect(
      screen.getByText(
        "Selected range · 1.00–2.50 s on t1. This selection is fixed for this bounce.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Bounce the whole mix instead" }),
    );
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
    expect(screen.getByRole("group", { name: "Source" })).toBeInTheDocument();
  });

  it("moves focus to Bounce for a command, then clears the request", async () => {
    useDawStore.getState().setBounceRequested(true);
    mount();
    await waitFor(() => expect(bounceButton()).toHaveFocus());
    expect(useDawStore.getState().chrome.bounceRequested).toBe(false);
  });
});
