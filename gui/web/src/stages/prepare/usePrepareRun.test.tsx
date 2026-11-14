import {
  act,
  fireEvent,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  loadPipelineConfig,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import {
  type PipelineWorkingSet,
  usePipelineWorkingSet,
} from "../../hooks/usePipelineWorkingSet";
import { ModelNeedRow } from "../../models/ModelNeedRow";
import type { DownloadOutcome } from "../../models/types";
import { ModelsContext } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { jobMediaKey, mediaKeyOf } from "../../state/jobMedia";
import {
  minimalProject,
  pipelineJobSnapshot,
  sampleTrack,
} from "../../test/fixtures";
import { pipelineConfig } from "../../test/pipelineConfigFixture";
import {
  modelRow,
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import { ApiError } from "../../utils/apiError";
import { takeOpenStage, writeOpenIntent } from "../../utils/openIntent";
import { runOptions, usePrepareRun } from "./usePrepareRun";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
  loadPipelineConfig: vi.fn(),
  startPipelineRun: vi.fn(),
  loadTranscriptVocabulary: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));

const start = vi.mocked(startPipelineRun);
const vocabulary = vi.mocked(loadTranscriptVocabulary);
const cancel = vi.mocked(cancelPipelineRun);

const WHISPER_NEEDED = new ApiError("model needed", "model_needed", 409, {
  id: "whisper",
  variant: "large-v3-turbo",
  label: "Whisper",
  purpose: "transcription",
  size: "~1.6 GB",
  sizeBytes: 1_600_000_000,
  state: "missing",
});

function workingSet(cfg = pipelineConfig()): PipelineWorkingSet {
  return {
    cfg,
    loadError: null,
    saveError: null,
    saving: false,
    reload: vi.fn(),
    update: vi.fn(async () => true),
    fetchFresh: vi.fn(async () => cfg),
  };
}

function modelsFor(whisper: "missing" | "installed") {
  const rows = registryRows().map((row) =>
    row.id === "whisper" ? modelRow({ ...row, state: whisper }) : row,
  );
  return modelsApi({ status: modelStatus(rows) });
}

type Props = {
  ingestBusy: boolean;
  mediaKey: string;
  canRun?: boolean;
  projectPath?: string;
};

function setup(models = modelsFor("missing"), cfg = pipelineConfig()) {
  const api = models;
  const modelContext = { current: models };
  const ws = workingSet(cfg);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ModelsContext.Provider value={modelContext.current}>
      {children}
    </ModelsContext.Provider>
  );
  const view = renderHook(
    ({
      ingestBusy,
      mediaKey,
      canRun = true,
      projectPath = "/tmp/p/episode.sharecut",
    }: Props) =>
      usePrepareRun({
        projectPath,
        workingSet: ws,
        transcribed: 0,
        untranscribed: 1,
        mediaKey,
        ingestBusy,
        canRun,
        nameOf: (id) => id.toUpperCase(),
      }),
    { wrapper, initialProps: { ingestBusy: false, mediaKey: "" } as Props },
  );
  return {
    ...view,
    ws,
    api,
    modelContext,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  useDawStore.setState({
    projectPath: "/tmp/p/episode.sharecut",
    pipelineJob: null,
    activityJob: null,
  });
  start.mockResolvedValue(pipelineJobSnapshot({ id: "j1", status: "running" }));
  vocabulary.mockResolvedValue({
    show_title: null,
    prompt_limit: null,
    prompt_primer: "",
    terms: [],
    guest_names: [],
    revision: "r1",
    needs_retranscription: false,
    edited_tracks: [],
  });
});

describe("runOptions", () => {
  it("runs the saved settings from the start", () => {
    const cfg = pipelineConfig();
    expect(runOptions(cfg, "run", false)).toMatchObject({
      fromStep: undefined,
      enabledSteps: cfg.enabled_steps,
      useWorkingSet: true,
      forceTranscribe: false,
      retimeWords: false,
      overwriteEdited: false,
    });
  });

  it("starts Run again from here at the step it names", () => {
    expect(
      runOptions(pipelineConfig(), "run", false, "align_tracks").fromStep,
    ).toBe("align_tracks");
  });

  it("re-transcribes from the transcribe step, and re-times without transcribing again", () => {
    const cfg = pipelineConfig();
    expect(runOptions(cfg, "retranscribe", true)).toMatchObject({
      fromStep: "transcribe_tracks",
      forceTranscribe: true,
      overwriteEdited: true,
    });
    expect(runOptions(cfg, "update", true)).toMatchObject({
      fromStep: "transcribe_tracks",
      forceTranscribe: false,
      overwriteEdited: true,
    });
    expect(runOptions(cfg, "retime", false)).toMatchObject({
      fromStep: "transcribe_tracks",
      forceTranscribe: false,
      retimeWords: true,
    });
  });
});

