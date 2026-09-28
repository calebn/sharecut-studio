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
import { formatAnalyzeFields } from "./pipelineAnalyzeFormat";

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

const mockState = {
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
};

vi.mock("../state/useDaw", () => ({
  useDaw: (sel: (s: typeof mockState) => unknown) => sel(mockState),
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

/** baseConfig plus a visible Master LUFS field under Balance tracks, so Analyze highlights can be asserted. */
function withMasterLufsParam() {
  const cfg = structuredClone(baseConfig);
  cfg.params.push({
    path: "master.integrated_lufs",
    label: "Master LUFS",
    description: "Master integrated loudness",
    type: "number",
    default: -16,
    minimum: -24,
    maximum: -9,
    unit: "LUFS",
    group: "common",
    section: "master",
    affects: ["balance_tracks"],
  });
  return cfg;
}

describe("PipelinePanel", () => {
  it("saves a vocabulary term and offers re-transcription through the pipeline", async () => {
    const user = userEvent.setup();
    render(<PipelinePanel />);
    await user.type(await screen.findByLabelText("Terms"), "Kaczynski{Enter}");
    await user.click(screen.getByRole("button", { name: "Save vocabulary" }));
    await waitFor(() =>
      expect(saveTranscriptVocabulary).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({ terms: ["Kaczynski"], base_revision: "r1" }),
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
        forceTranscribe: true,
        overwriteEdited: false,
      }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.projectPath = "/tmp/ep.project.json";
    dawState.pipelineJob = null;
    dawState.activityJob = null;
    loadPipelineConfig.mockResolvedValue(structuredClone(baseConfig));
    loadTranscriptVocabulary.mockResolvedValue({
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: false,
      edited_tracks: [],
    });
    saveTranscriptVocabulary.mockImplementation(async (_path, value) => ({
      terms: value.terms,
      guest_names: value.guest_names,
      revision: "r2",
      needs_retranscription: true,
      edited_tracks: [],
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
    expect(startPipelineRun.mock.calls[0][1].forceTranscribe).toBe(false);
    expect(startPipelineRun.mock.calls[0][1].overwriteEdited).toBe(false);
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

  it("downloads Whisper before re-transcribing when the model is missing", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const bootJob = {
      id: "boot1",
      kind: "bootstrap",
      components: ["whisper"],
      whisper_model: "large-v3-turbo",
      status: "ok",
      message: "Ready",
    };
    runBootstrap.mockResolvedValue({ job: bootJob });
    waitForBootstrapJob.mockResolvedValue(bootJob);
    const turboConfig = {
      ...structuredClone(baseConfig),
      config: { ...baseConfig.config, transcribe: { model: "large-v3-turbo" } },
    };
    const cachedModels = whisperModels.map((m) =>
      m.id === "large-v3-turbo" ? { ...m, cached: true } : m,
    );
    loadPipelineConfig
      .mockResolvedValueOnce(turboConfig)
      .mockResolvedValue({ ...turboConfig, whisper_models: cachedModels });
    putPipelineConfig.mockImplementation(async (_path, body) => ({
      ...turboConfig,
      ...body,
      config: body.config ?? turboConfig.config,
      whisper_models: cachedModels,
    }));
    loadTranscriptVocabulary.mockResolvedValue({
      terms: ["Kaczynski"],
      guest_names: [],
      revision: "r1",
      needs_retranscription: true,
      edited_tracks: ["host"],
    });
    render(<PipelinePanel />);
    await user.click(
      await screen.findByRole("button", { name: "Re-transcribe" }),
    );
    expect(
      await screen.findByRole("dialog", { name: /Download Whisper model/i }),
    ).toBeInTheDocument();
    expect(startPipelineRun).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(startPipelineRun).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({
          fromStep: "transcribe_tracks",
          forceTranscribe: true,
          overwriteEdited: true,
          enabledSteps: expect.arrayContaining(["transcribe_tracks"]),
        }),
      ),
    );
    expect(window.confirm).toHaveBeenCalledOnce();
    vi.mocked(window.confirm).mockRestore();
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

  function analyzeJobSnap(
    overrides: Partial<import("../types/pipeline").PipelineJobSnapshot> = {},
  ): import("../types/pipeline").PipelineJobSnapshot {
    return {
      id: "an-1",
      project_path: "/tmp/ep.project.json",
      from_step: null,
      only_step: null,
      kind: "analyze",
      label: "Analyze",
      status: "running",
      current: 1,
      total: 2,
      message: "Scanned host (1/2)",
      error: null,
      elapsed_sec: 3,
      steps: [],
      ...overrides,
    };
  }

  it("starts Analyze as a job and seeds Activity chrome", async () => {
    const user = userEvent.setup();
    analyzePipeline.mockImplementation(
      async (
        _path: string,
        opts: { onJob: (job: unknown) => void; signal?: AbortSignal },
      ) => {
        opts.onJob(
          analyzeJobSnap({ status: "queued", current: null, total: null }),
        );
        return {
          proposed_config: {},
          patches: {},
          reasons: [{ code: "hum", message: "host: mains hum", evidence: {} }],
          report_summary: { track_count: 1, reason_count: 1, tracks: [] },
          applied: true,
          config: structuredClone(baseConfig),
        };
      },
    );
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => {
      expect(analyzePipeline).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({
          apply: true,
          signal: expect.any(AbortSignal),
        }),
      );
    });
    expect(setActivityJob).toHaveBeenCalledWith(
      expect.objectContaining({ id: "an-1", kind: "analyze" }),
    );
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
  });

  it("shows a running Analyze job's per-track progress with Cancel", async () => {
    const user = userEvent.setup();
    dawState.activityJob = analyzeJobSnap();
    const { container } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getByText("Scanned host (1/2)")).toBeInTheDocument();
    });
    expect(screen.getByText("1/2 tracks")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      screen.queryByText(/Cancel frees the pipeline slot/i),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /run pipeline/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeDisabled();
    cancelPipelineRun.mockResolvedValue(
      analyzeJobSnap({ message: "Cancel requested…" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(cancelPipelineRun).toHaveBeenCalledWith("an-1");
    });
    await expectNoA11yViolations(container);
  });

  it("a cancelled Analyze applies nothing and re-enables Analyze", async () => {
    const user = userEvent.setup();
    analyzePipeline.mockResolvedValue(null);
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    });
    expect(
      screen.queryByText("Analyze suggestions applied"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(putPipelineConfig).not.toHaveBeenCalled();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
  });

  it("aborts the Analyze wait on project switch", async () => {
    const user = userEvent.setup();
    let captured: AbortSignal | undefined;
    analyzePipeline.mockImplementation(
      (
        _path: string,
        opts: { onJob: (job: unknown) => void; signal?: AbortSignal },
      ) =>
        new Promise(() => {
          captured = opts.signal;
        }),
    );
    const { rerender } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => {
      expect(captured).toBeInstanceOf(AbortSignal);
    });
    mockState.projectPath = "/tmp/other.project.json";
    rerender(<PipelinePanel />);
    await waitFor(() => {
      expect(captured?.aborted).toBe(true);
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

  it("renders Analyze evidence, a skip hint and per-track rows", async () => {
    const user = userEvent.setup();
    const withAlign = structuredClone(baseConfig);
    withAlign.steps.push({
      id: "align_tracks",
      index: 4,
      group: "transcript",
      title: "Align tracks",
      summary: "Align",
      kind: "tooling",
      depends_on: ["ingest_tracks"],
      requires_components: ["ffmpeg"],
      param_sections: [],
      enabled_by_default: true,
    });
    withAlign.enabled_steps = [...withAlign.enabled_steps, "align_tracks"];
    loadPipelineConfig.mockResolvedValue(withAlign);
    analyzePipeline.mockResolvedValue({
      proposed_config: {},
      patches: {},
      reasons: [
        {
          code: "pre_aligned",
          message: "Dialogue tracks guest, host all run 10.00s",
          evidence: { duration_sec: 10, tolerance_sec: 0.05 },
          suggested_skip_steps: ["align_tracks"],
        },
        {
          code: "digital_silence",
          message: "host: 85% of the source audio is digital silence",
          track_id: "host",
          evidence: { silent_fraction: 0.85, threshold_fraction: 0.8 },
        },
      ],
      report_summary: {
        track_count: 1,
        reason_count: 2,
        tracks: [
          {
            track_id: "host",
            noise_floor_db: -62.5,
            digital_silence_fraction: 0.85,
            bleed_ratio: null,
          },
        ],
      },
      applied: true,
      config: withAlign,
    });
    putPipelineConfig.mockImplementation(async (_path, body) => ({
      ...structuredClone(withAlign),
      config: body.config ?? withAlign.config,
      enabled_steps: body.enabled_steps ?? withAlign.enabled_steps,
    }));
    const { container } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByText("silent_fraction=0.85, threshold_fraction=0.8"),
    ).toBeInTheDocument();
    expect(screen.getByText("Per-track measurements (1)")).toBeInTheDocument();
    expect(
      screen.getByText(/noise_floor_db=-62\.5, digital_silence_fraction=0\.85/),
    ).toBeInTheDocument();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
    await expectNoA11yViolations(container);
    await user.click(
      screen.getByRole("button", { name: "Uncheck Align tracks" }),
    );
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalled();
    });
    const body = putPipelineConfig.mock.calls.at(-1)![1] as {
      enabled_steps: string[];
    };
    expect(body.enabled_steps).not.toContain("align_tracks");
    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "Enable Align tracks" }),
      ).toHaveFocus();
    });
    expect(
      screen.getByRole("checkbox", { name: "Enable Align tracks" }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Uncheck Align tracks" }),
    ).not.toBeInTheDocument();
  });

  it("drops an Analyze result that resolves after the project changed", async () => {
    const user = userEvent.setup();
    let resolveAnalyze!: (v: unknown) => void;
    analyzePipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolveAnalyze = r;
        }),
    );
    const { rerender } = render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    mockState.projectPath = "/tmp/other.project.json";
    rerender(<PipelinePanel />);
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenLastCalledWith(
        "/tmp/other.project.json",
      );
    });
    const staleConfig = structuredClone(baseConfig);
    staleConfig.enabled_steps = ["ingest_tracks"];
    await act(async () => {
      resolveAnalyze({
        proposed_config: {},
        patches: {},
        reasons: [
          {
            code: "hum",
            message: "host: mains hum from project A",
            evidence: {},
          },
        ],
        report_summary: {
          track_count: 1,
          reason_count: 1,
          tracks: [{ track_id: "host" }],
        },
        applied: true,
        config: staleConfig,
      });
    });
    expect(
      screen.queryByText("host: mains hum from project A"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Per-track measurements/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Enable Balance tracks" }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
  });

  it("keeps focus when a later write overtakes Uncheck Align tracks", async () => {
    const user = userEvent.setup();
    const withAlign = structuredClone(baseConfig);
    withAlign.steps.push({
      id: "align_tracks",
      index: 4,
      group: "transcript",
      title: "Align tracks",
      summary: "Align",
      kind: "tooling",
      depends_on: ["ingest_tracks"],
      requires_components: ["ffmpeg"],
      param_sections: [],
      enabled_by_default: true,
    });
    withAlign.enabled_steps = [...withAlign.enabled_steps, "align_tracks"];
    loadPipelineConfig.mockResolvedValue(withAlign);
    analyzePipeline.mockResolvedValue({
      proposed_config: {},
      patches: {},
      reasons: [
        {
          code: "pre_aligned",
          message: "Dialogue tracks guest, host all run 10.00s",
          evidence: { duration_sec: 10, tolerance_sec: 0.05 },
          suggested_skip_steps: ["align_tracks"],
        },
      ],
      report_summary: { track_count: 0, reason_count: 1, tracks: [] },
      applied: true,
      config: withAlign,
    });
    let resolveFirst!: (v: unknown) => void;
    putPipelineConfig
      .mockImplementationOnce(
        (_path, body) =>
          new Promise((r) => {
            resolveFirst = () =>
              r({
                ...structuredClone(withAlign),
                enabled_steps: body.enabled_steps,
              });
          }),
      )
      .mockImplementation(async (_path, body) => ({
        ...structuredClone(withAlign),
        config: body.config ?? withAlign.config,
        enabled_steps: body.enabled_steps ?? withAlign.enabled_steps,
      }));
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await screen.findByRole("button", { name: "Uncheck Align tracks" });
    await user.click(
      screen.getByRole("button", { name: "Uncheck Align tracks" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Enable Balance tracks" }),
    );
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      resolveFirst(undefined);
    });
    expect(
      screen.getByRole("checkbox", { name: "Enable Align tracks" }),
    ).not.toHaveFocus();
    expect(
      screen.getByRole("checkbox", { name: "Enable Align tracks" }),
    ).toBeChecked();
  });

  it("shows the server config when a param PUT resolves after the Analyze response", async () => {
    const user = userEvent.setup();
    const serverAfterPut = withMasterLufsParam();
    serverAfterPut.config.balance.dialogue_lufs = -18;
    const patched = withMasterLufsParam();
    patched.config.master.integrated_lufs = -14;
    loadPipelineConfig
      .mockResolvedValueOnce(withMasterLufsParam())
      .mockResolvedValueOnce(structuredClone(serverAfterPut));
    let resolveAnalyze!: (v: unknown) => void;
    analyzePipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolveAnalyze = r;
        }),
    );
    let resolvePut!: () => void;
    putPipelineConfig.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePut = () => r(structuredClone(serverAfterPut));
        }),
    );
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    fireEvent.change(screen.getByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveAnalyze({
        proposed_config: patched.config,
        patches: { master: { integrated_lufs: -14 } },
        reasons: [],
        report_summary: { track_count: 0, reason_count: 0, tracks: [] },
        applied: true,
        config: patched,
      });
    });
    // Analyze is free again once its result is shown, even while the PUT is pending.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    });
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvePut();
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    });
    // The PUT replaced Analyze's master patch, so that field is not highlighted.
    await waitFor(() => {
      expect(screen.getByLabelText(/Master LUFS/i)).toHaveValue(-16);
    });
    expect(
      screen.getByLabelText(/Master LUFS/i).closest("label"),
    ).not.toHaveClass("pipeline-param-highlight");
    await user.click(screen.getByRole("button", { name: "Run pipeline" }));
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalled();
    });
    expect(startPipelineRun.mock.calls[0][1].config).toEqual(
      serverAfterPut.config,
    );
  });

  it("re-reads the config when a param PUT resolves before the Analyze response", async () => {
    const user = userEvent.setup();
    const merged = withMasterLufsParam();
    merged.config.balance.dialogue_lufs = -18;
    merged.config.master.integrated_lufs = -14;
    loadPipelineConfig
      .mockResolvedValueOnce(withMasterLufsParam())
      .mockResolvedValueOnce(structuredClone(merged));
    let resolveAnalyze!: (v: unknown) => void;
    analyzePipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolveAnalyze = r;
        }),
    );
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    fireEvent.change(screen.getByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveAnalyze({
        proposed_config: merged.config,
        patches: { master: { integrated_lufs: -14 } },
        reasons: [],
        report_summary: { track_count: 0, reason_count: 0, tracks: [] },
        applied: true,
        config: merged,
      });
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
    });
    expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-18);
    // The server kept Analyze's master patch, so that field stays highlighted.
    expect(screen.getByLabelText(/Master LUFS/i)).toHaveValue(-14);
    expect(screen.getByLabelText(/Master LUFS/i).closest("label")).toHaveClass(
      "pipeline-param-highlight",
    );
    await user.click(screen.getByRole("button", { name: "Run pipeline" }));
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalled();
    });
    expect(startPipelineRun.mock.calls[0][1].config).toEqual(merged.config);
  });

  it("re-reads the config and keeps the save error when a param PUT rejects during Analyze", async () => {
    const user = userEvent.setup();
    // A distinct value proves the pane shows the re-read, not onParamChange's snapshot revert.
    const serverAfterReject = structuredClone(baseConfig);
    serverAfterReject.config.balance.dialogue_lufs = -21;
    serverAfterReject.config.master.integrated_lufs = -14;
    loadPipelineConfig
      .mockResolvedValueOnce(structuredClone(baseConfig))
      .mockResolvedValueOnce(structuredClone(serverAfterReject));
    let resolveAnalyze!: (v: unknown) => void;
    analyzePipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolveAnalyze = r;
        }),
    );
    let rejectPut!: (e: Error) => void;
    putPipelineConfig.mockImplementationOnce(
      () =>
        new Promise((_r, reject) => {
          rejectPut = reject;
        }),
    );
    render(<PipelinePanel />);
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    fireEvent.change(screen.getByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      resolveAnalyze({
        proposed_config: serverAfterReject.config,
        patches: { master: { integrated_lufs: -14 } },
        reasons: [],
        report_summary: { track_count: 0, reason_count: 0, tracks: [] },
        applied: true,
        config: serverAfterReject,
      });
    });
    await act(async () => {
      rejectPut(new Error("save failed"));
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-21);
    });
    expect(screen.getByText(/save failed/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled();
  });

  it("formatAnalyzeFields skips nulls and a given key", () => {
    expect(
      formatAnalyzeFields({ a: 1, b: null, c: [1, 2], d: "x" }, ["d"]),
    ).toBe("a=1, c=[1,2]");
  });
});
