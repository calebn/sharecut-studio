import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y";
import { PipelinePanel } from "./PipelinePanel";
import { TranscriptVocabularyEditor } from "./TranscriptVocabularyEditor";

const loadPipelineConfig = vi.fn();
const putPipelineConfig = vi.fn();
const analyzePipeline = vi.fn();
const startPipelineRun = vi.fn();
const cancelPipelineRun = vi.fn();
const runBootstrap = vi.fn();
const waitForBootstrapJob = vi.fn();
const loadTranscriptVocabulary = vi.fn();
const saveTranscriptVocabulary = vi.fn();

vi.mock("../api", () => ({
  loadPipelineConfig: (...args: unknown[]) => loadPipelineConfig(...args),
  putPipelineConfig: (...args: unknown[]) => putPipelineConfig(...args),
  analyzePipeline: (...args: unknown[]) => analyzePipeline(...args),
  startPipelineRun: (...args: unknown[]) => startPipelineRun(...args),
  cancelPipelineRun: (...args: unknown[]) => cancelPipelineRun(...args),
  runBootstrap: (...args: unknown[]) => runBootstrap(...args),
  waitForBootstrapJob: (...args: unknown[]) => waitForBootstrapJob(...args),
  loadTranscriptVocabulary: (...args: unknown[]) =>
    loadTranscriptVocabulary(...args),
  saveTranscriptVocabulary: (...args: unknown[]) =>
    saveTranscriptVocabulary(...args),
}));

const setPipelineJob = vi.fn();
const setActivityJob = vi.fn();
const setActiveTab = vi.fn();

const dawState = vi.hoisted(() => ({
  pipelineJob: null as import("../types/pipeline").PipelineJobSnapshot | null,
  activityJob: null as import("../types/pipeline").PipelineJobSnapshot | null,
}));

vi.mock("../state/useDaw", () => ({
  useDaw: () => ({
    projectPath: "/tmp/ep.project.json",
    get pipelineJob() {
      return dawState.pipelineJob;
    },
    get activityJob() {
      return dawState.activityJob;
    },
    setPipelineJob,
    setActivityJob,
    setActiveTab,
    sessionClients: [],
  }),
}));

const whisperModels = [
  {
    id: "small.en",
    label: "Balanced (English)",
    size: "~500 MB",
    description: "Cached laptop default.",
    cached: true,
  },
  {
    id: "large-v3-turbo",
    label: "Recommended",
    size: "~1.6 GB",
    description: "Lowest practical error.",
    cached: false,
  },
];

const baseConfig = {
  defaults: {
    balance: { dialogue_lufs: -20 },
    master: { integrated_lufs: -16 },
    transcribe: { model: "small.en" },
  },
  config: {
    balance: { dialogue_lufs: -20 },
    master: { integrated_lufs: -16 },
    transcribe: { model: "small.en" },
  },
  enabled_steps: ["ingest_tracks", "balance_tracks", "export_deliverables"],
  unattended: true,
  steps: [
    {
      id: "ingest_tracks",
      index: 0,
      group: "transcript",
      title: "Ingest tracks",
      summary: "Probe audio",
      kind: "tooling",
      depends_on: [],
      requires_components: ["ffmpeg"],
      param_sections: [],
      enabled_by_default: true,
    },
    {
      id: "transcribe_tracks",
      index: 1,
      group: "transcript",
      title: "Transcribe tracks",
      summary: "Whisper ASR",
      kind: "tooling",
      depends_on: ["ingest_tracks"],
      requires_components: ["whisper"],
      param_sections: ["transcribe"],
      enabled_by_default: true,
    },
    {
      id: "balance_tracks",
      index: 2,
      group: "mix",
      title: "Balance tracks",
      summary: "LUFS staging",
      kind: "tooling",
      depends_on: ["clean_audio"],
      requires_components: ["ffmpeg"],
      param_sections: ["balance"],
      enabled_by_default: true,
    },
    {
      id: "export_deliverables",
      index: 3,
      group: "mix",
      title: "Export deliverables",
      summary: "Export",
      kind: "tooling",
      depends_on: ["master_loudness"],
      requires_components: ["ffmpeg"],
      param_sections: ["export"],
      enabled_by_default: true,
    },
  ],
  params: [
    {
      path: "balance.dialogue_lufs",
      label: "Dialogue LUFS",
      description: "Target integrated loudness",
      type: "number",
      default: -20,
      minimum: -30,
      maximum: -10,
      unit: "LUFS",
      group: "common",
      section: "balance",
      affects: ["balance_tracks"],
    },
    {
      path: "transcribe.model",
      label: "Whisper model",
      description: "faster-whisper size id",
      type: "enum",
      default: "small.en",
      enum: ["small.en", "large-v3-turbo"],
      group: "common",
      section: "transcribe",
      affects: ["transcribe_tracks"],
    },
  ],
  components: {
    ffmpeg: { ok: true },
    whisper: { ok: true },
    rnnoise: { ok: false, hint: "missing" },
  },
  step_names: [
    "ingest_tracks",
    "transcribe_tracks",
    "balance_tracks",
    "export_deliverables",
  ],
  whisper_models: whisperModels,
};