describe("usePrepareRun auto-run", () => {
  it("starts the pipeline once, after the import ends with new audio", async () => {
    const { rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    expect(start).not.toHaveBeenCalled();
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0][1]).toMatchObject({ useWorkingSet: true });
    expect(useDawStore.getState().pipelineJob?.id).toBe("j1");
  });

  it("remembers the audio it started on, past the end of this hook", async () => {
    useDawStore.setState({
      project: minimalProject({ tracks: [sampleTrack({ id: "a" })] }),
    });
    const { rerender, unmount } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    unmount();
    expect(jobMediaKey("j1")).toBe(mediaKeyOf([sampleTrack({ id: "a" })]));
  });

  it("does not start when the import added nothing, or the person may not run", async () => {
    const { rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "a:/a.wav" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    rerender({ ingestBusy: true, mediaKey: "a:/a.wav", canRun: false });
    rerender({
      ingestBusy: false,
      mediaKey: "a:/a.wav|b:/b.wav",
      canRun: false,
    });
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts once when Home imported the audio and left the intent", async () => {
    writeOpenIntent("/tmp/p/episode.sharecut", {
      stage: "prepare",
      autoRun: true,
    });
    const { rerender } = setup();
    rerender({ ingestBusy: false, mediaKey: "" });
    expect(start).not.toHaveBeenCalled();
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav|b:/b.wav" });
    await act(async () => undefined);
    expect(start).toHaveBeenCalledOnce();
    expect(takeOpenStage("/tmp/p/episode.sharecut")).toBe("prepare");
  });

  it("keeps Home's auto-run as a waiting run when the slot is busy, then starts it", async () => {
    writeOpenIntent("/tmp/p/episode.sharecut", {
      stage: "prepare",
      autoRun: true,
    });
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ status: "running" }),
    });
    const { result, rerender } = setup();
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    expect(start).not.toHaveBeenCalled();
    act(() => {
      useDawStore.setState({ pipelineJob: null });
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it("waits out a busy pipeline slot, shows it, and runs when the slot frees", async () => {
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ status: "running" }),
    });
    const { result, rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    expect(start).not.toHaveBeenCalled();
    act(() => {
      useDawStore.setState({ pipelineJob: null });
    });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.waiting).toBe(false));
  });

  it("shows waiting, not silence, when the server refuses with pipeline_busy", async () => {
    start.mockRejectedValue(new ApiError("busy", "pipeline_busy", 409));
    const { result, rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    expect(useDawStore.getState().pipelineJob).toBeNull();
    start.mockResolvedValue(
      pipelineJobSnapshot({ id: "j2", status: "running" }),
    );
    act(() => result.current.tryAgain());
    await waitFor(() => expect(result.current.waiting).toBe(false));
    expect(useDawStore.getState().pipelineJob?.id).toBe("j2");
  });

  it("asks for a missing model, never downloads it, and goes on after it arrives", async () => {
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const missing = modelsFor("missing");
    const wrapperApi = { current: missing };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModelsContext.Provider value={wrapperApi.current}>
        {children}
      </ModelsContext.Provider>
    );
    const ws = workingSet();
    const { result, rerender } = renderHook(
      (p: Props) =>
        usePrepareRun({
          projectPath: "/tmp/p/episode.sharecut",
          workingSet: ws,
          transcribed: 0,
          untranscribed: 1,
          nameOf: (id) => id,
          canRun: true,
          ...p,
        }),
      { wrapper, initialProps: { ingestBusy: true, mediaKey: "" } as Props },
    );
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() =>
      expect(result.current.model).toMatchObject({
        id: "whisper",
        variant: "large-v3-turbo",
        size: "~1.6 GB",
      }),
    );
    expect(missing.download).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();

    wrapperApi.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.model).toBeNull());
  });

  it("does not loop when the model row already says installed", async () => {
    start.mockRejectedValue(WHISPER_NEEDED);
    const { result, rerender, modelContext } = setup(modelsFor("installed"));
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(result.current.model).not.toBeNull();
    modelContext.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await act(async () => undefined);
    expect(start).toHaveBeenCalledTimes(2);
    expect(result.current.model).toBeNull();
    expect(result.current.startError).toBe("Whisper is not downloaded.");
  });
});

