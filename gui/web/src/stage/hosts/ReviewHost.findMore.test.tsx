import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPipelineConfig, startPipelineRun } from "../../api";
import type { Question } from "../../feedback/ask";
import { ModelsContext } from "../../models/useModels";
import { useDawStore } from "../../state/dawStore";
import { answerQuestions } from "../../test/ask";
import { minimalProject, pendingEditView } from "../../test/fixtures";
import {
  modelStatus,
  modelsApi,
  registryRows,
} from "../../test/renderWithModels";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import { ApiError } from "../../utils/apiError";
import { ReviewHost } from "./ReviewHost";

const PATH = "/tmp/find-more/episode.project.json";
const confirm = vi.fn<(question: Question) => boolean | null>();

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  loadPipelineConfig: vi.fn(),
  startPipelineRun: vi.fn(),
}));

const config = (intensity = "aggressive") =>
  ({
    defaults: {},
    config: { tighten: { intensity, enabled: false } },
    enabled_steps: [],
    unattended: true,
    steps: [],
    params: [],
    components: {},
    step_names: [],
  }) as PipelineConfigResponse;

const job = (over: Partial<PipelineJobSnapshot> = {}): PipelineJobSnapshot => ({
  id: "job1",
  project_path: PATH,
  from_step: null,
  only_step: "analyze_fillers_pauses",
  kind: "pipeline",
  status: "running",
  current: null,
  total: null,
  message: null,
  error: null,
  elapsed_sec: 0,
  steps: [],
  ...over,
});

const hit = pendingEditView({
  id: "f1",
  kind: "filler",
  review_required: false,
});
const button = () => screen.findByRole("button", { name: "Find more" });

function mount(pending = [hit], guestMode: string | null = null) {
  useDawStore
    .getState()
    .hydrate(PATH, minimalProject({ pending_edits: pending }));
  useDawStore.setState({
    stage: "review",
    reviewSection: "queue",
    guestMode,
    pipelineJob: null,
    activityJob: null,
  });
  const api = modelsApi({ status: modelStatus(registryRows()) });
  render(
    <ModelsContext.Provider value={api}>
      <ReviewHost />
    </ModelsContext.Provider>,
  );
  return api;
}

const setJob = (next: PipelineJobSnapshot | null) =>
  act(() => useDawStore.getState().setPipelineJob(next));

beforeEach(() => {
  answerQuestions(confirm.mockReset().mockReturnValue(true));
  vi.mocked(loadPipelineConfig)
    .mockReset()
    .mockImplementation(async () => config());
  vi.mocked(startPipelineRun)
    .mockReset()
    .mockImplementation(async () => job());
});