function withTranscribeEnabled(overrides: Record<string, unknown> = {}) {
  return {
    ...structuredClone(baseConfig),
    enabled_steps: [
      "ingest_tracks",
      "transcribe_tracks",
      "balance_tracks",
      "export_deliverables",
    ],
    ...overrides,
  };
}

describe("PipelinePanel", () => {
  it("keeps unsaved vocabulary when transcription refreshes", async () => {
    const user = userEvent.setup();
    const props = {
      projectPath: "/tmp/ep.project.json",
      busy: false,
      onRetranscribe: vi.fn(),
    };
    const { rerender } = render(
      <TranscriptVocabularyEditor {...props} refreshKey="" />,
    );
    await user.type(
      await screen.findByLabelText("Terms"),
      "Unpublished{Enter}",
    );
    loadTranscriptVocabulary.mockResolvedValue({
      terms: ["Published"],
      guest_names: [],
      needs_retranscription: false,
    });
    rerender(<TranscriptVocabularyEditor {...props} refreshKey="job-1" />);
    expect(await screen.findByText("Unpublished")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save vocabulary" }),
    ).toBeEnabled();
  });
  it("saves a vocabulary term and offers re-transcription through the pipeline", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await user.type(await screen.findByLabelText("Terms"), "Kaczynski{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    await waitFor(() =>
      expect(saveTranscriptVocabulary).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({ terms: ["Kaczynski"] }),
      ),
    );
    await user.click(
      await screen.findByRole("button", { name: "Re-transcribe" }),
    );
    expect(startPipelineRun).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        fromStep: "transcribe_tracks",
        enabledSteps: expect.arrayContaining(["transcribe_tracks"]),
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dawState.pipelineJob = null;
    dawState.activityJob = null;
    loadPipelineConfig.mockResolvedValue(structuredClone(baseConfig));
    loadTranscriptVocabulary.mockResolvedValue({
      terms: [],
      guest_names: [],
      needs_retranscription: false,
    });
    saveTranscriptVocabulary.mockImplementation(async (_path, value) => ({
      ...value,
      needs_retranscription: true,
    }));
    putPipelineConfig.mockImplementation(async (_path, body) => ({
      ...structuredClone(baseConfig),
      ...body,
      config: body.config ?? baseConfig.config,
      enabled_steps: body.enabled_steps ?? baseConfig.enabled_steps,
      unattended: body.unattended ?? baseConfig.unattended,
      whisper_models: body.whisper_models ?? baseConfig.whisper_models,
    }));
    startPipelineRun.mockResolvedValue({
      id: "job1",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "running",
      current: 0,
      total: 3,
      message: "Running",
      error: null,
      elapsed_sec: 0,
      steps: [],
    });
  });

  it("loads config and runs with visible values", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Missing rnnoise/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run pipeline" }));
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalled();
    });
    expect(startPipelineRun.mock.calls[0][1].unattended).toBe(true);
    expect(startPipelineRun.mock.calls[0][1].enabledSteps).toContain(
      "balance_tracks",
    );
  });

  it("has no axe violations on loaded panel", async () => {
    const { container } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await expectNoA11yViolations(container);
  });

  it("rolls back param edit when the latest PUT fails", async () => {
    const user = userEvent.setup();
    putPipelineConfig.mockRejectedValue(new Error("save failed"));
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    const input = screen.getByLabelText(/Dialogue LUFS/i);
    expect(input).toHaveValue(-20);
    fireEvent.change(input, { target: { value: "-18" } });
    await waitFor(() => {
      expect(screen.getByText(/save failed/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-20);
  });

  it("shows Downloaded / Needs download chrome on Whisper options", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    const select = await screen.findByLabelText(/Whisper model/i);
    expect(select).toBeInTheDocument();
    const options = Array.from(
      (select as HTMLSelectElement).querySelectorAll("option"),
    ).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("Downloaded"))).toBe(true);
    expect(options.some((t) => t.includes("Needs download"))).toBe(true);
    expect(screen.getByText(/is downloaded/i)).toBeInTheDocument();
  });

  it("opens download dialog for missing model and Cancel reverts", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    const select = await screen.findByLabelText(/Whisper model/i);
    await user.selectOptions(select, "large-v3-turbo");
    const dialog = await screen.findByRole("dialog", {
      name: /Download Whisper model/i,
    });
    expect(dialog).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(select).toHaveValue("small.en");
    expect(putPipelineConfig).not.toHaveBeenCalled();
  });

  it("defers missing model selection without starting bootstrap", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    const select = await screen.findByLabelText(/Whisper model/i);
    await user.selectOptions(select, "large-v3-turbo");
    await user.click(
      await screen.findByRole("button", { name: /Use without downloading/i }),
    );
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalled();
    });
    expect(runBootstrap).not.toHaveBeenCalled();
    const body = putPipelineConfig.mock.calls.at(-1)?.[1] as {
      config: { transcribe: { model: string } };
    };
    expect(body.config.transcribe.model).toBe("large-v3-turbo");
  });

  it("blocks Run until Whisper weights exist when transcribe is enabled", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(
      withTranscribeEnabled({
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
        components: {
          ffmpeg: { ok: true },
          whisper: { ok: false, hint: "not downloaded" },
          rnnoise: { ok: true },
        },
      }),
    );
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Run pipeline" }),
      ).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "Run pipeline" }));
    expect(
      await screen.findByRole("dialog", { name: /Download Whisper model/i }),
    ).toBeInTheDocument();
    expect(startPipelineRun).not.toHaveBeenCalled();
  });

  it("downloads via bootstrap then persists the selected model", async () => {
    const user = userEvent.setup();
    runBootstrap.mockResolvedValue({
      job: {
        id: "boot1",
        kind: "bootstrap",
        components: ["whisper"],
        whisper_model: "large-v3-turbo",
        status: "running",
        message: "Fetching weights…",
      },
    });
    waitForBootstrapJob.mockImplementation(async (_id, opts) => {
      opts?.onUpdate?.({
        id: "boot1",
        kind: "bootstrap",
        components: ["whisper"],
        whisper_model: "large-v3-turbo",
        status: "running",
        message: "Fetching weights…",
      });
      return {
        id: "boot1",
        kind: "bootstrap",
        components: ["whisper"],
        whisper_model: "large-v3-turbo",
        status: "ok",
        message: "Ready",
      };
    });
    putPipelineConfig.mockImplementation(async (_path, body) => ({
      ...structuredClone(baseConfig),
      ...body,
      config: body.config ?? baseConfig.config,
      whisper_models: whisperModels.map((m) =>
        m.id === "large-v3-turbo" ? { ...m, cached: true } : m,
      ),
    }));
    loadPipelineConfig
      .mockResolvedValueOnce(structuredClone(baseConfig))
      .mockResolvedValue({
        ...structuredClone(baseConfig),
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
        whisper_models: whisperModels.map((m) =>
          m.id === "large-v3-turbo" ? { ...m, cached: true } : m,
        ),
      });

    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    const select = await screen.findByLabelText(/Whisper model/i);
    await user.selectOptions(select, "large-v3-turbo");
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => {
      expect(runBootstrap).toHaveBeenCalledWith({
        components: ["whisper"],
        whisper_model: "large-v3-turbo",
      });
    });
    await waitFor(() => {
      expect(waitForBootstrapJob).toHaveBeenCalledWith(
        "boot1",
        expect.any(Object),
      );
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(putPipelineConfig).toHaveBeenCalled();
  });

  it("shows alignment leave-gate waiting copy", async () => {
    loadPipelineConfig.mockResolvedValue({
      ...structuredClone(baseConfig),
      unattended: false,
    });
    dawState.pipelineJob = {
      id: "job-align",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "error",
      current: 2,
      total: 4,
      message: null,
      error: "Conversation alignment needs review before stems/reconcile.",
      elapsed_sec: 1,
      steps: [
        {
          name: "require_align_accept",
          status: "error",
          elapsed_sec: 0.1,
          error: "Conversation alignment needs review before stems/reconcile.",
        },
      ],
    };
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(
        screen.getByText(/Waiting on conversation alignment/i),
      ).toBeInTheDocument();
    });
    expect(
      screen
        .getByText(/Waiting on conversation alignment/i)
        .closest('[role="status"]'),
    ).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("failed");
    expect(
      screen.queryByText(/Waiting on transcript refine/i),
    ).not.toBeInTheDocument();
  });

  it("does not show alignment waiting copy for unrelated alignment errors", async () => {
    loadPipelineConfig.mockResolvedValue({
      ...structuredClone(baseConfig),
      unattended: false,
    });
    dawState.pipelineJob = {
      id: "job-align-err",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "error",
      current: 2,
      total: 4,
      message: null,
      error: "align_tracks failed: missing alignment artifact",
      elapsed_sec: 1,
      steps: [
        {
          name: "align_tracks",
          status: "error",
          elapsed_sec: 0.1,
          error: "align_tracks failed: missing alignment artifact",
        },
      ],
    };
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run pipeline/i }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByText(/Waiting on conversation alignment/i),
    ).not.toBeInTheDocument();
  });

  it("shows refine leave-gate waiting copy", async () => {
    loadPipelineConfig.mockResolvedValue({
      ...structuredClone(baseConfig),
      unattended: false,
    });
    dawState.pipelineJob = {
      id: "job-refine",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "error",
      current: 2,
      total: 4,
      message: null,
      error: "Transcript refine is required before focus/tighten/NL edits.",
      elapsed_sec: 1,
      steps: [
        {
          name: "require_transcript_refine",
          status: "error",
          elapsed_sec: 0.1,
          error: "Transcript refine is required before focus/tighten/NL edits.",
        },
      ],
    };
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(
        screen.getByText(/Waiting on transcript refine/i),
      ).toBeInTheDocument();
    });
  });

  it("shows determinate progressbar only when total is set", async () => {
    dawState.pipelineJob = {
      id: "job-det",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "running",
      current: 1,
      total: 4,
      message: "Running balance_tracks",
      error: null,
      elapsed_sec: 5,
      steps: [],
    };
    const { container, rerender } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("Running balance_tracks")).toBeInTheDocument();
    });
    const bar = screen.getByRole("progressbar", {
      name: "Running balance_tracks",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(screen.getByText("1/4 steps")).toBeInTheDocument();
    expect(screen.getByTestId("pipeline-pulse")).toBeInTheDocument();
    const live = screen.getByRole("status");
    expect(live.getAttribute("aria-busy")).toBe("true");
    expect(live.textContent).toContain("Running balance_tracks");
    expect(live.textContent).not.toMatch(/Elapsed/);
    expect(screen.getByText(/Elapsed 0:05/)).toBeInTheDocument();
    await expectNoA11yViolations(container);

    dawState.pipelineJob = {
      ...dawState.pipelineJob!,
      current: null,
      total: null,
      message: "Mixing music bed",
    };
    rerender(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("Mixing music bed")).toBeInTheDocument();
    });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+\/\?/)).not.toBeInTheDocument();
    expect(screen.getByTestId("pipeline-pulse")).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("labels cancelled distinctly from failed in the live summary", async () => {
    dawState.pipelineJob = {
      id: "job-cancel",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "cancelled",
      current: 1,
      total: 3,
      message: "Stopped by user",
      error: null,
      elapsed_sec: 2,
      steps: [],
    };
    const { rerender } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("cancelled")).toBeInTheDocument();
    });
    expect(screen.getByText("Stopped by user")).toBeInTheDocument();
    expect(screen.queryByText("failed")).not.toBeInTheDocument();

    dawState.pipelineJob = {
      ...dawState.pipelineJob!,
      status: "error",
      message: "Step exploded",
      error: "boom",
    };
    rerender(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("failed")).toBeInTheDocument();
    });
    expect(screen.queryByText("cancelled")).not.toBeInTheDocument();
  });

  it("disables Run and shows Cancel while bounce occupies the pipeline slot", async () => {
    const user = userEvent.setup();
    dawState.pipelineJob = {
      id: "old-pipe",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      kind: "pipeline",
      status: "ok",
      current: 3,
      total: 3,
      message: "Pipeline complete",
      error: null,
      elapsed_sec: 9,
      steps: [],
    };
    dawState.activityJob = {
      id: "bounce-1",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      kind: "bounce",
      label: "Bounce",
      status: "running",
      current: 1,
      total: 4,
      message: "Mixing bounce…",
      error: null,
      elapsed_sec: 2,
      steps: [],
    };
    cancelPipelineRun.mockResolvedValue({
      ...dawState.activityJob,
      status: "cancelled",
      message: "Bounce cancelled",
    });
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /run pipeline/i }),
      ).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getByText(/Bounce is running. Cancel frees the pipeline slot/i),
    ).toBeTruthy();
    expect(screen.queryByText("Pipeline complete")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(cancelPipelineRun).toHaveBeenCalledWith("bounce-1");
    });
  });

  it("keeps ticking last-update copy outside the live region", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-09-18T12:00:00Z"));
    const t0 = Date.now() / 1000;
    dawState.pipelineJob = {
      id: "job-stale",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      status: "running",
      current: null,
      total: null,
      message: "Aligning conversation",
      error: null,
      elapsed_sec: 12,
      last_progress_at: t0,
      steps: [],
    };
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("Aligning conversation")).toBeInTheDocument();
    });
    const live = screen.getByRole("status");
    expect(live.textContent).not.toContain("last update");
    expect(screen.queryByText(/last update/)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(screen.getByText("last update 16s ago")).toBeInTheDocument();
    expect(live.textContent).not.toContain("last update");
    expect(live.textContent).toContain("Aligning conversation");
    expect(screen.getByText("Progress stalled")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText("last update 17s ago")).toBeInTheDocument();
    expect(live.textContent).not.toContain("last update");
  });
});