describe("usePrepareRun keep my fixes", () => {
  it("re-transcribes at once when no transcript was fixed by hand", async () => {
    const { result } = setup();
    await act(async () => result.current.retranscribe());
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1]).toMatchObject({
      forceTranscribe: true,
      overwriteEdited: false,
    });
    expect(result.current.keepFixes).toBeNull();
  });

  it("asks on the row first when words were fixed, and Keep runs nothing", async () => {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: true,
      edited_tracks: ["maya", "joss"],
    });
    const { result } = setup();
    await act(async () => result.current.retranscribe());
    expect(start).not.toHaveBeenCalled();
    expect(result.current.keepFixes).toEqual({
      mode: "retranscribe",
      names: ["MAYA", "JOSS"],
    });
    act(() => result.current.keepMyFixes());
    expect(result.current.keepFixes).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("says Re-transcribe changed nothing and the staged Language edit stays", async () => {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: true,
      edited_tracks: ["maya", "joss"],
    });
    const { result } = setup(
      modelsFor("missing"),
      pipelineConfig({ config: { transcribe: { language: "es" } } }),
    );
    await act(async () => result.current.retranscribe());
    act(() => result.current.keepMyFixes());
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Kept the hand fixes on MAYA and JOSS. Nothing was re-transcribed. The Language edit stays staged on Spanish.",
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      tone: "status",
    });
  });

  it("leaves the Language clause out while the language detects automatically", async () => {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: true,
      edited_tracks: ["maya"],
    });
    const { result } = setup(
      modelsFor("missing"),
      pipelineConfig({ config: { transcribe: { language: null } } }),
    );
    await act(async () => result.current.retranscribe());
    act(() => result.current.keepMyFixes());
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Kept the hand fixes on MAYA. Nothing was re-transcribed.",
    );
  });

  it("Replace re-transcribes over the fixes", async () => {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: true,
      edited_tracks: ["maya"],
    });
    const { result } = setup();
    await act(async () => result.current.retranscribe());
    await act(async () => result.current.replaceFixes());
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1]).toMatchObject({
      forceTranscribe: true,
      overwriteEdited: true,
    });
  });
});

describe("usePrepareRun after a model download", () => {
  function setupWithArrival() {
    const api = { current: modelsFor("missing") };
    const ws = workingSet();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModelsContext.Provider value={api.current}>
        {children}
      </ModelsContext.Provider>
    );
    const view = renderHook(
      () =>
        usePrepareRun({
          projectPath: "/tmp/p/episode.sharecut",
          workingSet: ws,
          transcribed: 0,
          untranscribed: 1,
          mediaKey: "a:/a.wav",
          ingestBusy: false,
          canRun: true,
          nameOf: (id) => id,
        }),
      { wrapper },
    );
    return {
      ...view,
      arrive: () => {
        api.current = modelsFor("installed");
        view.rerender();
      },
    };
  }

  it.each([
    ["Re-transcribe", "retranscribe", { forceTranscribe: true }],
    ["Re-time words", "retime", { retimeWords: true }],
  ] as const)(
    "%s keeps its mode and Replace choice",
    async (_name, mode, flag) => {
      start.mockRejectedValueOnce(WHISPER_NEEDED);
      const { result, arrive } = setupWithArrival();
      await act(async () => result.current.run(mode, true));
      await waitFor(() => expect(result.current.model?.id).toBe("whisper"));
      arrive();
      await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
      expect(start.mock.calls[1][1]).toMatchObject({
        fromStep: "transcribe_tracks",
        overwriteEdited: true,
        ...flag,
      });
    },
  );

  it("Run from here keeps the step it was asked from", async () => {
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const { result, arrive } = setupWithArrival();
    await act(async () => result.current.run("run", false, "tighten_tracks"));
    await waitFor(() => expect(result.current.model?.id).toBe("whisper"));
    arrive();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1][1]).toMatchObject({
      fromStep: "tighten_tracks",
      forceTranscribe: false,
      retimeWords: false,
    });
  });
});

describe("usePrepareRun word timing", () => {
  function alignerSetup() {
    const row = (state: "missing" | "installed") =>
      modelsApi({
        status: modelStatus(
          registryRows().map((r) =>
            r.id === "word-aligner" ? modelRow({ ...r, state }) : r,
          ),
        ),
      });
    const api = { current: row("missing") };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModelsContext.Provider value={api.current}>
        {children}
      </ModelsContext.Provider>
    );
    const view = renderHook(
      () =>
        usePrepareRun({
          projectPath: "/tmp/p/episode.sharecut",
          workingSet: workingSet(),
          transcribed: 1,
          untranscribed: 0,
          mediaKey: "a:/a.wav",
          ingestBusy: false,
          canRun: true,
          nameOf: (id) => id,
        }),
      { wrapper },
    );
    return {
      ...view,
      land: () => {
        api.current = row("installed");
        view.rerender();
      },
    };
  }

  it("offers the aligner as a Model need and re-times the words once Get lands it", async () => {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: false,
      edited_tracks: [],
    });
    start.mockResolvedValue(pipelineJobSnapshot({ status: "running" }));
    const { result, land } = alignerSetup();
    expect(result.current.approximateTiming).toMatchObject({
      id: "word-aligner",
    });
    await act(async () =>
      result.current.awaitAligner(
        result.current.approximateTiming!,
        Promise.resolve({ kind: "ok" }),
      ),
    );
    expect(start).not.toHaveBeenCalled();
    land();
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0][1]).toMatchObject({ retimeWords: true });
    expect(result.current.approximateTiming).toBeNull();
  });

  it("does not re-time when the aligner lands without Get having been pressed on the row", async () => {
    const { land } = alignerSetup();
    land();
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("usePrepareRun Run while waiting", () => {
  it("keeps repeated busy feedback truthful when saved steps exclude ASR", async () => {
    start.mockRejectedValue(new ApiError("busy", "pipeline_busy", 409));
    const { result, ws } = setup(modelsFor("installed"));
    ws.cfg!.enabled_steps = ["ingest_tracks", "clean_audio"];
    await act(async () => result.current.run("run"));
    expect(result.current.waiting).toBe(true);
    expect(start.mock.calls[0][1]?.enabledSteps).toEqual([
      "ingest_tracks",
      "clean_audio",
    ]);
    const priorRefusals = start.mock.calls.length;
    await act(async () => result.current.tryAgain());
    expect(start).toHaveBeenCalledTimes(priorRefusals + 1);
    expect(result.current.waiting).toBe(true);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Another job is running. Processing starts when it finishes.",
    );
  });

  it("says another job is running and stays waiting when the slot is still busy", async () => {
    start.mockRejectedValue(new ApiError("busy", "pipeline_busy", 409));
    const { result, rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    await act(async () => result.current.tryAgain());
    expect(result.current.waiting).toBe(true);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Another job is running/,
    );
  });
});

describe("usePrepareRun start errors", () => {
  it("stops waiting after an error that is not a busy slot", async () => {
    start.mockRejectedValue(new ApiError("busy", "pipeline_busy", 409));
    const { result, rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.waiting).toBe(true));
    start.mockRejectedValue(new Error("Network down"));
    await act(async () => result.current.tryAgain());
    expect(result.current.waiting).toBe(false);
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Could not start/,
    );
  });
});