describe("Find more in the Review host", () => {
  it("reruns only the filler step with the saved How tight", async () => {
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() =>
      expect(startPipelineRun).toHaveBeenCalledWith(
        PATH,
        expect.objectContaining({
          onlyStep: "analyze_fillers_pauses",
          useWorkingSet: false,
          config: expect.objectContaining({
            tighten: expect.objectContaining({
              intensity: "aggressive",
              enabled: true,
            }),
          }),
        }),
      ),
    );
    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob?.id).toBe("job1"),
    );
    expect(await screen.findByText("Finding more suggestions")).toBeVisible();
  });

  it("asks before replacing pending hits, and declining sends nothing", async () => {
    confirm.mockReturnValueOnce(false);
    mount();
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0].message).toContain("the 1 pending hit");
    expect(startPipelineRun).not.toHaveBeenCalled();
    await userEvent.click(await button());
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
  });

  it("is disabled with the reason while the pipeline slot is busy", async () => {
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    setJob(job({ id: "other", only_step: null }));
    expect(await button()).toBeDisabled();
    expect(await button()).toHaveAttribute(
      "title",
      "Wait for the current action to finish.",
    );
  });

  it("shows another running pipeline job as the top Job row with its percent", async () => {
    mount([]);
    setJob(job({ id: "prep", only_step: null, current: 2, total: 5 }));
    expect(await screen.findByText("Finding suggestions")).toBeVisible();
    expect(screen.getByText("40%")).toBeVisible();
    setJob(job({ id: "prep", status: "ok" }));
    await waitFor(() =>
      expect(screen.queryByText("Finding suggestions")).toBeNull(),
    );
  });

  it("shows the model prompt when a model is missing", async () => {
    vi.mocked(startPipelineRun).mockRejectedValueOnce(
      new ApiError("Needs the model.", "model_needed", 409, {
        id: "whisper",
        variant: null,
        label: "Whisper",
        purpose: "transcription",
        size: "~1.6 GB",
        sizeBytes: null,
        state: "missing",
      }),
    );
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    expect(
      await screen.findByRole("dialog", { name: "Download Whisper?" }),
    ).toBeVisible();
  });

  it("shows the error of a failed job in the stage", async () => {
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob).not.toBeNull(),
    );
    setJob(job({ status: "error", error: "Aligner crashed." }));
    expect(
      await screen.findByText("Could not find more suggestions"),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Details/ }));
    expect(screen.getByText(/Aligner crashed/)).toBeVisible();
  });

  it("shows a failed start in the stage", async () => {
    vi.mocked(startPipelineRun).mockRejectedValueOnce(new Error("busy"));
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    expect(
      await screen.findByText("Could not find more suggestions"),
    ).toBeVisible();
  });

  it("starts one run for two quick presses", async () => {
    let release: (j: PipelineJobSnapshot) => void = () => undefined;
    vi.mocked(startPipelineRun).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    const find = await button();
    fireEvent.click(find);
    fireEvent.click(find);
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
    await act(async () => release(job()));
    expect(startPipelineRun).toHaveBeenCalledTimes(1);
  });

  it("records a job started for a project the host has left", async () => {
    let release: (j: PipelineJobSnapshot) => void = () => undefined;
    vi.mocked(startPipelineRun).mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
    act(() =>
      useDawStore
        .getState()
        .hydrate("/tmp/other/b.project.json", minimalProject()),
    );
    await act(async () => release(job()));
    expect(useDawStore.getState().pipelineJob?.id).toBe("job1");
  });

  it("retries the settings on a press after the load failed", async () => {
    vi.mocked(loadPipelineConfig).mockRejectedValueOnce(new Error("blip"));
    mount([]);
    await waitFor(() => expect(loadPipelineConfig).toHaveBeenCalledTimes(1));
    expect(await button()).toBeEnabled();
    await userEvent.click(await button());
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
  });

  it("says in a described note why it is disabled, and when How tight is unset", async () => {
    vi.mocked(loadPipelineConfig).mockImplementation(async () => ({
      ...config(),
      config: {},
    }));
    mount([]);
    const note = await screen.findByText(
      "Set How tight in Prepare Cleanup first.",
    );
    expect(await button()).toBeDisabled();
    expect(await button()).toHaveAttribute("aria-describedby", note.id);
  });

  it("announces a failed start", async () => {
    vi.mocked(startPipelineRun).mockRejectedValueOnce(new Error("busy"));
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() =>
      expect(useDawStore.getState().feedbackToast?.message).toBe(
        "Could not find more suggestions.",
      ),
    );
  });

  it("shows the hits the finished job added to the queue", async () => {
    mount([]);
    await waitFor(async () => expect(await button()).toBeEnabled());
    await userEvent.click(await button());
    await waitFor(() =>
      expect(useDawStore.getState().pipelineJob).not.toBeNull(),
    );
    setJob(job({ status: "ok" }));
    expect(screen.getByRole("button", { name: "All, 0" })).toBeVisible();
    // The server writes the hits and document sync delivers them to the store.
    act(() =>
      useDawStore.getState().hydrate(
        PATH,
        minimalProject({
          pending_edits: [{ ...hit, review_required: true }],
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: "All, 1" })).toBeVisible();
  });

  it("has no Find more for a commenter", async () => {
    mount([], "comment");
    expect(screen.queryByRole("button", { name: "Find more" })).toBeNull();
    expect(loadPipelineConfig).not.toHaveBeenCalled();
  });
});
