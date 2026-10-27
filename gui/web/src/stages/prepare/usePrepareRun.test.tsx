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
import { pipelineJobSnapshot } from "../../test/fixtures";
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
    reset: vi.fn(async () => true),
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

  it("leaves a busy pipeline slot alone", async () => {
    useDawStore.setState({
      pipelineJob: pipelineJobSnapshot({ status: "running" }),
    });
    const { rerender } = setup();
    rerender({ ingestBusy: true, mediaKey: "" });
    rerender({ ingestBusy: false, mediaKey: "a:/a.wav" });
    await act(async () => undefined);
    expect(start).not.toHaveBeenCalled();
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
