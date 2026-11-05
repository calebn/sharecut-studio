import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startPipelineRun } from "../../api";
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
}));

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
  });

  it("shows the Model need row in place of the raw failure when the latest job failed for a model", () => {
    mount();
    fail(failedJob());
    expect(screen.getByText("Needs noise reduction")).toBeTruthy();
    expect(screen.getByText("0.3 MB")).toBeTruthy();
    expect(screen.queryByText("raw")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays out of the way for other failures, for guests, and for jobs Deliver owns", () => {
    const { container } = mount();
    fail(failedJob({ error_code: "other", error_model: null }));
    expect(container.textContent).toBe("");
    fail(failedJob({ kind: "export" }));
    expect(container.textContent).toBe("");
    fail(failedJob({ kind: "bounce" }));
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

  it("runs a failed pipeline job again from where it stopped when the model lands", async () => {
    const started = { ...failedJob(), id: "next", status: "running" };
    vi.mocked(startPipelineRun).mockResolvedValue(
      started as unknown as PipelineJobSnapshot,
    );
    const { land } = mount();
    fail(
      failedJob({
        kind: "pipeline",
        from_step: "transcribe_tracks",
        only_step: null,
        skip_steps: ["tighten"],
        unattended: false,
      }),
    );
    land("rnnoise");
    await waitFor(() =>
      expect(startPipelineRun).toHaveBeenCalledWith("/tmp/p.json", {
        fromStep: "transcribe_tracks",
        onlyStep: undefined,
        skipSteps: ["tighten"],
        unattended: false,
      }),
    );
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob).toMatchObject({ id: "next" }),
    );
  });

  it("says what to press when a job kind cannot run again by itself", async () => {
    const { land } = mount();
    useDawStore.setState({ statusAnnouncement: "" });
    fail(failedJob({ kind: "split_speakers" }));
    land("rnnoise");
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Noise reduction (RNNoise) downloaded. Split again.",
      ),
    );
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

  it("reports the failure instead of looping when the model is refused again after it landed", async () => {
    const { land } = mount();
    useDawStore.setState({ statusAnnouncement: "" });
    fail(failedJob());
    land("rnnoise");
    await waitFor(() => expect(runPointerCommand).toHaveBeenCalledTimes(1));
    fail(failedJob({ id: "job-2" }));
    await waitFor(() =>
      expect(useDawStore.getState().statusAnnouncement).toBe(
        "Noise reduction (RNNoise) is not downloaded.",
      ),
    );
    expect(screen.queryByText("Needs noise reduction")).toBeNull();
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
  });
});
