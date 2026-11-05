import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  startBounceJob,
} from "../../api";
import { BOUNCE_DEFAULTS } from "../../stages/deliver/bounceLogic";
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
  const current = useBounceFlow();
  useLayoutEffect(() => {
    flow = current;
  });
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
      ...uiProjectInitial(),
      projectPath: PATH,
      project: minimalProject(),
      stage: "deliver",
      selection: null,
      soloTracks: {},
      sessionRegion: null,
      bounceRangeTarget: null,
      activityJob: null,
      pipelineJob: null,
      jobFeedback: new Map(),
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
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "b1",
          {
            kind: "ready",
            outcome: {
              kind: "verified",
              copy: "Bounced 2 file(s) to export/bounces/",
            },
          },
        ],
      ]),
    );
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
    expect(useDawStore.getState().jobFeedback).toEqual(new Map([]));
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
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([
        [
          "b1",
          {
            kind: "ready",
            outcome: {
              kind: "verified",
              copy: "Cancel came too late. Bounced 2 file(s) to export/bounces/",
            },
          },
        ],
      ]),
    );
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

  it("ignores an old cancel failure while the next bounce is cancelling", async () => {
    const oldCancel = deferred<PipelineJobSnapshot>();
    const nextCancel = deferred<PipelineJobSnapshot>();
    vi.mocked(cancelPipelineRun)
      .mockReturnValueOnce(oldCancel.promise)
      .mockReturnValueOnce(nextCancel.promise);
    const settle = heldFollow();
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    act(() => flow.cancel());
    expect(cancelPipelineRun).toHaveBeenNthCalledWith(1, "b1");
    await act(async () => settle().ok(finished));
    expect(flow.run.kind).toBe("done");

    vi.mocked(startBounceJob).mockResolvedValue({ ...started, id: "b2" });
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b2" }));
    act(() => flow.cancel());
    expect(cancelPipelineRun).toHaveBeenNthCalledWith(2, "b2");
    expect(flow.run).toMatchObject({ cancelling: true, cancelError: null });

    await act(async () => oldCancel.reject(new Error("old cancel refused")));
    expect(flow.run).toMatchObject({
      kind: "running",
      jobId: "b2",
      cancelling: true,
      cancelError: null,
    });

    await act(async () =>
      nextCancel.reject(new Error("current cancel refused")),
    );
    expect(flow.run).toMatchObject({
      kind: "running",
      jobId: "b2",
      cancelling: false,
      cancelError: "current cancel refused",
    });
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
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["b1", { kind: "unverified" }]]),
    );
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
    expect(useDawStore.getState().jobFeedback).toEqual(
      new Map([["b1", { kind: "unverified" }]]),
    );
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

  it.each(["start", "follow"] as const)(
    "keeps the new bounce running after an old %s completes in a reopened project",
    async (phase) => {
      const old = deferred<PipelineJobSnapshot>();
      const next = deferred<PipelineJobSnapshot>();
      if (phase === "start")
        vi.mocked(startBounceJob).mockReturnValueOnce(old.promise);
      else vi.mocked(followJobToOk).mockReturnValueOnce(old.promise);
      mount();
      act(() => flow.start());
      if (phase === "follow")
        await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
      act(() => {
        useDawStore.getState().hydrate("/tmp/other.sharecut", minimalProject());
        useDawStore.getState().hydrate(PATH, minimalProject());
      });
      expect(flow.run).toEqual({ kind: "idle" });
      vi.mocked(startBounceJob).mockResolvedValue({ ...started, id: "b2" });
      vi.mocked(followJobToOk).mockReturnValueOnce(next.promise);
      act(() => flow.start());
      await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b2" }));
      await act(async () => old.resolve(finished));
      expect(flow.run).toMatchObject({ kind: "running", jobId: "b2" });
      await act(async () => next.resolve({ ...finished, id: "b2" }));
      expect(flow.run).toMatchObject({
        kind: "done",
        paths: finished.result?.paths,
      });
    },
  );

  it("ignores a failure that arrives after the project changed", async () => {
    let fail!: (e: Error) => void;
    vi.mocked(followJobToOk).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    await act(async () => fail(new Error("ffmpeg exited 1")));

    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("ignores a cancel that arrives after the project changed", async () => {
    let fail!: (e: Error) => void;
    vi.mocked(followJobToOk).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));

    act(() => useDawStore.setState({ projectPath: "/tmp/other.project.json" }));
    await waitFor(() => expect(flow.run).toEqual({ kind: "idle" }));
    await act(async () =>
      fail(
        new JobCancelledError(
          { ...finished, status: "cancelled" },
          "Bounce cancelled",
        ),
      ),
    );

    expect(flow.run).toEqual({ kind: "idle" });
  });

  it("returns a failed or cancelled run to idle when the person leaves Deliver, but keeps a running one", async () => {
    const settle = heldFollow();
    mount();
    act(() => flow.start());
    await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(flow.run).toMatchObject({ kind: "running" });
    await act(async () => settle().fail(new Error("ffmpeg exited 1")));
    expect(flow.run).toEqual({ kind: "failed", reason: "ffmpeg exited 1" });
    act(() => useDawStore.setState({ stage: "deliver" }));
    expect(flow.run).toMatchObject({ kind: "failed" });
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(flow.run).toEqual({ kind: "idle" });

    act(() => useDawStore.setState({ stage: "deliver" }));
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
    expect(flow.run).toMatchObject({ kind: "cancelled" });
    act(() => useDawStore.setState({ stage: "edit" }));
    expect(flow.run).toEqual({ kind: "idle" });
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
        <BounceFlowProvider>
          <Probe />
        </BounceFlowProvider>,
        { status: modelStatus(registryRows()) },
      );

    it("holds the bounce on Deliver and bounces again by itself when the model lands", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      const { land, api } = mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));
      expect(flow.run).toEqual({ kind: "idle" });
      expect(startBounceJob).toHaveBeenCalledTimes(1);

      land("rnnoise");
      await waitFor(() => expect(flow.run.kind).toBe("done"));
      expect(startBounceJob).toHaveBeenCalledTimes(2);
      expect(flow.needs).toBeNull();
      expect(api.download).not.toHaveBeenCalled();
    });

    it.each(["range", "selected", "soloed", "region"] as const)(
      "ends a stopped %s bounce when leaving Deliver",
      async (target) => {
        vi.mocked(followJobToOk)
          .mockRejectedValueOnce(needed())
          .mockResolvedValue(finished);
        useDawStore.setState({
          bounceRangeTarget: target === "range" ? RANGE : null,
          selection:
            target === "selected"
              ? { kind: "track", trackId: "a", trackIds: ["a", "b"] }
              : null,
          soloTracks: target === "soloed" ? { a: true, b: false } : {},
          sessionRegion:
            target === "region" ? { start_sec: 3, end_sec: 6 } : null,
        });
        const { land } = mountNeeding();
        act(() =>
          flow.setChoices({
            ...BOUNCE_DEFAULTS,
            source:
              target === "selected" || target === "soloed"
                ? target
                : BOUNCE_DEFAULTS.source,
            limitToRegion: target === "region",
          }),
        );
        act(() => flow.start());
        await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));
        expect(startBounceJob).toHaveBeenCalledTimes(1);

        act(() => useDawStore.setState({ stage: "edit" }));
        expect(useDawStore.getState().bounceRangeTarget).toBeNull();
        expect(flow.choices).toEqual(BOUNCE_DEFAULTS);
        land("rnnoise");
        await act(async () => undefined);
        expect(startBounceJob).toHaveBeenCalledTimes(1);
        expect(flow.needs).toBeNull();
        expect(flow.run).toEqual({ kind: "idle" });

        act(() => useDawStore.setState({ stage: "deliver" }));
        await act(async () => undefined);
        expect(startBounceJob).toHaveBeenCalledTimes(1);
      },
    );

    it("does not restart when model arrival and leaving Deliver coincide", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      useDawStore.setState({ bounceRangeTarget: RANGE });
      const { land } = mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));

      act(() => {
        useDawStore.setState({ stage: "edit" });
        land("rnnoise");
      });
      await act(async () => undefined);
      expect(startBounceJob).toHaveBeenCalledTimes(1);
      expect(flow.needs).toBeNull();
      expect(flow.run).toEqual({ kind: "idle" });
    });

    it.each(["different", "reopened"] as const)(
      "does not restart into a %s project when model arrival coincides",
      async (project) => {
        vi.mocked(followJobToOk)
          .mockRejectedValueOnce(needed())
          .mockResolvedValue(finished);
        useDawStore.setState({ bounceRangeTarget: RANGE });
        const { land } = mountNeeding();
        act(() => flow.start());
        await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));

        act(() => {
          useDawStore
            .getState()
            .hydrate("/tmp/other.project.json", minimalProject());
          if (project === "reopened") {
            useDawStore.getState().hydrate(PATH, minimalProject());
          }
          useDawStore.setState({ stage: "deliver" });
          land("rnnoise");
        });
        await act(async () => undefined);
        expect(startBounceJob).toHaveBeenCalledTimes(1);
        expect(flow.needs).toBeNull();
        expect(flow.run).toEqual({ kind: "idle" });
      },
    );

    it("replays the submitted fixed range after the range is cleared", async () => {
      vi.mocked(followJobToOk)
        .mockRejectedValueOnce(needed())
        .mockResolvedValue(finished);
      useDawStore.setState({ bounceRangeTarget: RANGE });
      const { land } = mountNeeding();
      act(() => flow.setChoices({ ...BOUNCE_DEFAULTS, includeMp3: true }));
      act(() => flow.start());
      await waitFor(() => expect(flow.needs?.id).toBe("rnnoise"));
      expect(startBounceJob).toHaveBeenNthCalledWith(1, PATH, {
        track_ids: null,
        start_s: null,
        end_s: null,
        formats: ["wav", "mp3"],
        exact_range: {
          kind: "exact_range",
          intervals: [{ start: 1, end: 2 }],
          track_ids: ["a"],
          clips: [],
        } as unknown as ExactRangeTarget,
      });

      act(() => useDawStore.getState().setBounceRangeTarget(null));
      land("rnnoise");
      await waitFor(() => expect(flow.run.kind).toBe("done"));

      expect(startBounceJob).toHaveBeenNthCalledWith(2, PATH, {
        track_ids: null,
        start_s: null,
        end_s: null,
        formats: ["wav", "mp3"],
        exact_range: {
          kind: "exact_range",
          intervals: [{ start: 1, end: 2 }],
          track_ids: ["a"],
          clips: [],
        } as unknown as ExactRangeTarget,
      });
    });

    it("keeps waiting while the model is still missing", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.needs).not.toBeNull());
      await act(async () => {});
      expect(startBounceJob).toHaveBeenCalledTimes(1);
      expect(flow.run).toEqual({ kind: "idle" });
    });

    it("drops the wait, not into a failure, when the project changes", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      const { land } = mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.needs).not.toBeNull());
      act(() =>
        useDawStore.setState({ projectPath: "/tmp/other.project.json" }),
      );
      await waitFor(() => expect(flow.needs).toBeNull());
      land("rnnoise");
      await act(async () => {});
      expect(flow.run).toEqual({ kind: "idle" });
      expect(startBounceJob).toHaveBeenCalledTimes(1);
    });

    it("fails instead of looping when the same model is refused again after it landed", async () => {
      vi.mocked(followJobToOk).mockRejectedValue(needed());
      const { land } = mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.needs).not.toBeNull());
      land("rnnoise");
      await waitFor(() => expect(flow.run.kind).toBe("failed"));
      expect(startBounceJob).toHaveBeenCalledTimes(2);
      expect(flow.needs).toBeNull();
    });

    it("says it plainly instead of waiting when the person left Deliver before the job failed", async () => {
      const settle = heldFollow();
      mountNeeding();
      act(() => flow.start());
      await waitFor(() => expect(flow.run).toMatchObject({ jobId: "b1" }));
      act(() => useDawStore.setState({ stage: "edit" }));
      await act(async () => settle().fail(needed()));
      expect(flow.needs).toBeNull();
      expect(flow.run).toEqual({
        kind: "failed",
        reason: expect.stringContaining("Noise reduction (RNNoise)"),
      });
    });
  });
});
