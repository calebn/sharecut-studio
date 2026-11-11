import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapStatus } from "../../api";
import {
  fetchBootstrapJob,
  fetchBootstrapStatus,
  retryPipelineJob,
  runBootstrap,
  startPipelineRun,
  waitForPipelineJob,
} from "../../api";
import { applyPipelineJobStatus } from "../../hooks/usePipelineJob";
import { ModelsProvider } from "../../models/ModelsProvider";
import { ModelsContext, useModels } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  modelsApi,
  registryRows,
  renderWithLanding,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { ApiError, type ModelNeeded } from "../../utils/apiError";
import { FrameAlerts } from "./FrameAlerts";
import { JobModelBanner } from "./JobModelBanner";

const runPointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../../commands/pointer", () => ({ runPointerCommand }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  retryPipelineJob: vi.fn(),
  waitForPipelineJob: vi.fn(),
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
}));

type JobWait = {
  id: string;
  signal: AbortSignal;
  resolve: (job: PipelineJobSnapshot) => void;
  reject: (error: Error) => void;
};
const jobWaits: JobWait[] = [];
const liveIO = vi.fn(() => {
  throw new Error("Live I/O is forbidden in banner tests");
});

function activeWait(id: string): JobWait {
  const wait = [...jobWaits]
    .reverse()
    .find((entry) => entry.id === id && !entry.signal.aborted);
  if (!wait) throw new Error("No active waiter for " + id);
  return wait;
}