describe("usePrepareRun failed start", () => {
  it("keeps the failure for the row until a job holds the slot or a start works", async () => {
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ id: "old", status: "ok" }),
    });
    start.mockRejectedValue(new Error("Network down"));
    const { result, rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.startError).toBe("Network down"));
    expect(result.current.starting).toBe(false);
    start.mockResolvedValue(
      pipelineJobSnapshot({ id: "j2", status: "running" }),
    );
    await act(async () => result.current.tryAgain());
    await waitFor(() => expect(result.current.startError).toBeNull());
  });
});

describe("usePrepareRun and the audio a job covers", () => {
  const audio = () => mediaKeyOf([sampleTrack({ id: "a" })]);

  beforeEach(() => {
    useDawStore.setState({
      project: minimalProject({ tracks: [sampleTrack({ id: "a" })] }),
    });
  });

  it.each([
    ["a full run", "run", undefined],
    ["Re-transcribe", "retranscribe", undefined],
    ["from transcribe_tracks", "run", "transcribe_tracks"],
  ] as const)("%s covers the audio", async (_label, mode, fromStep) => {
    const { result } = setup();
    await act(async () => result.current.run(mode, false, fromStep));
    expect(jobMediaKey("j1")).toBe(audio());
  });

  it("a run from a later step does not", async () => {
    start.mockResolvedValue(
      pipelineJobSnapshot({ id: "j-later", status: "running" }),
    );
    const { result } = setup();
    await act(async () => result.current.run("run", false, "align_tracks"));
    expect(start).toHaveBeenCalledOnce();
    expect(jobMediaKey("j-later")).toBeUndefined();
  });
});

describe("usePrepareRun Try again after a failed start", () => {
  it("replays a failed Re-transcribe with its options", async () => {
    start.mockRejectedValueOnce(new Error("Network down"));
    const { result } = setup();
    await act(async () => result.current.run("retranscribe", true));
    await waitFor(() => expect(result.current.startError).toBe("Network down"));
    await act(async () => result.current.tryAgain());
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][1]).toMatchObject({
      fromStep: "transcribe_tracks",
      forceTranscribe: true,
      overwriteEdited: true,
    });
  });

  it("replays a failed Run from here at the same step", async () => {
    start.mockRejectedValueOnce(new Error("Network down"));
    const { result } = setup();
    await act(async () => result.current.run("run", false, "tighten_tracks"));
    await waitFor(() => expect(result.current.startError).toBe("Network down"));
    await act(async () => result.current.tryAgain());
    expect(start.mock.calls[1][1]).toMatchObject({
      fromStep: "tighten_tracks",
      forceTranscribe: false,
    });
  });

  it("runs plain once a start worked and a later job failed", async () => {
    start.mockRejectedValueOnce(new Error("Network down"));
    const { result } = setup();
    await act(async () => result.current.run("retranscribe", true));
    await waitFor(() => expect(result.current.startError).toBe("Network down"));
    await act(async () => result.current.run("run"));
    await waitFor(() => expect(result.current.startError).toBeNull());
    act(() =>
      useDawStore.setState({
        pipelineJob: pipelineJobSnapshot({ id: "j1", status: "error" }),
      }),
    );
    await act(async () => result.current.tryAgain());
    expect(start.mock.calls[2][1]).toMatchObject({
      fromStep: undefined,
      forceTranscribe: false,
    });
  });
});

