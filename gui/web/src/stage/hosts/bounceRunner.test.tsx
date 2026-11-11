import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  listExportedFiles,
  revealExportedFile,
  startBounceJob,
} from "../../api";
import { cancelBounce, startBounce } from "../../commands/bounceRunnerHandle";
import type { BounceRequest } from "../../edit/exportRange";
import { useDawStore } from "../../state/dawStore";
import { uiProjectInitial } from "../../state/uiSlice";
import { deferred } from "../../test/deferred";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithLanding,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { ApiError } from "../../utils/apiError";
import { BounceRunnerProvider } from "./bounceRunner";
import { type BounceRun, useBounceRun } from "./bounceRunnerContext";
import * as deliverFiles from "./useDeliverFiles";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  startBounceJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
  revealExportedFile: vi.fn(),
  listExportedFiles: vi.fn(),
}));

const PATH = "/tmp/ep/episode.sharecut";

const started: PipelineJobSnapshot = {
  id: "b1",
  project_path: PATH,
  from_step: null,
  only_step: null,
  kind: "bounce",
  status: "running",
  current: 1,
  total: 2,
  message: "Bouncing…",
  error: null,
  elapsed_sec: 3,
  steps: [],
};

const finished: PipelineJobSnapshot = {
  ...started,
  status: "ok",
  result: {
    paths: ["/tmp/ep/export/bounces/mix.wav", "/tmp/ep/export/bounces/mix.mp3"],
    file_ids: ["bounces/mix.wav", "bounces/mix.mp3"],
  },
};

const FULL_MIX: BounceRequest = {
  range: null,
  trackIds: null,
  source: "mix",
  includeMp3: false,
};

let run: BounceRun;
function Probe() {
  run = useBounceRun();
  return null;
}

const mount = () =>
  render(
    <BounceRunnerProvider>
      <Probe />
    </BounceRunnerProvider>,
  );

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

const toast = () => useDawStore.getState().feedbackToast;

