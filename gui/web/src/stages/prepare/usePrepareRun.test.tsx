import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
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
import { runOptions, usePrepareRun } from "./usePrepareRun";

vi.mock("../../api", async (original) => ({
  ...(await original<typeof import("../../api")>()),
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

function workingSet(): PipelineWorkingSet {
  return {
    cfg: pipelineConfig(),
    loadError: null,
    saveError: null,
    saving: false,
    reload: vi.fn(),
    update: vi.fn(async () => true),
    fetchFresh: vi.fn(async () => pipelineConfig()),
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
};

function setup(models = modelsFor("missing")) {
  const api = models;
  const ws = workingSet();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
  const view = renderHook(
    ({ ingestBusy, mediaKey, canRun = true }: Props) =>
      usePrepareRun({
        projectPath: "/tmp/p/episode.project.json",
        workingSet: ws,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useDawStore.setState({
    projectPath: "/tmp/p/episode.project.json",
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
          projectPath: "/tmp/p/episode.project.json",
          workingSet: ws,
          untranscribed: 1,
          nameOf: (id) => id,
          canRun: true,
          ...p,
        }),
      { wrapper, initialProps: { ingestBusy: true, mediaKey: "" } as Props },
    );
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() =>
      expect(result.current.model).toEqual({
        phase: "ask",
        size: "~1.6 GB",
        what: "the transcription model",
      }),
    );
    expect(missing.download).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();

    wrapperApi.current = modelsFor("installed");
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.model).toBeNull());
  });

  it("downloads the model only when the person taps Get", async () => {
    start.mockRejectedValueOnce(WHISPER_NEEDED);
    const { result, rerender, api } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await waitFor(() => expect(result.current.model?.phase).toBe("ask"));
    act(() => result.current.getModel());
    expect(api.download).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "large-v3-turbo",
    });
  });

  it("does not loop when the model row already says installed", async () => {
    start.mockRejectedValue(WHISPER_NEEDED);
    const { rerender } = setup(modelsFor("installed"));
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await act(async () => undefined);
    await act(async () => undefined);
    expect(start).toHaveBeenCalledOnce();
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
          projectPath: "/tmp/p/episode.project.json",
          workingSet: ws,
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
      await waitFor(() => expect(result.current.model?.phase).toBe("ask"));
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
    await waitFor(() => expect(result.current.model?.phase).toBe("ask"));
    arrive();
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(start.mock.calls[1][1]).toMatchObject({
      fromStep: "tighten_tracks",
      forceTranscribe: false,
      retimeWords: false,
    });
  });
});

describe("usePrepareRun Run while waiting", () => {
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