describe("usePrepareRun refused over hand fixes", () => {
  const refused = pipelineJobSnapshot({
    id: "j7",
    status: "error",
    error: "refusing to replace edited transcripts in an unattended run",
    error_code: "transcript_overwrite_refused",
  });

  function fixed(edited: string[]) {
    vocabulary.mockResolvedValue({
      show_title: null,
      prompt_limit: null,
      prompt_primer: "",
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: false,
      edited_tracks: edited,
    });
  }

  it("asks Keep or Replace when a run it started is refused", async () => {
    fixed(["maya"]);
    const { result } = setup();
    act(() => useDawStore.setState({ pipelineJob: refused }));
    await waitFor(() =>
      expect(result.current.keepFixes).toEqual({
        mode: "update",
        names: ["MAYA"],
      }),
    );
    await act(async () => result.current.replaceFixes());
    expect(start.mock.calls[0][1]).toMatchObject({
      fromStep: "transcribe_tracks",
      forceTranscribe: false,
      overwriteEdited: true,
    });
  });

  it("says no run started when Keep answers a refused run, and the Language edit stays", async () => {
    fixed(["maya"]);
    const { result } = setup(
      modelsFor("missing"),
      pipelineConfig({ config: { transcribe: { language: "es" } } }),
    );
    act(() => useDawStore.setState({ pipelineJob: refused }));
    await waitFor(() => expect(result.current.keepFixes).not.toBeNull());
    act(() => result.current.keepMyFixes());
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Kept the hand fixes on MAYA. No run started, so nothing was re-transcribed. The Language edit stays staged on Spanish.",
    );
    expect(start).not.toHaveBeenCalled();
  });

  it("leaves a refusal already there as a failed row, and Try again asks", async () => {
    fixed(["maya"]);
    useDawStore.setState({ pipelineJob: refused });
    const { result } = setup();
    await act(async () => undefined);
    expect(result.current.keepFixes).toBeNull();
    await act(async () => result.current.tryAgain());
    expect(start).not.toHaveBeenCalled();
    expect(result.current.keepFixes).toMatchObject({ mode: "update" });
  });
});

describe("usePrepareRun cancel", () => {
  it("cancels the job the slot holds and records the answer", async () => {
    const job = pipelineJobSnapshot({ id: "j9", status: "running" });
    useDawStore.setState({ pipelineJob: job, activityJob: job });
    cancel.mockResolvedValue({ ...job, status: "cancelled" });
    const { result } = setup();
    await act(async () => result.current.cancel());
    expect(cancel).toHaveBeenCalledWith("j9");
    expect(useDawStore.getState().pipelineJob?.status).toBe("cancelled");
  });
});

const FULL_STEPS = [
  "ingest_tracks",
  "transcribe_tracks",
  "align_tracks",
  "fill_gate_holes",
  "clean_audio",
];

describe("runOptions for one run", () => {
  it("passes no skip list when no plan row was skipped", () => {
    expect(
      runOptions(pipelineConfig(), "run", false).skipSteps,
    ).toBeUndefined();
    expect(
      runOptions(pipelineConfig(), "run", false, undefined, new Set())
        .skipSteps,
    ).toBeUndefined();
  });

  it("skips the steps of a skipped row on top of the saved switches", () => {
    const cfg = pipelineConfig({
      step_names: FULL_STEPS,
      enabled_steps: FULL_STEPS.filter((id) => id !== "fill_gate_holes"),
    });
    const options = runOptions(
      cfg,
      "run",
      false,
      undefined,
      new Set(["align"]),
    );
    expect(options.skipSteps).toContain("align_tracks");
    expect(options.skipSteps).toContain("fill_gate_holes");
    expect(options.skipSteps).not.toContain("transcribe_tracks");
    expect(options.enabledSteps).toEqual(cfg.enabled_steps);
  });
});

describe("usePrepareRun with audio added after a run", () => {
  function added(over: { canRun?: boolean } = {}) {
    const api = modelsFor("installed");
    const ws = workingSet(
      pipelineConfig({ step_names: FULL_STEPS, enabled_steps: FULL_STEPS }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
    );
    const view = renderHook(
      ({ ingestBusy, mediaKey }: Props) =>
        usePrepareRun({
          projectPath: "/tmp/p/episode.sharecut",
          workingSet: ws,
          transcribed: 3,
          untranscribed: 1,
          mediaKey,
          ingestBusy,
          canRun: over.canRun ?? true,
          nameOf: (id) => id,
        }),
      {
        wrapper,
        initialProps: { ingestBusy: false, mediaKey: "a:/a.wav" } as Props,
      },
    );
    return view;
  }

  it("waits for Process new audio instead of starting when the import is done", async () => {
    const { rerender } = added();
    rerender({ ingestBusy: true, mediaKey: "a:/a.wav" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav|p:/p.wav" });
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
  });

  it("starts with the skipped rows when the person processes it", async () => {
    const { result } = added();
    await act(async () => {
      await result.current.run("run", false, undefined, new Set(["clean"]));
    });
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][1]).toMatchObject({
      skipSteps: expect.arrayContaining(["clean_audio"]),
    });
  });

  it("keeps the skipped rows when the run waits for the slot and goes on", async () => {
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ id: "other", status: "running" }),
    });
    const { result } = added();
    await act(async () => {
      await result.current.run("run", false, undefined, new Set(["align"]));
    });
    expect(result.current.waiting).toBe(true);
    expect(start).not.toHaveBeenCalled();
    act(() => useDawStore.setState({ pipelineJob: null }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0][1]).toMatchObject({
      skipSteps: expect.arrayContaining(["align_tracks"]),
    });
  });
});

