import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  startBounceJob,
} from "../../api";
import { BOUNCE_DEFAULTS } from "../../stages/deliver/bounceLogic";
import { useDawStore } from "../../state/dawStore";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithModels,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { ExactRangeTarget } from "../../types/project";
import { ApiError } from "../../utils/apiError";
import { BounceFlowProvider } from "./bounceFlow";
import { type BounceFlow, useBounceFlow } from "./bounceFlowContext";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  startBounceJob: vi.fn(),
  followJobToOk: vi.fn(),
  cancelPipelineRun: vi.fn(),
}));

const PATH = "/tmp/ep/episode.project.json";

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
  },
};

const RANGE = {
  kind: "exact_range",
  intervals: [{ start: 1, end: 2 }],
  track_ids: ["a"],
  clips: [],
} as unknown as ExactRangeTarget;

let flow: BounceFlow;
function Probe() {
  flow = useBounceFlow();
  return null;
}

function mount() {
  return render(
    <BounceFlowProvider>
      <Probe />
    </BounceFlowProvider>,
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

describe("BounceFlowProvider", () => {
  beforeEach(() => {
    useDawStore.setState({
      projectPath: PATH,
      project: minimalProject(),
      stage: "deliver",
      selection: null,
      soloTracks: {},
      sessionRegion: null,
      bounceRangeTarget: null,
      activityJob: null,
      pipelineJob: null,
      pendingJobResults: {},
    });
    vi.mocked(startBounceJob).mockReset().mockResolvedValue(started);
    vi.mocked(followJobToOk).mockReset();
    vi.mocked(cancelPipelineRun).mockReset().mockResolvedValue(started);
  });

  it("starts with the whole mix as a WAV, and keeps what is chosen", () => {
    mount();
    expect(flow.choices).toEqual(BOUNCE_DEFAULTS);
    expect(flow.run).toEqual({ kind: "idle" });
    act(() =>
      flow.setChoices({
        source: "soloed",
        includeMp3: true,
        limitToRegion: true,
      }),
    );
    expect(flow.choices).toEqual({
      source: "soloed",
      includeMp3: true,
      limitToRegion: true,
    });
  });

  it("bounces the entire mix as a WAV, follows the job, then keeps what it wrote", async () => {
    const settle = heldFollow();
    mount();
    act(() => flow.start());
    expect(flow.run).toEqual({
      kind: "running",
      jobId: null,
      cancelling: false,
      cancelError: null,
      range: null,
    });
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    expect(startBounceJob).toHaveBeenCalledWith(PATH, {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
    });
    await act(async () => settle().ok(finished));
    expect(flow.run).toEqual({
      kind: "done",
      paths: [
        "/tmp/ep/export/bounces/mix.wav",
        "/tmp/ep/export/bounces/mix.mp3",
      ],
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Bounced 2 file(s) to export/bounces/",
    });
  });

  it("sends the selected tracks, the region and the MP3", async () => {
    heldFollow();
    useDawStore.setState({
      selection: { kind: "track", trackId: "t1", trackIds: ["t1", "t2"] },
      sessionRegion: { start_sec: 4, end_sec: 9 },
    });
    mount();
    act(() =>
      flow.setChoices({
        source: "selected",
        includeMp3: true,
        limitToRegion: true,
      }),
    );
    act(() => flow.start());
    await waitFor(() => expect(startBounceJob).toHaveBeenCalled());
    expect(startBounceJob).toHaveBeenCalledWith(PATH, {
      track_ids: ["t1", "t2"],
      start_s: 4,
      end_s: 9,
      formats: ["wav", "mp3"],
    });
  });

  it("sends the soloed tracks", async () => {
    heldFollow();
    useDawStore.setState({ soloTracks: { a: true, b: false, c: true } });
    mount();
    act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, source: "soloed" }));
    act(() => flow.start());
    await waitFor(() =>
      expect(startBounceJob).toHaveBeenCalledWith(
        PATH,
        expect.objectContaining({ track_ids: ["a", "c"] }),
      ),
    );
  });

  it("starts nothing without tracks to bounce", () => {
    mount();
    act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, source: "selected" }));
    act(() => flow.start());
    act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, source: "soloed" }));
    act(() => flow.start());
    expect(startBounceJob).not.toHaveBeenCalled();
    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("bounces a fixed range whatever the source says, then lets go of it", async () => {
    const settle = heldFollow();
    useDawStore.setState({
      bounceRangeTarget: RANGE,
      sessionRegion: { start_sec: 4, end_sec: 9 },
    });
    mount();
    act(() =>
      flow.setChoices({
        source: "selected",
        includeMp3: false,
        limitToRegion: true,
      }),
    );
    act(() => flow.start());
    await waitFor(() => expect(startBounceJob).toHaveBeenCalled());
    expect(startBounceJob).toHaveBeenCalledWith(PATH, {
      track_ids: null,
      start_s: null,
      end_s: null,
      formats: ["wav"],
      exact_range: RANGE,
    });
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
    await act(async () => settle().ok(finished));
    expect(useDawStore.getState().bounceRangeTarget).toBeNull();
  });

  it("keeps a range fixed while a bounce runs, so it can be bounced next", async () => {
    const settle = heldFollow();
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    act(() => useDawStore.getState().setBounceRangeTarget(RANGE));
    act(() => flow.start());
    expect(startBounceJob).toHaveBeenCalledTimes(1);
    expect(flow.run).toMatchObject({ kind: "running", range: null });
    await act(async () => settle().ok(finished));
    expect(flow.run).toMatchObject({ kind: "done" });
    expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
  });

  it("ignores a second start while one runs", async () => {
    heldFollow();
    mount();
    act(() => flow.start());
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    expect(startBounceJob).toHaveBeenCalledTimes(1);
  });

  it("does not cancel before the job has started", () => {
    vi.mocked(startBounceJob).mockReturnValue(new Promise(() => undefined));
    mount();
    act(() => flow.start());
    act(() => flow.cancel());
    expect(cancelPipelineRun).not.toHaveBeenCalled();
    expect(flow.run).toMatchObject({ kind: "running", cancelling: false });
  });

  it("cancels the running job, then ends cancelled with nothing written", async () => {
    const settle = heldFollow();
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));

    act(() => flow.cancel());
    expect(cancelPipelineRun).toHaveBeenCalledWith("b1");
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });

    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...started, status: "cancelled" },
          "Bounce cancelled",
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
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    await act(async () =>
      settle().fail(
        new JobCancelledError(
          { ...finished, status: "cancelled" },
          "Bounce cancelled",
        ),
      ),
    );
    expect(flow.run).toEqual({
      kind: "cancelled",
      paths: [
        "/tmp/ep/export/bounces/mix.wav",
        "/tmp/ep/export/bounces/mix.mp3",
      ],
    });
    expect(useDawStore.getState().pendingJobResults).toEqual({
      b1: "Cancel came too late. Bounced 2 file(s) to export/bounces/",
    });
  });

  it("says why a cancel failed and lets it be tried again", async () => {
    vi.mocked(cancelPipelineRun).mockRejectedValue(new Error("gone"));
    heldFollow();
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    act(() => flow.cancel());
    await waitFor(() =>
      expect(flow.run).toMatchObject({
        cancelling: false,
        cancelError: "gone",
      }),
    );
  });

  it("names a failure, keeps the fixed range and lets it go again", async () => {
    vi.mocked(followJobToOk).mockRejectedValue(new Error("ffmpeg exited 1"));
    useDawStore.setState({ bounceRangeTarget: RANGE });
    mount();
    act(() => flow.start());
    await waitFor(() =>
      expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" }),
    );
    expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
    expect(useDawStore.getState().pendingJobResults).toEqual({});
    act(() => flow.again());
    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("names a start that the server refused", async () => {
    vi.mocked(startBounceJob).mockRejectedValue(new Error("a job is running"));
    mount();
    act(() => flow.start());
    await waitFor(() =>
      expect(flow.run).toEqual({ kind: "failed", reason: "a job is running" }),
    );
  });

  it("follows the job through the Activity snapshot", async () => {
    heldFollow();
    mount();
    expect(flow.job).toBeNull();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    act(() =>
      useDawStore.setState({ activityJob: { ...started, id: "other" } }),
    );
    expect(flow.job).toBeNull();
    act(() => useDawStore.setState({ activityJob: started }));
    expect(flow.job).toBe(started);
  });

  it("returns to idle, forgets the choices and announces nothing when the project changes", async () => {
    heldFollow();
    mount();
    act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, includeMp3: true }));
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    expect(flow.choices).toEqual(BOUNCE_DEFAULTS);
    expect(useDawStore.getState().pendingJobResults).toEqual({});
  });

  it("ignores a job that resolves after the project changed", async () => {
    // A follow that finishes ok without honouring the abort signal.
    let finish!: (job: PipelineJobSnapshot) => void;
    vi.mocked(followJobToOk).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    mount();
    act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, includeMp3: true }));
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    await act(async () => finish(finished));

    expect(flow.run).toEqual({ kind: "idle" });
    expect(flow.choices).toEqual(BOUNCE_DEFAULTS);
  });

  describe("model gate", () => {
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
    const downloadModel = vi.fn();
    const mountGated = () =>
      renderWithModels(
        <BounceFlowProvider>
          <Probe />
        </BounceFlowProvider>,
        { status: modelStatus(registryRows()), download: downloadModel },
      );

    beforeEach(() => {
      downloadModel.mockReset().mockResolvedValue({ kind: "ok" });
    });

    it("asks on Deliver and bounces once more after the download", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      mountGated();
      act(() => flow.start());
      await waitFor(() =>
        expect(flow.gate.prompt?.label).toBe("Noise reduction (RNNoise)"),
      );
      act(() => flow.gate.accept());
      await waitFor(() => expect(flow.run.kind).toBe("done"));
      expect(downloadModel).toHaveBeenCalledWith(["rnnoise"], undefined);
      expect(startBounceJob).toHaveBeenCalledTimes(2);
    });

    it("returns quietly to idle when the person declines", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountGated();
      act(() => flow.start());
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());
      act(() => flow.gate.decline());
      await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
      expect(flow.gate.declined).toEqual({
        id: "rnnoise",
        label: "Noise reduction (RNNoise)",
      });
    });

    it("clears a fixed range and the choices when the person leaves Deliver", () => {
      mount();
      act(() => {
        flow.setChoices({ ...BOUNCE_DEFAULTS, includeMp3: true });
        useDawStore.setState({ bounceRangeTarget: RANGE });
      });
      expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
      act(() => useDawStore.setState({ stage: "edit" }));
      expect(useDawStore.getState().bounceRangeTarget).toBeNull();
      expect(flow.choices).toEqual(BOUNCE_DEFAULTS);
    });

    it("keeps a range set from Edit while arriving on Deliver", () => {
      mount();
      act(() => useDawStore.setState({ stage: "edit" }));
      act(() =>
        useDawStore.setState({ bounceRangeTarget: RANGE, stage: "deliver" }),
      );
      expect(useDawStore.getState().bounceRangeTarget).toBe(RANGE);
    });

    it("returns to idle, not a failure, when the project changes during the ask", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountGated();
      act(() => flow.start());
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
      act(() => flow.start());
      await waitFor(() => expect(flow.gate.prompt).not.toBeNull());
      act(() => flow.gate.accept());
      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(startBounceJob).toHaveBeenCalledTimes(2);
    });

    it("opens no prompt when the person left Deliver before the job failed", async () => {
      const settle = heldFollow();
      mountGated();
      act(() => flow.start());
      await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
      act(() => useDawStore.setState({ stage: "edit" }));
      await act(async () => settle().fail(needed()));
      expect(flow.gate.prompt).toBeNull();
      expect(flow.run).toEqual({
        kind: "failed",
        reason: expect.stringContaining("Noise reduction (RNNoise)"),
      });
      expect(downloadModel).not.toHaveBeenCalled();
    });
  });
});