describe("BounceRunnerProvider", () => {
  beforeEach(() => {
    useDawStore.setState({
      ...uiProjectInitial(),
      projectPath: PATH,
      project: minimalProject(),
      stage: "edit",
      guestMode: null,
      activityJob: null,
      pipelineJob: null,
      jobFeedback: new Map(),
      feedbackToast: null,
    });
    vi.mocked(startBounceJob).mockReset().mockResolvedValue(started);
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
    vi.mocked(revealExportedFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(listExportedFiles).mockReset();
    vi.spyOn(deliverFiles, "hostFileAccess").mockReturnValue("reveal");
  });

  it("posts the full mix as one WAV request and ends with a Reveal toast", async () => {
    const settle = heldFollow();
    mount();
    await act(async () => {
      expect(await startBounce(FULL_MIX)).toEqual({ status: "ok" });
    });
    await waitFor(() =>
      expect(run).toEqual({ kind: "running", jobId: "b1", cancelling: false }),
    );
    expect(startBounceJob).toHaveBeenCalledWith(PATH, {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
    await act(async () => settle().ok(finished));
    expect(run).toEqual({ kind: "idle" });
    expect(useDawStore.getState().jobFeedback.get("b1")).toMatchObject({
      kind: "ready",
      outcome: {
        kind: "verified",
        copy: "Exported the full mix as WAV",
        action: { label: "Reveal" },
      },
    });
  });

  it("reveals the first file when the Reveal action runs", async () => {
    const settle = heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    await act(async () => settle().ok(finished));
    const feedback = useDawStore.getState().jobFeedback.get("b1");
    const action =
      feedback?.kind === "ready" && feedback.outcome.kind === "verified"
        ? feedback.outcome.action
        : undefined;
    await act(async () => action?.run());
    expect(revealExportedFile).toHaveBeenCalledWith(PATH, "bounces/mix.wav");
  });

  it("offers Download in a browser and clicks one ticketed link per file", async () => {
    vi.spyOn(deliverFiles, "hostFileAccess").mockReturnValue("download");
    vi.mocked(listExportedFiles).mockResolvedValue([
      {
        id: "bounces/mix.wav",
        name: "mix.wav",
        kind: "bounce",
        label: "Unmastered export",
        bytes: 1,
        current: true,
        ticket: "t1",
      },
      {
        id: "bounces/mix.mp3",
        name: "mix.mp3",
        kind: "bounce",
        label: "Unmastered export",
        bytes: 1,
        current: true,
        ticket: "t2",
      },
    ]);
    const clicked: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this.getAttribute("href") ?? "");
      });
    const settle = heldFollow();
    mount();
    await act(
      async () => void (await startBounce({ ...FULL_MIX, includeMp3: true })),
    );
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    await act(async () => settle().ok(finished));
    const feedback = useDawStore.getState().jobFeedback.get("b1");
    const action =
      feedback?.kind === "ready" && feedback.outcome.kind === "verified"
        ? feedback.outcome.action
        : undefined;
    expect(action?.label).toBe("Download");
    await act(async () => action?.run());
    expect(clicked).toEqual([
      "/api/export/files/bounces/mix.wav?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=t1",
      "/api/export/files/bounces/mix.mp3?path=%2Ftmp%2Fep%2Fepisode.sharecut&ticket=t2",
    ]);
    click.mockRestore();
  });

  it("ignores a second start while one runs, so one request is posted", async () => {
    heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    let second;
    await act(async () => {
      second = await startBounce(FULL_MIX);
    });
    expect(second).toEqual({
      status: "disabled",
      reason: "Export is already running",
    });
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    expect(startBounceJob).toHaveBeenCalledTimes(1);
  });

  it.each(["export", "pipeline"] as const)(
    "refuses to start while a %s job is live",
    async (kind) => {
      useDawStore.setState({
        activityJob: { ...started, id: "x1", kind },
      });
      mount();
      let result;
      await act(async () => {
        result = await startBounce(FULL_MIX);
      });
      expect(result).toEqual({
        status: "disabled",
        reason: "Another export is running.",
      });
      expect(startBounceJob).not.toHaveBeenCalled();
    },
  );

  it("refuses a guest", async () => {
    useDawStore.setState({ guestMode: "viewer" });
    mount();
    let result;
    await act(async () => {
      result = await startBounce(FULL_MIX);
    });
    expect(result).toEqual({
      status: "disabled",
      reason: "Only the host can export",
    });
  });

  it("will not cancel before the job has an id", async () => {
    vi.mocked(startBounceJob).mockReturnValue(new Promise(() => undefined));
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    let result;
    await act(async () => {
      result = await cancelBounce();
    });
    expect(result).toEqual({
      status: "disabled",
      reason: "Export is still starting",
    });
    expect(cancelPipelineRun).not.toHaveBeenCalled();
  });

  it("cancels the running job by id and ends idle with no result toast", async () => {
    const settle = heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    await act(async () => void (await cancelBounce()));
    expect(cancelPipelineRun).toHaveBeenCalledWith("b1");
    expect(run).toMatchObject({ cancelling: true });
    await act(async () =>
      settle().fail(
        new JobCancelledError({ ...started, status: "cancelled" }, "stopped"),
      ),
    );
    expect(run).toEqual({ kind: "idle" });
    expect(useDawStore.getState().jobFeedback.get("b1")).toBeUndefined();
    expect(toast()).toBeNull();
  });

  it("keeps the files a cancel arrived too late to stop", async () => {
    const settle = heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    await act(async () =>
      settle().fail(
        new JobCancelledError({ ...finished, status: "cancelled" }, "stopped"),
      ),
    );
    expect(useDawStore.getState().jobFeedback.get("b1")).toMatchObject({
      outcome: {
        kind: "verified",
        copy: "Cancel came too late. Exported the full mix as WAV",
      },
    });
  });

  it("tells the person when the server refuses the start", async () => {
    vi.mocked(startBounceJob).mockRejectedValue(new Error("a job is running"));
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toEqual({ kind: "idle" }));
    expect(toast()).toMatchObject({
      message: "Export failed. a job is running",
      tone: "error",
    });
  });

  it("drops the run and announces nothing when the project changes", async () => {
    let finish!: (job: PipelineJobSnapshot) => void;
    vi.mocked(followJobToOk).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(run).toEqual({ kind: "idle" }));
    await act(async () => finish(finished));
    expect(run).toEqual({ kind: "idle" });
    expect(toast()).toBeNull();
  });

  it("cancels the running job when the project changes", async () => {
    heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(cancelPipelineRun).toHaveBeenCalledWith("b1"));
  });

  it("cancels a job whose start resolves after the project changed", async () => {
    const pending = deferred<PipelineJobSnapshot>();
    vi.mocked(startBounceJob).mockReturnValue(pending.promise);
    heldFollow();
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    expect(cancelPipelineRun).not.toHaveBeenCalled();
    await act(async () => pending.resolve(started));
    await waitFor(() => expect(cancelPipelineRun).toHaveBeenCalledWith("b1"));
  });

  it("keeps the new run after an old one completes in a reopened project", async () => {
    const old = deferred<PipelineJobSnapshot>();
    const next = deferred<PipelineJobSnapshot>();
    vi.mocked(followJobToOk).mockReturnValueOnce(old.promise);
    mount();
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b1" }));
    act(() => {
      useDawStore.getState().hydrate("/tmp/other.sharecut", minimalProject());
      useDawStore.getState().hydrate(PATH, minimalProject());
    });
    expect(run).toEqual({ kind: "idle" });
    useDawStore.setState({ activityJob: null });
    vi.mocked(startBounceJob).mockResolvedValue({ ...started, id: "b2" });
    vi.mocked(followJobToOk).mockReturnValueOnce(next.promise);
    await act(async () => void (await startBounce(FULL_MIX)));
    await waitFor(() => expect(run).toMatchObject({ jobId: "b2" }));
    await act(async () => old.resolve(finished));
    expect(run).toMatchObject({ kind: "running", jobId: "b2" });
    await act(async () => next.resolve({ ...finished, id: "b2" }));
    expect(run).toEqual({ kind: "idle" });
  });

  describe("model need", () => {
    const needed = () =>
      new ApiError("needs RNNoise", "model_needed", 409, {
        id: "rnnoise",
        variant: null,
        label: "Noise reduction (RNNoise)",
        purpose: "noise reduction",
        size: "~0.3 MB",
        sizeBytes: null,
        state: "missing",
      });
    const mountNeeding = () =>
      renderWithLanding(
        <BounceRunnerProvider>
          <Probe />
        </BounceRunnerProvider>,
        { status: modelStatus(registryRows()) },
      );

    it("toasts a Get action, then exports again on the Edit stage when the model lands", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      const { land, api } = mountNeeding();
      await act(async () => void (await startBounce(FULL_MIX)));
      await waitFor(() =>
        expect(toast()).toMatchObject({
          message: "Noise reduction (RNNoise) is not downloaded.",
          tone: "error",
          action: { label: "Get" },
        }),
      );
      expect(startBounceJob).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().stage).toBe("edit");

      await act(async () => toast()?.action?.run());
      expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);

      land("rnnoise");
      await waitFor(() => expect(startBounceJob).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(run).toEqual({ kind: "idle" }));
    });

    it("asks for the model once, then stops retrying when the retry is refused again", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      const { land } = mountNeeding();
      await act(async () => void (await startBounce(FULL_MIX)));
      await waitFor(() => expect(toast()?.action?.label).toBe("Get"));
      land("rnnoise");
      await waitFor(() => expect(startBounceJob).toHaveBeenCalledTimes(2));
      expect(toast()?.message).toBe(
        "Noise reduction (RNNoise) is not downloaded.",
      );
      expect(startBounceJob).toHaveBeenCalledTimes(2);
    });

    it("does not export into a different project when the model lands", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      const { land } = mountNeeding();
      await act(async () => void (await startBounce(FULL_MIX)));
      await waitFor(() => expect(toast()?.action?.label).toBe("Get"));
      act(() => {
        useDawStore
          .getState()
          .hydrate("/tmp/other.project.json", minimalProject());
        land("rnnoise");
      });
      await act(async () => undefined);
      expect(startBounceJob).toHaveBeenCalledTimes(1);
    });
  });
});