describe("Prepare request lifetime", () => {
  it("replays the original config, selection and skip list after preflight refusal", async () => {
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const { result, ws, modelContext, rerender } = setup();
    const skipped = new Set<"align">(["align"]);
    ws.cfg = pipelineConfig({
      step_names: FULL_STEPS,
      enabled_steps: FULL_STEPS,
      config: { transcribe: { model: "small.en" } },
    });
    await act(async () =>
      result.current.run("run", false, "transcribe_tracks", skipped),
    );
    const original = structuredClone(start.mock.calls[0]);
    skipped.clear();
    ws.cfg.config.transcribe = { model: "large-v3-turbo" };
    ws.cfg = pipelineConfig({
      enabled_steps: ["clean_audio"],
      unattended: false,
    });
    modelContext.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1]).toEqual([
      original[0],
      { ...original[1], useWorkingSet: false },
    ]);
  });

  it.each(["path", "epoch"] as const)(
    "drops a model replay on a simultaneous %s switch",
    async (change) => {
      start.mockRejectedValueOnce(WHISPER_NEEDED);
      const { result, modelContext, rerender } = setup();
      await act(async () => result.current.run("run"));
      await act(async () => {
        const store = useDawStore.getState();
        const projectPath =
          change === "path" ? "/tmp/other/episode.sharecut" : store.projectPath;
        useDawStore.setState({
          projectPath,
          projectEpoch: store.projectEpoch + 1,
        });
        modelContext.current = modelsFor("installed");
        rerender({ ingestBusy: false, mediaKey: "", projectPath });
      });
      expect(start).toHaveBeenCalledOnce();
      expect(result.current.model).toBeNull();
    },
  );

  it("retains Run from here while waiting for the slot", async () => {
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ status: "running" }),
    });
    const { result, ws } = setup();
    const original = ws.cfg;
    await act(async () => result.current.run("run", false, "tighten_tracks"));
    ws.cfg = pipelineConfig({ enabled_steps: ["clean_audio"] });
    act(() => useDawStore.setState({ pipelineJob: null }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0][1]).toMatchObject({
      fromStep: "tighten_tracks",
      config: original?.config,
      enabledSteps: original?.enabled_steps,
    });
  });

  it("asks again when the edited targets change after Replace and model refusal", async () => {
    const base = await vocabulary("/tmp/p/episode.sharecut");
    vocabulary.mockResolvedValue({ ...base, edited_tracks: ["maya"] });
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const { result, modelContext, rerender } = setup();
    await act(async () => result.current.retranscribe());
    await act(async () => result.current.replaceFixes());
    expect(start).toHaveBeenCalledOnce();
    vocabulary.mockResolvedValue({ ...base, edited_tracks: ["maya", "joss"] });
    modelContext.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "" });
    await waitFor(() =>
      expect(result.current.keepFixes?.names).toEqual(["MAYA", "JOSS"]),
    );
    expect(start).toHaveBeenCalledOnce();
    await act(async () => result.current.replaceFixes());
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1][1]).toMatchObject({
      forceTranscribe: true,
      overwriteEdited: true,
    });
  });

  it("does not use a confirmation response after the project epoch changes", async () => {
    let finish: (
      value: Awaited<ReturnType<typeof loadTranscriptVocabulary>>,
    ) => void = () => undefined;
    vocabulary.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = setup();
    act(() => result.current.retranscribe());
    const store = useDawStore.getState();
    act(() => useDawStore.setState({ projectEpoch: store.projectEpoch + 1 }));
    await act(async () =>
      finish({
        show_title: null,
        prompt_limit: null,
        prompt_primer: "",
        terms: [],
        guest_names: [],
        revision: "r1",
        needs_retranscription: false,
        edited_tracks: [],
      }),
    );
    expect(start).not.toHaveBeenCalled();
    expect(result.current.keepFixes).toBeNull();
  });
});