function deferredJob() {
  let resolve!: (job: PipelineJobSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PipelineJobSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function deferredStatus() {
  let resolve!: (status: BootstrapStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BootstrapStatus>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function BoundedRealBanner({ onLimit }: { onLimit: () => void }) {
  const { observation, refresh } = useModels();
  const [show, setShow] = useState(true);
  useEffect(() => {
    if (observation.generation >= 8) {
      onLimit();
      setShow(false);
    }
  }, [observation.generation, onLimit]);
  return (
    <>
      <button onClick={() => void refresh()}>Refresh model status</button>
      {show ? (
        <FrameAlerts>
          <JobModelBanner guestShare={false} />
        </FrameAlerts>
      ) : (
        <p>Safety limit reached</p>
      )}
    </>
  );
}

function mountReal() {
  const requests: ReturnType<typeof deferredStatus>[] = [];
  vi.mocked(fetchBootstrapStatus).mockImplementation(() => {
    const request = deferredStatus();
    requests.push(request);
    return request.promise;
  });
  const onLimit = vi.fn();
  render(
    <ModelsProvider>
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <BoundedRealBanner onLimit={onLimit} />
      </DawProvider>
    </ModelsProvider>,
  );
  return { requests, onLimit };
}

const installedNoise = () =>
  modelStatus(
    registryRows().map((row) =>
      row.id === "rnnoise" ? { ...row, state: "installed" as const } : row,
    ),
  );

function failedJob(overrides: Partial<PipelineJobSnapshot> = {}) {
  return {
    id: "job-1",
    project_path: "/tmp/p.json",
    kind: "render_preview",
    status: "error",
    error: "raw",
    error_code: "model_needed",
    error_model: {
      id: "rnnoise",
      label: "Noise reduction (RNNoise)",
      size: "~0.3 MB",
      state: "missing",
    },
    ...overrides,
  } as unknown as PipelineJobSnapshot;
}

function mount(guestShare = false) {
  return renderWithLanding(
    <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
      <FrameAlerts>
        <JobModelBanner guestShare={guestShare} />
      </FrameAlerts>
    </DawProvider>,
    { status: modelStatus(registryRows()) },
  );
}

const fail = (job: PipelineJobSnapshot) =>
  act(() => {
    useDawStore.setState({ activityJob: job });
  });

describe("JobModelBanner", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({
      activityJob: null,
      pipelineJob: null,
      statusAnnouncement: "",
    });
    jobWaits.length = 0;
    liveIO.mockClear();
    vi.stubGlobal("fetch", liveIO);
    vi.stubGlobal("EventSource", liveIO);
    vi.mocked(waitForPipelineJob)
      .mockReset()
      .mockImplementation((id, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("Banner waiter must own an abort signal");
        const request = deferredJob();
        jobWaits.push({
          id,
          signal,
          resolve: request.resolve,
          reject: request.reject,
        });
        return request.promise;
      });
    runPointerCommand.mockReset();
    vi.mocked(startPipelineRun).mockReset();
    vi.mocked(retryPipelineJob)
      .mockReset()
      .mockResolvedValue(
        failedJob({
          id: "retry",
          kind: "pipeline",
          status: "running",
          error_code: null,
          error_model: null,
        }),
      );
    vi.mocked(fetchBootstrapStatus).mockReset();
    vi.mocked(fetchBootstrapJob).mockReset().mockResolvedValue(null);
    vi.mocked(runBootstrap).mockReset();
  });

  afterEach(() => {
    expect(liveIO).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each(["pipeline", "render_preview"])(
    "arms one read for an unchanged failed %s job while status responses stay pending",
    async (kind) => {
      const { requests, onLimit } = mountReal();
      expect(requests).toHaveLength(1);
      fail(failedJob({ kind }));
      expect(requests).toHaveLength(2);
      expect(onLimit).not.toHaveBeenCalled();
      expect(screen.getByText("Checking noise reduction")).toBeVisible();
      fail(failedJob({ kind }));
      await act(async () => requests[0]!.resolve(installedNoise()));
      expect(requests).toHaveLength(2);
      expect(startPipelineRun).not.toHaveBeenCalled();
      expect(runPointerCommand).not.toHaveBeenCalled();
      expect(runBootstrap).not.toHaveBeenCalled();
    },
  );

  it("recovers inline after both initial catalog reads fail", async () => {
    const { requests, onLimit } = mountReal();
    await act(async () =>
      requests[0]!.reject(new Error("Initial status offline")),
    );
    fail(failedJob({ kind: "pipeline" }));
    expect(requests).toHaveLength(2);
    await act(async () =>
      requests[1]!.reject(new Error("Recovery status offline")),
    );
    const check = screen.getByRole("button", {
      name: "Try again to check Noise reduction status",
    });
    expect(screen.getByText("Couldn't check noise reduction")).toBeVisible();
    await userEvent.click(check);
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve(installedNoise()));
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenCalledExactlyOnceWith(
        "/tmp/p.json",
        "job-1",
      ),
    );
    expect(runPointerCommand).not.toHaveBeenCalled();
    expect(onLimit).not.toHaveBeenCalled();
  });

  it("keeps a failed read actionable, retries with fresh evidence once, and does not re-arm the same job", async () => {
    useDawStore.setState({ statusAnnouncement: "" });
    const { requests, onLimit } = mountReal();
    await act(async () => requests[0]!.resolve(installedNoise()));
    fail(failedJob());
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.reject(new Error("Status offline")));
    expect(runPointerCommand).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Try again to check Noise reduction status",
      }),
    );
    expect(requests).toHaveLength(3);
    await act(async () => requests[2]!.resolve(installedNoise()));
    await waitFor(() =>
      expect(runPointerCommand).toHaveBeenCalledExactlyOnceWith(
        "render.refreshMix",
      ),
    );
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh model status" }),
    );
    expect(requests).toHaveLength(4);
    await act(async () => requests[3]!.resolve(installedNoise()));
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(4);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    useDawStore.setState({ statusAnnouncement: "" });
    fail(failedJob({ id: "job-2" }));
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Noise reduction (RNNoise) is not downloaded.",
    );
    expect(requests).toHaveLength(4);
    expect(onLimit).not.toHaveBeenCalled();
    expect(runBootstrap).not.toHaveBeenCalled();
  });

  it.each(
    ["pipeline", "render_preview"].flatMap((kind) =>
      ["ok", "cancelled", "error"].map((status) => ({ kind, status })),
    ),
  )(
    "offers a fresh need after recovered $kind ends with $status and the model is removed",
    async ({ kind, status }) => {
      vi.mocked(retryPipelineJob).mockResolvedValue(
        failedJob({ id: "retry", kind, status: "running", error_code: null }),
      );
      const { requests, onLimit } = mountReal();
      await act(async () => requests[0]!.resolve(modelStatus(registryRows())));
      fail(failedJob({ kind }));
      await act(async () => requests[1]!.resolve(installedNoise()));
      const resumed =
        kind === "pipeline" ? retryPipelineJob : runPointerCommand;
      await waitFor(() => expect(resumed).toHaveBeenCalledTimes(1));
      fail(
        failedJob({
          id: "retry",
          kind,
          status,
          error: null,
          error_code: null,
          error_model: null,
        }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Refresh model status" }),
      );
      await act(async () => requests[2]!.resolve(modelStatus(registryRows())));
      fail(failedJob({ id: "independent", kind }));
      expect(requests).toHaveLength(4);
      await act(async () => requests[3]!.resolve(modelStatus(registryRows())));
      expect(screen.getByText("Needs noise reduction")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Get noise reduction" }),
      ).toBeVisible();
      expect(requests).toHaveLength(4);
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(runBootstrap).not.toHaveBeenCalled();
      expect(onLimit).not.toHaveBeenCalled();
    },
  );

  it("shows the Model need row in place of the raw failure when the latest job failed for a model", () => {
    mount();
    fail(failedJob());
    expect(screen.getByText("Needs noise reduction")).toBeTruthy();
    expect(screen.getByText("0.3 MB")).toBeTruthy();
    expect(screen.queryByText("raw")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays out of the way for other failures, for guests, and for jobs a stage owns", () => {
    const { container } = mount();
    fail(failedJob({ error_code: "other", error_model: null }));
    expect(container.textContent).toBe("");
    fail(failedJob({ kind: "export" }));
    expect(container.textContent).toBe("");
    fail(failedJob({ kind: "bounce" }));
    expect(container.textContent).toBe("");
    fail(failedJob({ kind: "split_speakers" }));
    expect(container.textContent).toBe("");
    const guest = mount(true);
    fail(failedJob());
    expect(guest.container.textContent).toBe("");
  });

  it("refreshes the mix by itself when the model lands, and hides the row", async () => {
    const { land, api } = mount();
    fail(failedJob());
    await userEvent.click(
      screen.getByRole("button", { name: "Get noise reduction" }),
    );
    expect(api.download).toHaveBeenCalledWith(["rnnoise"], undefined);
    expect(runPointerCommand).not.toHaveBeenCalled();
    land("rnnoise");
    await waitFor(() =>
      expect(runPointerCommand).toHaveBeenCalledWith("render.refreshMix"),
    );
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
  });

  it("recovers a late pipeline model failure without inventing the original run options", async () => {
    const { land } = mount();
    useDawStore.setState({ statusAnnouncement: "" });
    fail(
      failedJob({
        kind: "pipeline",
        from_step: "transcribe_tracks",
        skip_steps: ["tighten"],
        unattended: false,
      }),
    );
    land("rnnoise");
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenCalledWith("/tmp/p.json", "job-1"),
    );
    expect(startPipelineRun).not.toHaveBeenCalled();
    expect(runPointerCommand).not.toHaveBeenCalled();
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
  });

  it("does not run a job of a project that has been closed since", async () => {
    const { land } = mount();
    fail(failedJob());
    act(() => {
      useDawStore.setState({
        projectEpoch: useDawStore.getState().projectEpoch + 1,
      });
    });
    land("rnnoise");
    await act(async () => {});
    expect(runPointerCommand).not.toHaveBeenCalled();
  });

  it.each(["pipeline", "render_preview"])(
    "reports a repeated %s refusal after its retry starts instead of looping",
    async (kind) => {
      const running = failedJob({
        id: "retry",
        kind,
        status: "running",
        error_code: null,
        error_model: null,
      });
      vi.mocked(retryPipelineJob).mockResolvedValue(running);
      const { land } = mount();
      useDawStore.setState({ statusAnnouncement: "" });
      fail(failedJob({ kind }));
      land("rnnoise");
      const resumed =
        kind === "pipeline" ? retryPipelineJob : runPointerCommand;
      await waitFor(() => expect(resumed).toHaveBeenCalledTimes(1));
      fail(running);
      fail(failedJob({ id: kind === "pipeline" ? "retry" : "job-2", kind }));
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Noise reduction (RNNoise) is not downloaded.",
        ),
      );
      expect(screen.queryByText("Needs noise reduction")).toBeNull();
      expect(resumed).toHaveBeenCalledTimes(1);
    },
  );
  it("does not adopt a retained retry response after the project instance changes", async () => {
    let accept!: (job: PipelineJobSnapshot) => void;
    vi.mocked(retryPipelineJob).mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const { land } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
    const other = failedJob({
      id: "other-project",
      status: "running",
      error_code: null,
    });
    act(() =>
      useDawStore.setState({
        projectEpoch: useDawStore.getState().projectEpoch + 1,
        activityJob: other,
      }),
    );
    await act(async () =>
      accept(failedJob({ id: "retry", status: "running", error_code: null })),
    );
    expect(useDawStore.getState().activityJob).toBe(other);
  });

  it("keeps a later independent model need actionable after a retry request is refused", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new Error("The project is busy."),
    );
    const { land } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "The project is busy.",
      ),
    );
    fail(failedJob({ id: "independent", kind: "pipeline" }));
    land("rnnoise");
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenLastCalledWith(
        "/tmp/p.json",
        "independent",
      ),
    );
    expect(retryPipelineJob).toHaveBeenCalledTimes(2);
    expect(startPipelineRun).not.toHaveBeenCalled();
  });
  it("keeps the original retained request while another missing model is downloaded", async () => {
    const aligner: ModelNeeded = {
      id: "word-aligner",
      variant: null,
      label: "Word aligner",
      purpose: "word timing",
      size: "~360 MB",
      sizeBytes: null,
      state: "missing",
    };
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError(
        "Word aligner is not downloaded.",
        "model_needed",
        409,
        aligner,
      ),
    );
    const { land, api } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    const get = await screen.findByRole("button", { name: "Get word timing" });
    expect(retryPipelineJob).toHaveBeenCalledTimes(1);
    await userEvent.click(get);
    expect(api.download).toHaveBeenLastCalledWith(["word-aligner"], undefined);
    land("word-aligner");
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "job-1"],
      ["/tmp/p.json", "job-1"],
    ]);
    expect(startPipelineRun).not.toHaveBeenCalled();
  });

  it("bounds a repeated model refusal during retained admission", async () => {
    const noise: ModelNeeded = {
      id: "rnnoise",
      variant: null,
      label: "Noise reduction (RNNoise)",
      purpose: "noise reduction",
      size: "~0.3 MB",
      sizeBytes: null,
      state: "missing",
    };
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError(
        "Noise reduction is not downloaded.",
        "model_needed",
        409,
        noise,
      ),
    );
    const { land } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByRole("button", { name: "Get noise reduction" }),
    ).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Noise reduction (RNNoise) is not downloaded.",
    );
    expect(retryPipelineJob).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])(
    "bounds a successor discovered before the retry reply, with intervening activity %s",
    async (intervening) => {
      let reply!: (job: PipelineJobSnapshot) => void;
      vi.mocked(retryPipelineJob).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            reply = resolve;
          }),
      );
      const { requests } = mountReal();
      await act(async () => requests[0]!.resolve(modelStatus(registryRows())));
      fail(failedJob({ kind: "pipeline" }));
      await act(async () => requests[1]!.resolve(installedNoise()));
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      if (intervening)
        fail(
          failedJob({
            id: "unrelated",
            kind: "agent",
            status: "running",
            error_code: null,
            error_model: null,
          }),
        );
      const successor = {
        ...failedJob({ id: "retry", kind: "pipeline" }),
        retry_of: "job-1",
      };
      fail(successor);
      if (requests[2])
        await act(async () => requests[2]!.resolve(installedNoise()));
      await act(async () => reply(successor));
      expect(retryPipelineJob).toHaveBeenCalledTimes(1);
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Noise reduction (RNNoise) is not downloaded.",
      );
      expect(screen.queryByText("Needs noise reduction")).toBeNull();
    },
  );

  it("retries a temporarily busy retained admission only after Try again", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError("Another job is running.", "pipeline_busy", 409),
    );
    const { land } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    const retry = await screen.findByRole("button", {
      name: "Resume the stopped run",
    });
    expect(retryPipelineJob).toHaveBeenCalledTimes(1);
    await userEvent.click(retry);
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "job-1"],
      ["/tmp/p.json", "job-1"],
    ]);
  });
  it("keeps successor correlation after an uncertain transport failure", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new Error("Connection lost."),
    );
    const { land } = mount();
    fail(failedJob({ kind: "pipeline" }));
    land("rnnoise");
    await screen.findByRole("button", { name: "Resume the stopped run" });
    fail({
      ...failedJob({ id: "accepted-after-disconnect", kind: "pipeline" }),
      retry_of: "job-1",
    });
    await act(async () => undefined);
    expect(retryPipelineJob).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Noise reduction (RNNoise) is not downloaded.",
    );
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
  });
  function status(
    primary: PipelineJobSnapshot,
    jobs: PipelineJobSnapshot[],
    runningCount: number,
  ) {
    act(() => {
      const store = useDawStore.getState();
      applyPipelineJobStatus(
        {
          running: runningCount > 0,
          job: primary,
          jobs,
          running_count: runningCount,
        },
        store.setPipelineJob,
        store.setActivityJob,
        store.setActivityRunningCount,
      );
    });
  }

  it.each(["before", "after"])(
    "retains a busy refusal when competing activity arrives %s the response",
    async (order) => {
      let reject!: (error: Error) => void;
      vi.mocked(retryPipelineJob).mockImplementationOnce(
        () =>
          new Promise((_, no) => {
            reject = no;
          }),
      );
      const { land } = mount();
      const a = failedJob({ id: "A", kind: "pipeline" });
      const j = failedJob({
        id: "J",
        kind: "agent",
        status: "running",
        error_code: null,
        error_model: null,
      });
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      if (order === "before") status(j, [j, a], 1);
      await act(async () =>
        reject(new ApiError("Another job is running.", "pipeline_busy", 409)),
      );
      if (order === "after") status(j, [j, a], 1);
      const done = { ...j, status: "ok" } as PipelineJobSnapshot;
      status(done, [done, a], 0);
      await userEvent.click(
        await screen.findByRole("button", { name: "Resume the stopped run" }),
      );
      await waitFor(() =>
        expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
          ["/tmp/p.json", "A"],
          ["/tmp/p.json", "A"],
        ]),
      );
    },
  );

  it("retains a second prerequisite through competing activity and resumes the original request", async () => {
    const aligner: ModelNeeded = {
      id: "word-aligner",
      variant: null,
      label: "Word aligner",
      purpose: "word timing",
      size: "~360 MB",
      sizeBytes: null,
      state: "missing",
    };
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError(
        "Word aligner is not downloaded.",
        "model_needed",
        409,
        aligner,
      ),
    );
    const { land } = mount();
    const a = failedJob({ id: "A", kind: "pipeline" });
    const j = failedJob({
      id: "J",
      kind: "agent",
      status: "running",
      error_code: null,
      error_model: null,
    });
    status(a, [a], 0);
    land("rnnoise");
    await screen.findByRole("button", { name: "Get word timing" });
    status(j, [j, a], 1);
    const done = { ...j, status: "ok" } as PipelineJobSnapshot;
    status(done, [done, a], 0);
    land("word-aligner");
    await waitFor(() =>
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
        ["/tmp/p.json", "A"],
      ]),
    );
  });

  it.each(["path", "epoch"])(
    "retires a retained refusal on project %s change",
    async (change) => {
      vi.mocked(retryPipelineJob).mockRejectedValueOnce(
        new ApiError("Another job is running.", "pipeline_busy", 409),
      );
      const { land } = mount();
      status(failedJob({ id: "A", kind: "pipeline" }), [], 0);
      land("rnnoise");
      await screen.findByRole("button", { name: "Resume the stopped run" });
      act(() =>
        useDawStore.setState(
          change === "path"
            ? { projectPath: "/tmp/other.json" }
            : { projectEpoch: useDawStore.getState().projectEpoch + 1 },
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Resume the stopped run" }),
      ).toBeNull();
      expect(retryPipelineJob).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["before", "after"])(
    "keeps all model history through successors observed %s their replies",
    async (order) => {
      const replies: ((job: PipelineJobSnapshot) => void)[] = [];
      vi.mocked(retryPipelineJob).mockImplementation(
        () =>
          new Promise((yes) => {
            replies.push(yes);
          }),
      );
      const { land } = mount();
      useDawStore.setState({ statusAnnouncement: "" });
      const a = failedJob({ id: "A", kind: "pipeline" });
      const b = {
        ...failedJob({
          id: "B",
          kind: "pipeline",
          error_model: {
            id: "word-aligner",
            label: "Word aligner",
            size: "~360 MB",
            state: "missing",
          },
        }),
        retry_of: "A",
      };
      const c = { ...failedJob({ id: "C", kind: "pipeline" }), retry_of: "B" };
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      if (order === "before") status(b, [b, a], 0);
      await act(async () => replies[0]!(b));
      if (order === "after") status(b, [b, a], 0);
      await screen.findByRole("button", { name: "Get word timing" });
      land("word-aligner");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(2));
      if (order === "before") status(c, [c, b, a], 0);
      await act(async () => replies[1]!(c));
      if (order === "after") status(c, [c, b, a], 0);
      land("rnnoise");
      await waitFor(() =>
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Noise reduction (RNNoise) is not downloaded.",
        ),
      );
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
        ["/tmp/p.json", "B"],
      ]);
    },
  );

  it("arms the new project's model need when identity and primary change together", async () => {
    const { land } = mount();
    status(failedJob({ id: "old", kind: "pipeline" }), [], 0);
    await screen.findByRole("button", { name: "Get noise reduction" });
    const nextPath = "/tmp/new-banner-project.json";
    const next = failedJob({
      id: "new",
      kind: "pipeline",
      project_path: nextPath,
    });
    act(() => {
      useDawStore.getState().hydrate(nextPath, minimalProject());
      const store = useDawStore.getState();
      applyPipelineJobStatus(
        { running: false, job: next, jobs: [next], running_count: 0 },
        store.setPipelineJob,
        store.setActivityJob,
        store.setActivityRunningCount,
      );
    });
    await screen.findByRole("button", { name: "Get noise reduction" });
    land("rnnoise");
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenCalledWith(nextPath, "new"),
    );
    expect(retryPipelineJob).toHaveBeenCalledOnce();
  });

  it("can recover a foreign job once its project is opened", async () => {
    mount();
    const target = "/tmp/foreign-banner.json";
    const foreign = failedJob({
      id: "foreign-open",
      kind: "pipeline",
      project_path: target,
    });
    status(foreign, [foreign], 0);
    expect(
      screen.queryByRole("button", { name: "Get noise reduction" }),
    ).toBeNull();
    act(() => useDawStore.getState().hydrate(target, minimalProject()));
    expect(
      await screen.findByRole("button", { name: "Get noise reduction" }),
    ).toBeVisible();
  });

  it("does not rearm the original wait after leaving and returning to its project", async () => {
    const { land } = mount();
    status(failedJob({ id: "old-wait", kind: "pipeline" }), [], 0);
    await screen.findByRole("button", { name: "Get noise reduction" });
    act(() => {
      useDawStore
        .getState()
        .hydrate("/tmp/intermediate-banner.json", minimalProject());
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    });
    land("rnnoise");
    await act(async () => {});
    expect(
      screen.queryByRole("button", { name: "Get noise reduction" }),
    ).toBeNull();
    expect(retryPipelineJob).not.toHaveBeenCalled();
  });

  it("does not recover a primary job belonging to another project", async () => {
    mount();
    status(
      failedJob({
        id: "foreign",
        kind: "pipeline",
        project_path: "/tmp/foreign.json",
      }),
      [],
      0,
    );
    expect(
      screen.queryByRole("button", { name: "Get noise reduction" }),
    ).toBeNull();
    expect(retryPipelineJob).not.toHaveBeenCalled();
  });

  it("does not revive a directly cancelled independent model wait after another recovery", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError("Another job is running.", "pipeline_busy", 409),
    );
    const { land } = mount();
    const a = failedJob({ id: "A", kind: "pipeline" });
    const independent = failedJob({
      id: "D",
      kind: "pipeline",
      error_model: {
        id: "word-aligner",
        label: "Word aligner",
        size: "~360 MB",
        state: "missing",
      },
    });
    status(a, [a], 0);
    land("rnnoise");
    await screen.findByRole("button", { name: "Resume the stopped run" });
    status(independent, [independent, a], 0);
    await screen.findByRole("button", { name: "Get word timing" });
    const cancelled = {
      ...independent,
      status: "cancelled" as const,
      error_code: null,
      error_model: null,
    };
    status(cancelled, [cancelled, a], 0);
    await userEvent.click(
      await screen.findByRole("button", { name: "Resume the stopped run" }),
    );
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(2));
    land("word-aligner");
    await act(async () => {});
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
      ["/tmp/p.json", "A"],
    ]);
    expect(
      screen.queryByRole("button", { name: "Get word timing" }),
    ).toBeNull();
  });

  it("shows an independent model need and restores the earlier refused recovery after it finishes", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new ApiError("Another job is running.", "pipeline_busy", 409),
    );
    const { land } = mount();
    const a = failedJob({ id: "A", kind: "pipeline" });
    const independent = failedJob({
      id: "D",
      kind: "pipeline",
      error_model: {
        id: "word-aligner",
        label: "Word aligner",
        size: "~360 MB",
        state: "missing",
      },
    });
    status(a, [a], 0);
    land("rnnoise");
    await screen.findByRole("button", { name: "Resume the stopped run" });
    status(independent, [independent, a], 0);
    expect(
      await screen.findByRole("button", { name: "Get word timing" }),
    ).toBeVisible();
    land("word-aligner");
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenLastCalledWith("/tmp/p.json", "D"),
    );
    const done = failedJob({
      id: "D-next",
      kind: "pipeline",
      status: "ok",
      error_code: null,
      error_model: null,
      retry_of: "D",
    });
    status(done, [done, independent, a], 0);
    await userEvent.click(
      await screen.findByRole("button", { name: "Resume the stopped run" }),
    );
    await waitFor(() =>
      expect(retryPipelineJob).toHaveBeenLastCalledWith("/tmp/p.json", "A"),
    );
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
      ["/tmp/p.json", "D"],
      ["/tmp/p.json", "A"],
    ]);
  });
  function competingJobs() {
    const a = failedJob({ id: "A", kind: "pipeline" });
    const b = failedJob({
      id: "B",
      kind: "pipeline",
      retry_of: "A",
      status: "running",
      error: null,
      error_code: null,
      error_model: null,
    });
    const j = failedJob({
      id: "J",
      kind: "agent",
      status: "running",
      error: null,
      error_code: null,
      error_model: null,
    });
    return { a, b, j };
  }

  const alignerFailure = {
    id: "word-aligner",
    label: "Word aligner",
    purpose: "word timing",
    size: "~360 MB",
    state: "missing",
  };

  it.each(
    ["reply-first", "frame-first"].flatMap((order) =>
      ["different", "repeated"].map((need) => ({ order, need })),
    ),
  )(
    "follows B to a $need need with J primary, $order",
    async ({ order, need }) => {
      const reply = deferredJob();
      vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
      const { land } = mount();
      const { a, b, j } = competingJobs();
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      status(j, [j, a], 1);
      if (order === "frame-first") status(j, [j, b, a], 2);
      await act(async () => reply.resolve(b));
      if (order === "reply-first") status(j, [j, b, a], 2);
      expect(jobWaits.map((entry) => entry.id)).toEqual(["B"]);
      const waiter = activeWait("B");
      const terminal = failedJob({
        id: "B",
        kind: "pipeline",
        retry_of: "A",
        ...(need === "different" ? { error_model: alignerFailure } : {}),
      });
      await act(async () => waiter.resolve(terminal));
      expect(waiter.signal.aborted).toBe(true);
      expect(useDawStore.getState().activityJob).toBe(j);
      expect(useDawStore.getState().activityRunningCount).toBe(2);
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
      ]);
      if (need === "different") {
        expect(
          await screen.findByRole("button", { name: "Get word timing" }),
        ).toBeVisible();
        const c = failedJob({
          id: "C",
          kind: "pipeline",
          retry_of: "B",
          status: "running",
          error_code: null,
          error_model: null,
        });
        const acknowledgement = deferredJob();
        vi.mocked(retryPipelineJob).mockReturnValueOnce(
          acknowledgement.promise,
        );
        land("word-aligner");
        await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(2));
        expect(jobWaits.some((wait) => wait.id === "C")).toBe(false);
        await act(async () => acknowledgement.resolve(c));
        await waitFor(() => expect(activeWait("C").signal.aborted).toBe(false));
        await act(async () =>
          activeWait("C").resolve(
            failedJob({ id: "C", kind: "pipeline", retry_of: "B" }),
          ),
        );
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Noise reduction (RNNoise) is not downloaded.",
        );
        expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
          ["/tmp/p.json", "A"],
          ["/tmp/p.json", "B"],
        ]);
        expect(useDawStore.getState().activityJob).toBe(j);
      } else {
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Noise reduction (RNNoise) is not downloaded.",
        );
        expect(screen.queryByText("Needs noise reduction")).toBeNull();
      }
      expect(startPipelineRun).not.toHaveBeenCalled();
    },
  );

  it.each(["different", "repeated"])(
    "does not start a waiter or replay a terminal %s frame before the reply",
    async (need) => {
      const reply = deferredJob();
      vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
      const { land } = mount();
      const { a, b, j } = competingJobs();
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      const terminal = failedJob({
        id: "B",
        kind: "pipeline",
        retry_of: "A",
        ...(need === "different" ? { error_model: alignerFailure } : {}),
      });
      status(j, [j, terminal, a], 1);
      await act(async () => reply.resolve(b));
      expect(jobWaits).toHaveLength(0);
      expect(useDawStore.getState().activityJob).toBe(j);
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
      ]);
      if (need === "different") {
        expect(
          await screen.findByRole("button", { name: "Get word timing" }),
        ).toBeVisible();
      } else {
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Noise reduction (RNNoise) is not downloaded.",
        );
      }
    },
  );

  it("keeps an unknown-response retry idempotent while J hides its successor", async () => {
    vi.mocked(retryPipelineJob).mockRejectedValueOnce(
      new Error("Connection lost."),
    );
    const { land } = mount();
    const { a, b, j } = competingJobs();
    status(a, [a], 0);
    land("rnnoise");
    const retry = await screen.findByRole("button", {
      name: "Resume the stopped run",
    });
    expect(screen.getByText("Connection lost.")).toBeVisible();
    status(j, [j, a], 1);
    vi.mocked(retryPipelineJob).mockResolvedValueOnce(b);
    await userEvent.click(retry);
    await waitFor(() => expect(jobWaits).toHaveLength(1));
    await act(async () =>
      activeWait("B").resolve(
        failedJob({ id: "B", kind: "pipeline", retry_of: "A" }),
      ),
    );
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
      ["/tmp/p.json", "A"],
    ]);
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Noise reduction (RNNoise) is not downloaded.",
    );
    expect(useDawStore.getState().activityJob).toBe(j);
  });

  it.each(["reply-first", "frame-first"])(
    "retires unseen descendants after hydrate-away-return, %s",
    async (order) => {
      const reply = deferredJob();
      vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
      const { land } = mount();
      const { a, b, j } = competingJobs();
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      act(() => {
        useDawStore.getState().hydrate("/tmp/away.json", minimalProject());
        useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
      });
      const terminal = failedJob({ id: "B", kind: "pipeline", retry_of: "A" });
      if (order === "reply-first") await act(async () => reply.resolve(b));
      status(j, [j, terminal, a], 1);
      if (order === "frame-first") await act(async () => reply.resolve(b));
      status(
        j,
        [j, failedJob({ id: "C", kind: "pipeline", retry_of: "B" }), a],
        1,
      );
      expect(jobWaits).toHaveLength(0);
      expect(screen.queryByText("Needs noise reduction")).toBeNull();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      expect(useDawStore.getState().activityJob).toBe(j);
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
      ]);
      const independent = failedJob({
        id: "new-independent",
        kind: "pipeline",
        error_model: alignerFailure,
      });
      status(independent, [independent, j], 1);
      expect(
        await screen.findByRole("button", { name: "Get word timing" }),
      ).toBeVisible();
      land("word-aligner");
      await waitFor(() =>
        expect(retryPipelineJob).toHaveBeenLastCalledWith(
          "/tmp/p.json",
          "new-independent",
        ),
      );
    },
  );

  it("records a late retired reply even when the successor frame omits its parent", async () => {
    const reply = deferredJob();
    vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
    const { land } = mount();
    const { a, b, j } = competingJobs();
    status(a, [a], 0);
    land("rnnoise");
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
    act(() => {
      useDawStore.getState().hydrate("/tmp/away.json", minimalProject());
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    });
    status(j, [j], 1);
    await act(async () => reply.resolve(b));
    expect(useDawStore.getState().activityJob).toBe(j);
    status(failedJob({ id: "B", kind: "pipeline" }), [], 0);
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
    expect(jobWaits).toHaveLength(0);
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
    ]);
  });

  it("makes waiter failure visible and retries observation without another POST", async () => {
    const { a, b, j } = competingJobs();
    vi.mocked(retryPipelineJob).mockResolvedValueOnce(b);
    const { land } = mount();
    status(a, [a], 0);
    land("rnnoise");
    await waitFor(() => expect(jobWaits).toHaveLength(1));
    status(j, [j, b, a], 2);
    const first = activeWait("B");
    await act(async () => first.reject(new Error("Run status unavailable.")));
    expect(screen.getByText("Run status unavailable.")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Check the resumed run" }),
    );
    expect(first.signal.aborted).toBe(true);
    const next = activeWait("B");
    expect(next).not.toBe(first);
    await act(async () =>
      next.resolve(
        failedJob({
          id: "B",
          kind: "pipeline",
          retry_of: "A",
          error_model: alignerFailure,
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Get word timing" }),
    ).toBeVisible();
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
    ]);
    expect(useDawStore.getState().activityJob).toBe(j);
  });

  it.each(["hydrate", "unmount"])(
    "aborts the owned waiter on %s and ignores late completion",
    async (end) => {
      const { a, b } = competingJobs();
      vi.mocked(retryPipelineJob).mockResolvedValueOnce(b);
      const view = mount();
      status(a, [a], 0);
      view.land("rnnoise");
      await waitFor(() => expect(jobWaits).toHaveLength(1));
      const owned = activeWait("B");
      if (end === "hydrate") {
        act(() =>
          useDawStore.getState().hydrate("/tmp/next.json", minimalProject()),
        );
      } else {
        view.unmount();
      }
      expect(owned.signal.aborted).toBe(true);
      await act(async () =>
        owned.resolve(
          failedJob({
            id: "B",
            kind: "pipeline",
            retry_of: "A",
            error_model: alignerFailure,
          }),
        ),
      );
      expect(screen.queryByText("Needs word timing")).toBeNull();
      expect(useDawStore.getState().statusAnnouncement).toBe("");
      expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
        ["/tmp/p.json", "A"],
      ]);
    },
  );

  it("does not adopt a POST that settles after unmount", async () => {
    const reply = deferredJob();
    vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
    const view = mount();
    const { a, b } = competingJobs();
    status(a, [a], 0);
    view.land("rnnoise");
    await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => reply.resolve(b));
    expect(useDawStore.getState().activityJob).toBe(a);
    expect(jobWaits).toHaveLength(0);
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
    ]);
  });

  it("restarts a StrictMode observer after cleanup and accepts only its live result", async () => {
    const { a, b, j } = competingJobs();
    vi.mocked(retryPipelineJob).mockResolvedValueOnce(b);
    const tree = (modelState: BootstrapStatus) => (
      <StrictMode>
        <ModelsContext.Provider value={modelsApi({ status: modelState })}>
          <DawProvider
            projectPath="/tmp/p.json"
            initialProject={minimalProject()}
          >
            <FrameAlerts>
              <JobModelBanner guestShare={false} />
            </FrameAlerts>
          </DawProvider>
        </ModelsContext.Provider>
      </StrictMode>
    );
    const view = render(tree(modelStatus(registryRows())));
    status(a, [a], 0);
    view.rerender(tree(installedNoise()));
    await waitFor(() => expect(jobWaits).toHaveLength(2));
    expect(jobWaits.map((entry) => entry.signal.aborted)).toEqual([
      true,
      false,
    ]);
    status(j, [j, b, a], 2);
    await act(async () =>
      jobWaits[0]!.resolve(
        failedJob({ id: "B", kind: "pipeline", retry_of: "A" }),
      ),
    );
    expect(useDawStore.getState().statusAnnouncement).toBe("");
    await act(async () =>
      activeWait("B").resolve(
        failedJob({
          id: "B",
          kind: "pipeline",
          retry_of: "A",
          error_model: alignerFailure,
        }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Get word timing" }),
    ).toBeVisible();
    expect(jobWaits.map((entry) => entry.signal.aborted)).toEqual([true, true]);
    expect(useDawStore.getState().activityJob).toBe(j);
    expect(vi.mocked(retryPipelineJob).mock.calls).toEqual([
      ["/tmp/p.json", "A"],
    ]);
  });

  it.each(["repeated", "success"] as const)(
    "keeps a confirmed %s successor outcome when its late POST rejects",
    async (outcome) => {
      useDawStore.setState({ statusAnnouncement: "" });
      const reply = deferredJob();
      vi.mocked(retryPipelineJob).mockReturnValueOnce(reply.promise);
      const { land } = mount();
      const { a, j } = competingJobs();
      status(a, [a], 0);
      land("rnnoise");
      await waitFor(() => expect(retryPipelineJob).toHaveBeenCalledTimes(1));
      const terminal = failedJob({
        id: "B",
        kind: "pipeline",
        retry_of: "A",
        ...(outcome === "success"
          ? { status: "ok", error: null, error_code: null, error_model: null }
          : {}),
      });
      status(j, [j, terminal, a], 1);
      const confirmed = useDawStore.getState().statusAnnouncement;
      expect(confirmed).toBe(
        outcome === "repeated"
          ? "Noise reduction (RNNoise) is not downloaded."
          : "",
      );
      await act(async () =>
        reply.reject(new Error("Late POST connection error")),
      );
      expect(useDawStore.getState().statusAnnouncement).toBe(confirmed);
      expect(useDawStore.getState().activityJob).toBe(j);
      expect(retryPipelineJob).toHaveBeenCalledTimes(1);
      expect(jobWaits).toHaveLength(0);
    },
  );
});
