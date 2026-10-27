import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  loadPipelineConfig,
  startExportJob,
} from "../../api";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import { ApiError } from "../../utils/apiError";
import { ExportFlowProvider } from "./exportFlow";
import { type ExportFlow, useExportFlow } from "./exportFlowContext";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadPipelineConfig: vi.fn(),
  startExportJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));

const PATH = "/tmp/ep/episode.project.json";

const config = (extra: Record<string, unknown> = {}) =>
  ({
    config: {
      export: {
        wav: true,
        formats: [{ ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 }],
      },
      master: { integrated_lufs: -16, true_peak_db: -1.5 },
      ...extra,
    },
  }) as unknown as PipelineConfigResponse;

const started: PipelineJobSnapshot = {
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

const finished: PipelineJobSnapshot = {
  ...started,
  status: "ok",
  current: 2,
  result: {
    paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
    master: { measured: { integrated_lufs: -16.1, true_peak_db: -1.6 } },
  },
};

const REQUEST: ExportRequest = {
  settings: {
    formats: ["mp3"],
    loudness: "podcast",
    part: { mode: "whole" },
  },
  clips: [],
  chapters: [],
  range: null,
};

let flow: ExportFlow;
function Probe() {
  flow = useExportFlow();
  return null;
}

function mount() {
  return render(
    <ExportFlowProvider>
      <Probe />
    </ExportFlowProvider>,
  );
}

/** A follow that settles only when the test says so. */
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

async function loaded() {
  await waitFor(() => expect(flow.settings).not.toBeNull());
}

describe("ExportFlowProvider", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject(),
      guestMode: null,
      stage: "deliver",
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
    });
    vi.mocked(loadPipelineConfig).mockReset().mockResolvedValue(config());
    vi.mocked(startExportJob).mockReset().mockResolvedValue(started);
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads the project's formats and selects the configured ones", async () => {
    mount();
    expect(flow.loading).toBe(true);
    await loaded();
    expect(flow.loading).toBe(false);
    expect(flow.settings?.choices.map((c) => c.key)).toEqual([
      "mp3",
      "m4a",
      "flac",
    ]);
    expect(flow.selected).toEqual(["mp3"]);
    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("keeps the choice when a reload finds the same settings, and starts over when they changed", async () => {
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3", "flac"]));
    act(() => flow.reload());
    await waitFor(() => expect(loadPipelineConfig).toHaveBeenCalledTimes(2));
    expect(flow.selected).toEqual(["mp3", "flac"]);

    vi.mocked(loadPipelineConfig).mockResolvedValue(
      config({ export: { wav: false, formats: [{ ext: "flac" }] } }),
    );
    act(() => flow.reload());
    await waitFor(() => expect(flow.selected).toEqual(["flac"]));
    expect(flow.selected).toEqual(["flac"]);
    expect(flow.settings?.wav).toBe(false);
  });

  it("reports why the settings did not load, and loads them again on Try again", async () => {
    vi.mocked(loadPipelineConfig).mockRejectedValueOnce(new Error("offline"));
    mount();
    await waitFor(() => expect(flow.settingsError).toBe("offline"));
    expect(flow.loading).toBe(false);
    expect(flow.settings).toBeNull();

    act(() => flow.again());
    await loaded();
    expect(flow.settingsError).toBeNull();
  });

  it("exports the chosen formats, follows the job, then keeps what it wrote", async () => {
    const settle = heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3", "flac"], REQUEST));

    expect(flow.run).toEqual({
      kind: "running",
      jobId: null,
      cancelling: false,
      cancelError: null,
    });
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
    expect(startExportJob).toHaveBeenCalledWith(PATH, [
      { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 },
      { ext: "flac", codec: "flac" },
    ]);
    expect(flow.selected).toEqual(["mp3", "flac"]);
    expect(flow.request).toBe(REQUEST);

    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    await act(async () => settle().ok(finished));
    expect(flow.run).toEqual({
      kind: "done",
      paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
      measured: "Measured −16.1 LUFS, true peak −1.6 dBTP.",
      lufs: -16.1,
      truePeak: -1.6,
      finishedAt: Date.parse("2026-01-02T03:04:05Z"),
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Exported 2 files to export/",
    });
  });

  it("ignores a second start while one runs", async () => {
    heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
    expect(startExportJob).toHaveBeenCalledTimes(1);
  });

  it("exports with the project's saved formats when its settings did not load", async () => {
    vi.mocked(loadPipelineConfig).mockRejectedValue(new Error("offline"));
    heldFollow();
    mount();
    await waitFor(() => expect(flow.settingsError).toBe("offline"));
    act(() => flow.start([], REQUEST));
    await waitFor(() =>
      expect(startExportJob).toHaveBeenCalledWith(PATH, null),
    );
  });

  it("does not cancel before the job has started", async () => {
    vi.mocked(startExportJob).mockReturnValue(new Promise(() => undefined));
    heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.cancel());
    expect(cancelPipelineRun).not.toHaveBeenCalled();
    expect(flow.run).toMatchObject({ kind: "running", cancelling: false });
  });

  it("cancels the running job, then ends cancelled with nothing written", async () => {
    const settle = heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));

    act(() => flow.cancel());
    expect(cancelPipelineRun).toHaveBeenCalledWith("x1");
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...started, status: "cancelled" },
          "Export cancelled",
        ),
      ),
    );
    expect(flow.run).toEqual({ kind: "cancelled", paths: [] });
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    act(() => flow.again());
    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("keeps the files a cancel arrived too late to stop", async () => {
    const settle = heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...finished, status: "cancelled" },
          "Export cancelled",
        ),
      ),
    );
    expect(flow.run).toEqual({
      kind: "cancelled",
      paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Cancel came too late. Exported 2 files to export/",
    });
  });

  it("says why a cancel failed and lets it be tried again", async () => {
    vi.mocked(cancelPipelineRun).mockRejectedValue(new Error("gone"));
    heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
    act(() => flow.cancel());
    await waitFor(() =>
      expect(flow.run).toMatchObject({
        cancelling: false,
        cancelError: "gone",
      }),
    );
  });

  it("names a failure", async () => {
    vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() =>
      expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" }),
    );
  });

  it("follows the job through the Activity snapshot", async () => {
    heldFollow();
    mount();
    await loaded();
    expect(flow.job).toBeNull();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
    act(() =>
      useDawStore.setState({ activityJob: { ...started, id: "other" } }),
    );
    expect(flow.job).toBeNull();
    act(() => useDawStore.setState({ activityJob: started }));
    expect(flow.job).toBe(started);
  });

  it("returns to idle and announces nothing when the project changes", async () => {
    heldFollow();
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    expect(flow.request).toBeNull();
    await waitFor(() =>
      expect(loadPipelineConfig).toHaveBeenCalledWith(
        "/tmp/other.project.json",
      ),
    );
  });

  describe("model gate", () => {
    const needed = (id = "rnnoise") =>
      new ApiError("needs RNNoise", "model_needed", 409, {
        id,
        variant: null,
        label: "Noise reduction (RNNoise)",
        purpose: "noise reduction",
        size: "~0.3 MB",
        sizeBytes: null,
        state: "missing",
      });
    const downloadModel = vi.fn();
    const mountGated = () =>
      renderWithModels(
        <ExportFlowProvider>
          <Probe />
        </ExportFlowProvider>,
        { status: modelStatus(registryRows()), download: downloadModel },
      );

    beforeEach(() => {
      downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
    });

    it("asks on Deliver and exports once more after the download", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));

      await waitFor(() =>
        expect(flow.gate.prompt?.label).toBe("Noise reduction (RNNoise)"),
      );
      expect(startExportJob).toHaveBeenCalledTimes(1);

      act(() => flow.gate.accept());
      await waitFor(() => expect(flow.run.kind).toBe("done"));
      expect(downloadModel).toHaveBeenCalledWith(["rnnoise"], undefined);
      expect(startExportJob).toHaveBeenCalledTimes(2);
    });

    it("fails with a hint when the person declines", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());
      act(() => flow.gate.decline());

      await waitFor(() =>
        expect(flow.run).toEqual({
          kind: "failed",
          reason: "Noise reduction (RNNoise) is not downloaded.",
        }),
      );
      expect(flow.gate.declined).toEqual({
        id: "rnnoise",
        label: "Noise reduction (RNNoise)",
      });
    });

    it("returns to idle, not a failure, when the project changes during the ask", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());

      act(() =>
        useDawStore.setState({ projectPath: "/tmp/other.project.json" }),
      );
      await waitFor(() => expect(flow.gate.prompt).toBeNull());
      expect(flow.run).toEqual({ kind: "idle" });
    });

    it("does not loop when the same model is still missing after the download", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());
      act(() => flow.gate.accept());

      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(startExportJob).toHaveBeenCalledTimes(2);
    });

    it("opens no prompt when the person left Deliver before the job failed", async () => {
      const settle = heldFollow();
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
      act(() => useDawStore.setState({ stage: "edit" }));
      await act(async () => settle().fail(needed()));

      expect(flow.gate.prompt).toBeNull();
      expect(flow.run).toEqual({
        kind: "failed",
        reason: expect.stringContaining("Noise reduction (RNNoise)"),
      });
      expect(downloadModel).not.toHaveBeenCalled();
    });

    it("shows a plain failure for any other error", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await waitFor(() =>
        expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" }),
      );
      expect(flow.gate.prompt).toBeNull();
    });
  });
});