describe("approximate timing download intent", () => {
  it("retires a cancelled Get before an unrelated aligner install", async () => {
    let finish: (outcome: DownloadOutcome) => void = () => undefined;
    const downloading = new Promise<DownloadOutcome>((resolve) => {
      finish = resolve;
    });
    const download = vi.fn(() => downloading);
    const cancel = vi.fn(async () => {
      finish({ kind: "cancelled" });
    });
    const makeApi = (state: "missing" | "installed") => {
      const api = modelsApi({
        status: modelStatus(
          registryRows().map((row) =>
            row.id === "word-aligner" ? modelRow({ ...row, state }) : row,
          ),
        ),
        download,
      });
      api.cancel = cancel;
      return api;
    };
    const context = { current: makeApi("missing") };
    const target = {
      id: "word-aligner",
      variant: null,
      label: "Word timing",
      size: "~360 MB",
    };
    let onGet: (outcome: Promise<DownloadOutcome>) => void = () => undefined;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModelsContext.Provider value={context.current}>
        {children}
        <ModelNeedRow model={target} onGet={(outcome) => onGet(outcome)} />
      </ModelsContext.Provider>
    );
    const { result, rerender } = renderHook(
      () =>
        usePrepareRun({
          projectPath: "/tmp/p/episode.sharecut",
          workingSet: workingSet(),
          transcribed: 1,
          untranscribed: 0,
          mediaKey: "a:/a.wav",
          ingestBusy: false,
          canRun: true,
          nameOf: (id) => id,
        }),
      { wrapper },
    );
    onGet = (outcome) => result.current.awaitAligner(target, outcome);
    fireEvent.click(screen.getByRole("button", { name: /^Get / }));
    expect(download).toHaveBeenCalledOnce();
    context.current.busy = true;
    context.current.models =
      context.current.models?.map((row) =>
        row.id === "word-aligner"
          ? { ...row, state: { kind: "downloading", bytes: 1, total: 10 } }
          : row,
      ) ?? null;
    rerender();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Cancel / }));
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await downloading).toEqual({ kind: "cancelled" });
    context.current = makeApi("missing");
    rerender();
    context.current = makeApi("installed");
    rerender();
    await act(async () => undefined);
    expect(vocabulary).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("Prepare operation ownership", () => {
  it("asks again after a model wait even when edited IDs, media and vocabulary revision stay the same", async () => {
    const base = await vocabulary("/tmp/p/episode.sharecut");
    vocabulary.mockResolvedValue({ ...base, edited_tracks: ["maya"] });
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const { result, ws, modelContext, rerender } = setup();
    await act(async () => result.current.retranscribe());
    expect(result.current.keepFixes?.names).toEqual(["MAYA"]);
    expect(start).not.toHaveBeenCalled();
    await act(async () => result.current.replaceFixes());
    const original = structuredClone(start.mock.calls[0]);
    expect(original[1]).toMatchObject({
      overwriteEdited: true,
      forceTranscribe: true,
    });
    ws.cfg = pipelineConfig({
      enabled_steps: ["clean_audio"],
      unattended: false,
    });
    modelContext.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "" });
    await waitFor(() =>
      expect(result.current.keepFixes?.names).toEqual(["MAYA"]),
    );
    expect(start).toHaveBeenCalledOnce();
    await act(async () => result.current.replaceFixes());
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[1]).toEqual([
      original[0],
      { ...original[1], useWorkingSet: false },
    ]);
  });

  it.each(["path", "epoch"] as const)(
    "a late old start cannot clear a newer start after a %s change",
    async (change) => {
      let finishOld: (
        job: Awaited<ReturnType<typeof startPipelineRun>>,
      ) => void = () => undefined;
      let finishNew: (
        job: Awaited<ReturnType<typeof startPipelineRun>>,
      ) => void = () => undefined;
      start.mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      );
      start.mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
      const { result, rerender } = setup();
      await act(async () => {
        void result.current.run("run");
      });
      expect(result.current.starting).toBe(true);
      const path =
        change === "path"
          ? "/tmp/new/episode.sharecut"
          : "/tmp/p/episode.sharecut";
      act(() => {
        useDawStore.setState({
          projectPath: path,
          projectEpoch: useDawStore.getState().projectEpoch + 1,
        });
        rerender({ projectPath: path, ingestBusy: false, mediaKey: "" });
      });
      expect(result.current.starting).toBe(false);
      await act(async () => {
        void result.current.run("run", false, "clean_audio");
      });
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1]).toEqual([
        path,
        expect.objectContaining({ fromStep: "clean_audio" }),
      ]);
      expect(result.current.starting).toBe(true);
      await act(async () =>
        finishOld(pipelineJobSnapshot({ id: "old", status: "running" })),
      );
      expect(result.current.starting).toBe(true);
      expect(useDawStore.getState().pipelineJob).toBeNull();
      await act(async () => {
        void result.current.run("run");
      });
      expect(start).toHaveBeenCalledTimes(2);
      await act(async () =>
        finishNew(pipelineJobSnapshot({ id: "new", status: "running" })),
      );
      expect(result.current.starting).toBe(false);
      expect(useDawStore.getState().pipelineJob?.id).toBe("new");
    },
  );
});

