import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BootstrapStatus } from "../../api";
import {
  fetchBootstrapJob,
  fetchBootstrapStatus,
  retryPipelineJob,
  runBootstrap,
  startPipelineRun,
} from "../../api";
import { ModelsProvider } from "../../models/ModelsProvider";
import { useModels } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { DawProvider } from "../../state/store";
import { minimalProject } from "../../test/fixtures";
import {
  modelStatus,
  registryRows,
  renderWithLanding,
} from "../../test/renderWithModels";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { JobModelBanner } from "./JobModelBanner";

const runPointerCommand = vi.hoisted(() => vi.fn());
vi.mock("../../commands/pointer", () => ({ runPointerCommand }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  startPipelineRun: vi.fn(),
  retryPipelineJob: vi.fn(),
  fetchBootstrapStatus: vi.fn(),
  fetchBootstrapJob: vi.fn(),
  runBootstrap: vi.fn(),
}));

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
        <JobModelBanner guestShare={false} />
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
      <JobModelBanner guestShare={guestShare} />
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
    useDawStore.setState({ activityJob: null });
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

  it.each(["pipeline", "render_preview"])(
    "arms one read for an unchanged failed %s job while status responses stay pending",
    async (kind) => {
      const { requests, onLimit } = mountReal();
      expect(requests).toHaveLength(1);
      fail(failedJob({ kind }));
      expect(requests).toHaveLength(2);
      expect(onLimit).not.toHaveBeenCalled();
      expect(screen.getByText("Needs noise reduction")).toBeVisible();
      fail(failedJob({ kind }));
      await act(async () => requests[0]!.resolve(installedNoise()));
      expect(requests).toHaveLength(2);
      expect(startPipelineRun).not.toHaveBeenCalled();
      expect(runPointerCommand).not.toHaveBeenCalled();
      expect(runBootstrap).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed read actionable, retries with fresh evidence once, and does not re-arm the same job", async () => {
    useDawStore.setState({ statusAnnouncement: "" });
    const { requests, onLimit } = mountReal();
    await act(async () => requests[0]!.resolve(installedNoise()));
    fail(failedJob());
    expect(requests).toHaveLength(2);
    await act(async () => requests[1]!.reject(new Error("Status offline")));
    expect(runPointerCommand).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Check Noise reduction status" }),
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
});
