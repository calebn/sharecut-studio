import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  EXPORT_FINISHED,
  EXPORT_MODEL_NEEDED,
  EXPORT_PATH,
  EXPORT_STARTED,
  fakeExportServer,
} from "../../test/fakeExportServer";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import { ExportFlowProvider } from "./exportFlow";
import { type ExportFlow, useExportFlow } from "./exportFlowContext";

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

const MP3 = { ext: "mp3", codec: "libmp3lame", bitrate_kbps: 128 };

let flow: ExportFlow;
function Probe() {
  flow = useExportFlow();
  return null;
}

let server: ReturnType<typeof fakeExportServer>;

function mount() {
  return render(
    <ExportFlowProvider>
      <Probe />
    </ExportFlowProvider>,
  );
}

async function loaded() {
  await waitFor(() => expect(flow.settings).not.toBeNull());
}

async function running() {
  await waitFor(() => expect(flow.run).toMatchObject({ jobId: "x1" }));
}

describe("the export flow over the server's routes", () => {
  beforeEach(() => {
    server = fakeExportServer();
    useDawStore.setState({
      projectPath: EXPORT_PATH,
      project: minimalProject(),
      guestMode: null,
      stage: "deliver",
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
    expect(server.configRequests).toEqual([EXPORT_PATH]);
  });

  it("keeps the choice when a reload finds the same settings", async () => {
    mount();
    await loaded();
    act(() => flow.setSelected(["mp3", "flac"]));
    act(() => flow.reload());
    await waitFor(() => expect(server.configRequests).toHaveLength(2));
    expect(flow.selected).toEqual(["mp3", "flac"]);
  });

  it("starts over from the formats a reload finds when they changed", async () => {
    mount();
    await loaded();
    server.config = {
      config: { export: { wav: false, formats: [{ ext: "flac" }] } },
    };
    act(() => flow.reload());
    await waitFor(() => expect(flow.selected).toEqual(["flac"]));
    expect(flow.settings?.wav).toBe(false);
  });

  it("reports why the settings did not load, and loads them again on Try again", async () => {
    server.configAnswer = { status: 500, body: { detail: "offline" } };
    mount();
    await waitFor(() => expect(flow.settingsError).not.toBeNull());
    expect(flow.loading).toBe(false);
    expect(flow.settings).toBeNull();

    server.configAnswer = null;
    act(() => flow.again());
    await loaded();
    expect(flow.settingsError).toBeNull();
  });

  it("posts the chosen formats to the export route and follows the job to its files", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3", "flac"], REQUEST));

    expect(flow.run).toEqual({
      kind: "running",
      jobId: null,
      cancelling: false,
      cancelError: null,
    });
    await running();
    expect(server.exportRequests).toEqual([
      {
        path: EXPORT_PATH,
        formats: [MP3, { ext: "flac", codec: "flac" }],
      },
    ]);
    expect(flow.selected).toEqual(["mp3", "flac"]);
    expect(flow.request).toBe(REQUEST);

    vi.setSystemTime(new Date("2026-01-02T03:04:05Z"));
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(flow.run).toEqual({
      kind: "done",
      paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
      measured: "Measured −16.1 LUFS, true peak −1.6 dBTP.",
      lufs: -16.1,
      truePeak: -1.6,
      finishedAt: Date.parse("2026-01-02T03:04:05Z"),
    });
  });

  it("announces what the finished export wrote", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Exported 2 files to export/",
    });
  });

  it("ignores a second start while one runs", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    expect(server.exportRequests).toHaveLength(1);
  });

  it("exports with the project's saved formats when its settings did not load", async () => {
    server.configAnswer = { status: 500, body: { detail: "offline" } };
    mount();
    await waitFor(() => expect(flow.settingsError).not.toBeNull());
    act(() => flow.start([], REQUEST));
    await running();
    expect(server.exportRequests).toEqual([
      { path: EXPORT_PATH, formats: null },
    ]);
  });

  it("does not cancel before the server has answered the start", async () => {
    const answer = deferred();
    server.holdStart = answer.promise;
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    act(() => flow.cancel());
    expect(server.cancelRequests).toEqual([]);
    expect(flow.run).toMatchObject({ kind: "running", cancelling: false });
    answer.resolve();
    await running();
  });

  it("cancels the running job, then ends cancelled with nothing written", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();

    act(() => flow.cancel());
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });
    await waitFor(() =>
      expect(server.cancelRequests).toEqual([{ job_id: "x1" }]),
    );

    await act(async () =>
      server.settle({ ...EXPORT_STARTED, status: "cancelled" }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));
    expect(flow.run).toEqual({ kind: "cancelled", paths: [] });
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    act(() => flow.again());
    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("keeps the files a cancel arrived too late to stop", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () =>
      server.settle({ ...EXPORT_FINISHED, status: "cancelled" }),
    );
    await waitFor(() => expect(flow.run.kind).toBe("cancelled"));
    expect(flow.run).toEqual({
      kind: "cancelled",
      paths: ["/tmp/ep/export/ep.wav", "/tmp/ep/export/ep.mp3"],
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({
      x1: "Cancel came too late. Exported 2 files to export/",
    });
  });

  it("says why a cancel failed and lets it be tried again", async () => {
    server.cancelAnswer = { status: 500, body: { detail: "gone" } };
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    act(() => flow.cancel());
    await waitFor(() => expect(flow.run).toMatchObject({ cancelling: false }));
    expect((flow.run as { cancelError: string }).cancelError).toContain("gone");
  });

  it("names a failure", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () =>
      server.settle({
        ...EXPORT_STARTED,
        status: "error",
        error: "ffmpeg exited 1",
      }),
    );
    await waitFor(() =>
      expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" }),
    );
  });

  it("follows the job through the Activity snapshot", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    expect(flow.job).toEqual(useDawStore.getState().activityJob);
    expect(flow.job?.id).toBe("x1");
    act(() =>
      useDawStore.setState({ activityJob: { ...EXPORT_STARTED, id: "other" } }),
    );
    expect(flow.job).toBeNull();
  });

  it("returns to idle and announces nothing when the project changes", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    expect(flow.request).toBeNull();
    await waitFor(() =>
      expect(server.configRequests).toContain("/tmp/other.project.json"),
    );
  });

  it("forgets a finished export when the project changes", async () => {
    mount();
    await loaded();
    act(() => flow.start(["mp3"], REQUEST));
    await running();
    await act(async () => server.settle(EXPORT_FINISHED));
    await waitFor(() => expect(flow.run.kind).toBe("done"));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(flow.request).toBeNull();
  });

  describe("model gate", () => {
    const downloadModel = vi.fn();
    const mountGated = () =>
      renderWithModels(
        <ExportFlowProvider>
          <Probe />
        </ExportFlowProvider>,
        { status: modelStatus(registryRows()), download: downloadModel },
      );
    const startAndNeedModel = async () => {
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await running();
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));
    };

    beforeEach(() => {
      downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
    });

    it("asks on Deliver and exports once more after the download", async () => {
      await startAndNeedModel();
      await waitFor(() =>
        expect(flow.gate.prompt?.label).toBe("Noise reduction (RNNoise)"),
      );
      expect(server.exportRequests).toHaveLength(1);

      server.reopen();
      act(() => flow.gate.accept());
      await waitFor(() => expect(server.exportRequests).toHaveLength(2));
      expect(downloadModel).toHaveBeenCalledWith(["rnnoise"], undefined);
      await act(async () => server.settle(EXPORT_FINISHED));
      await waitFor(() => expect(flow.run.kind).toBe("done"));
    });

    it("fails with a hint when the person declines", async () => {
      await startAndNeedModel();
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
      await startAndNeedModel();
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());

      act(() =>
        useDawStore.setState({ projectPath: "/tmp/other.project.json" }),
      );
      await waitFor(() => expect(flow.gate.prompt).toBeNull());
      expect(flow.run).toEqual({ kind: "idle" });
    });

    it("does not loop when the same model is still missing after the download", async () => {
      await startAndNeedModel();
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());
      act(() => flow.gate.accept());

      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(server.exportRequests).toHaveLength(2);
    });

    it("opens no prompt when the person left Deliver before the job failed", async () => {
      mountGated();
      await loaded();
      act(() => flow.start(["mp3"], REQUEST));
      await running();
      act(() => useDawStore.setState({ stage: "edit" }));
      await act(async () => server.settle(EXPORT_MODEL_NEEDED));

      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(flow.gate.prompt).toBeNull();
      expect(flow.run).toEqual({
        kind: "failed",
        reason: expect.stringContaining("Noise reduction (RNNoise)"),
      });
      expect(downloadModel).not.toHaveBeenCalled();
    });
  });
});