describe("captured word timing settings", () => {
  it("uses the Get-time settings after its successful download and fresh model observation", async () => {
    let finish: (outcome: DownloadOutcome) => void = () => undefined;
    const outcome = new Promise<DownloadOutcome>((resolve) => {
      finish = resolve;
    });
    const { result, ws, modelContext, rerender } = setup();
    ws.cfg = pipelineConfig({
      enabled_steps: ["clean_audio"],
      unattended: false,
      config: { transcribe: { model: "small.en" } },
    });
    act(() =>
      result.current.awaitAligner(
        {
          id: "word-aligner",
          variant: null,
          label: "Word timing",
          size: "~360 MB",
        },
        outcome,
      ),
    );
    ws.cfg = pipelineConfig({
      enabled_steps: ["tighten_tracks"],
      unattended: true,
    });
    await act(async () => finish({ kind: "ok" }));
    modelContext.current = modelsApi({
      status: modelStatus(
        registryRows().map((row) =>
          row.id === "word-aligner"
            ? modelRow({ ...row, state: "installed" })
            : row,
        ),
      ),
    });
    rerender({ ingestBusy: false, mediaKey: "" });
    await waitFor(() =>
      expect(start).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p/episode.sharecut",
        expect.objectContaining({
          retimeWords: true,
          fromStep: "transcribe_tracks",
          unattended: false,
          enabledSteps: ["clean_audio", "transcribe_tracks"],
          config: { transcribe: { model: "small.en" } },
        }),
      ),
    );
  });
});

it("does not resave old working settings when a stopped request resumes", async () => {
  start.mockRejectedValueOnce(WHISPER_NEEDED);
  const { result, ws, modelContext, rerender } = setup();
  ws.cfg = pipelineConfig({
    enabled_steps: ["transcribe_tracks"],
    unattended: true,
    config: { transcribe: { model: "small.en" } },
  });
  await act(async () => result.current.run("run"));
  expect(start.mock.calls[0][1]).toMatchObject({ useWorkingSet: true });
  ws.cfg = pipelineConfig({
    enabled_steps: ["clean_audio"],
    unattended: false,
    config: { transcribe: { model: "large-v3-turbo" } },
  });
  modelContext.current = modelsFor("installed");
  rerender({ ingestBusy: false, mediaKey: "" });
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[1]).toEqual([
    "/tmp/p/episode.sharecut",
    expect.objectContaining({
      useWorkingSet: false,
      enabledSteps: ["transcribe_tracks"],
      unattended: true,
      config: { transcribe: { model: "small.en" } },
    }),
  ]);
});

describe("configuration capture ownership", () => {
  function mountReads() {
    type Config = ReturnType<typeof pipelineConfig>;
    const deferred = () => {
      let resolve!: (value: Config) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<Config>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    };
    const reads = [deferred(), deferred(), deferred()] as const;
    vi.mocked(loadPipelineConfig)
      .mockReset()
      .mockReturnValueOnce(reads[0].promise)
      .mockReturnValueOnce(reads[1].promise)
      .mockReturnValueOnce(reads[2].promise);
    const view = renderHook(() => {
      const workingSet = usePipelineWorkingSet("/tmp/p/episode.sharecut", true);
      return usePrepareRun({
        projectPath: "/tmp/p/episode.sharecut",
        workingSet,
        transcribed: 0,
        untranscribed: 1,
        mediaKey: "synthetic",
        ingestBusy: false,
        canRun: true,
        nameOf: (id) => id,
      });
    });
    return { ...view, reads };
  }

  it.each(["resolve", "reject"] as const)(
    "ignores an obsolete real working-set %s after the newer run succeeds",
    async (outcome) => {
      const {
        result,
        reads: [initial, older, newer],
      } = mountReads();
      let first!: Promise<void>;
      let second!: Promise<void>;
      act(() => {
        first = result.current.run("run");
        second = result.current.run("run");
      });
      expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
      await act(async () => {
        newer.resolve(pipelineConfig());
        await second;
      });
      expect(start).toHaveBeenCalledOnce();
      expect(useDawStore.getState().pipelineJob?.id).toBe("j1");
      expect(result.current.startError).toBeNull();
      await act(async () => {
        if (outcome === "resolve") older.resolve(pipelineConfig());
        else older.reject(new Error("Obsolete settings error"));
        await first;
        initial.resolve(pipelineConfig());
      });
      expect(result.current.startError).toBeNull();
      expect(start).toHaveBeenCalledOnce();
    },
  );

  it("reports a genuine failure of the current configuration read", async () => {
    const {
      result,
      reads: [initial, current],
    } = mountReads();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.run("run");
    });
    await act(async () => {
      current.reject(new Error("Settings offline"));
      await pending;
      initial.resolve(pipelineConfig());
    });
    expect(result.current.startError).toBe("Settings offline");
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["run", "retranscribe", "retime"] as const)(
    "retires a pending %s configuration capture on unmount",
    async (mode) => {
      useDawStore.setState({ statusAnnouncement: "" });
      const {
        result,
        unmount,
        reads: [initial, current],
      } = mountReads();
      let pending: Promise<void> | undefined;
      act(() => {
        if (mode === "run") pending = result.current.run("run");
        else if (mode === "retranscribe") result.current.retranscribe();
        else
          result.current.awaitAligner(
            {
              id: "word-aligner",
              variant: null,
              label: "Word timing",
              size: "360 MB",
            },
            Promise.resolve({ kind: "ok" }),
          );
      });
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
      unmount();
      await act(async () => {
        current.reject(new Error("Retired settings error"));
        await pending;
        initial.resolve(pipelineConfig());
      });
      expect(start).not.toHaveBeenCalled();
      expect(vocabulary).not.toHaveBeenCalled();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
    },
  );
});
