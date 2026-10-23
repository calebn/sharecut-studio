import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Answer, Question } from "../feedback/ask";
import { ModelsContext } from "../models/useModels";
import { expectNoA11yViolations } from "../test/a11y";
import { answerQuestions } from "../test/ask";
import {
  modelStatus,
  modelsApi,
  modelsWrapper,
  registryRows,
} from "../test/renderWithModels";
import type { PipelineConfigResponse } from "../types/pipeline";
import { ApiError } from "../utils/apiError";
import { PipelinePanel } from "./PipelinePanel";
import { formatAnalyzeFields } from "./pipelineAnalyzeFormat";

function modelNeeded(id: string, label: string, variant: string | null) {
  return new ApiError(`Needs ${label}.`, "model_needed", 409, {
    id,
    variant,
    label,
    purpose: "transcription",
    size: "~1 MB",
    sizeBytes: null,
    state: "missing",
  });
}

const confirmReply = vi.fn<(question: Question) => Answer>();

/** The panel reads model downloads from the models controller; this one hands out `downloadModel`. */
function render(ui: ReactElement, installed: string[] = ["word-aligner"]) {
  return rtlRender(ui, {
    wrapper: modelsWrapper(
      modelsApi({
        status: modelStatus(
          registryRows().map((r) =>
            installed.includes(r.id) ? { ...r, state: "installed" } : r,
          ),
        ),
        download: downloadModel,
      }),
    ),
  });
}

const loadPipelineConfig = vi.fn();
const putPipelineConfig = vi.fn();
const analyzePipeline = vi.fn();
const startPipelineRun = vi.fn();
const cancelPipelineRun = vi.fn();
const downloadModel = vi.fn();
const loadTranscriptVocabulary = vi.fn();
const saveTranscriptVocabulary = vi.fn();
const waitForPipelineJob = vi.fn();

vi.mock("../api", () => ({
  loadPipelineConfig: (...args: unknown[]) => loadPipelineConfig(...args),
  putPipelineConfig: (...args: unknown[]) => putPipelineConfig(...args),
  analyzePipeline: (...args: unknown[]) => analyzePipeline(...args),
  startPipelineRun: (...args: unknown[]) => startPipelineRun(...args),
  cancelPipelineRun: (...args: unknown[]) => cancelPipelineRun(...args),
  loadTranscriptVocabulary: (...args: unknown[]) =>
    loadTranscriptVocabulary(...args),
  saveTranscriptVocabulary: (...args: unknown[]) =>
    saveTranscriptVocabulary(...args),
  waitForPipelineJob: (...args: unknown[]) => waitForPipelineJob(...args),
  ANALYZE_WAIT_MS: 21_600_000,
}));

const setPipelineJob = vi.fn();
const setActivityJob = vi.fn();
const setActiveTab = vi.fn();

const dawState = vi.hoisted(() => ({
  pipelineJob: null as import("../types/pipeline").PipelineJobSnapshot | null,
  activityJob: null as import("../types/pipeline").PipelineJobSnapshot | null,
}));

let shellBreakpoint: "desktop" | "phone" = "desktop";

const mockState = {
  get shellBreakpoint() {
    return shellBreakpoint;
  },
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
    ffmpeg: { state: "installed" },
    whisper: { state: "installed" },
    rnnoise: { state: "missing", hint: "missing" },
  },
  forced_alignment: {
    enabled: false,
    model: null,
    requested: null,
    installed: false,
    blocked: false,
    reason: "",
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

/**
 * baseConfig plus the Precise word boundaries field, the word-aligner component status
 * and the host's resolved `forced_alignment` (#780): `requested` is the raw config value
 * (null = unset, follows the model), `installed` whether the snapshot is downloaded.
 */
function alignerConfig(
  requested: boolean | null,
  installed: boolean,
): import("../types/pipeline").PipelineConfigResponse {
  const cfg = structuredClone(
    baseConfig,
  ) as unknown as import("../types/pipeline").PipelineConfigResponse;
  cfg.params.push({
    path: "transcribe.forced_alignment.enabled",
    label: "Precise word boundaries",
    description: "Re-time Whisper's words with a local forced aligner.",
    type: "boolean",
    default: null,
    group: "advanced",
    section: "transcribe",
    affects: ["transcribe_tracks"],
  });
  cfg.config = {
    ...cfg.config,
    transcribe: {
      ...(cfg.config.transcribe as Record<string, unknown>),
      forced_alignment: { enabled: requested },
    },
  };
  cfg.components = {
    ...cfg.components,
    "word-aligner": {
      state: installed ? "installed" : "missing",
      tier: "offered",
      size: "~360 MB",
      hint: "Word aligner (~360 MB) is not downloaded; Precise word boundaries is unavailable and words keep Whisper's times until it is. Download it next to that field in the Pipeline tab",
      bootstrap: "podcast bootstrap --component word-aligner",
    },
  };
  const enabled = installed && requested !== false;
  const missing =
    "word aligner 'onnx-base' is not downloaded (podcast bootstrap --component word-aligner)";
  let reason: string;
  if (requested === false) {
    reason = "off: transcribe.forced_alignment.enabled is false";
  } else if (requested === true) {
    reason = installed
      ? "on: transcribe.forced_alignment.enabled is true"
      : `blocked: transcribe.forced_alignment.enabled is true but ${missing}`;
  } else {
    reason = installed
      ? "on by default: word aligner 'onnx-base' is installed"
      : `unavailable: ${missing}`;
  }
  cfg.forced_alignment = {
    enabled,
    model: enabled ? "onnx-base" : null,
    requested,
    installed,
    blocked: requested === true && !installed,
    reason,
  };
  return cfg;
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
  it("keeps shortcuts accessible and retains form and disclosure state on rerender", async () => {
    const { container, rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await screen.findByRole("button", { name: "Balance tracks" });
    const summary = screen.getByText("From / Only shortcuts", { exact: true });
    await userEvent.click(summary);
    const only = screen.getByRole("combobox", { name: "Only step" });
    await userEvent.selectOptions(only, "transcribe_tracks");
    only.focus();
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(screen.getByRole("combobox", { name: "Only step" })).toBe(only);
    expect(only).toHaveFocus();
    expect(only).toHaveValue("transcribe_tracks");
    expect(screen.getByText("From / Only shortcuts", { exact: true })).toBe(
      summary,
    );
    expect(summary.closest("details")).toHaveAttribute("open");
    await expectNoA11yViolations(container);
  });

  it("merges a parameter edit into the latest working set", async () => {
    const initial: Omit<typeof baseConfig, "config" | "defaults"> &
      Pick<PipelineConfigResponse, "config" | "defaults"> =
      structuredClone(baseConfig);
    initial.config = {
      ...initial.config,
      tighten: { intensity: "medium" },
    };
    initial.defaults = {
      ...initial.defaults,
      tighten: { intensity: "medium" },
    };
    const external = structuredClone(initial);
    external.config = {
      ...external.config,
      tighten: { intensity: "light" },
    };
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(external);
    putPipelineConfig.mockImplementationOnce(async (_path, body) => ({
      ...external,
      ...body,
      config: body.config ?? external.config,
      enabled_steps: body.enabled_steps ?? external.enabled_steps,
      unattended: body.unattended ?? external.unattended,
    }));

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const dialogueTarget = await screen.findByDisplayValue("-20");
    fireEvent.change(dialogueTarget, { target: { value: "-18" } });

    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(putPipelineConfig).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        config: expect.objectContaining({
          balance: expect.objectContaining({ dialogue_lufs: -18 }),
          tighten: { intensity: "light" },
        }),
      }),
    );
  });

  it("serializes overlapping edits before refetching each working set", async () => {
    const initial = withMasterLufsParam();
    const afterFirstSave = structuredClone(initial);
    afterFirstSave.config.balance.dialogue_lufs = -18;
    let resolveFirstSave!: (value: typeof initial) => void;
    const deferredFirstSave = new Promise<typeof initial>((resolve) => {
      resolveFirstSave = resolve;
    });
    putPipelineConfig
      .mockReset()
      .mockImplementationOnce(() => deferredFirstSave);
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(afterFirstSave);
    putPipelineConfig.mockImplementationOnce(async (_path, body) => ({
      ...afterFirstSave,
      ...body,
      config: body.config ?? afterFirstSave.config,
      enabled_steps: body.enabled_steps ?? afterFirstSave.enabled_steps,
    }));

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    fireEvent.change(await screen.findByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText(/Master LUFS/i), {
      target: { value: "-14" },
    });
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveFirstSave(afterFirstSave);
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(2));
    expect(putPipelineConfig).toHaveBeenLastCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        config: expect.objectContaining({
          balance: expect.objectContaining({ dialogue_lufs: -18 }),
          master: expect.objectContaining({ integrated_lufs: -14 }),
        }),
      }),
    );
    expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-18);
    expect(screen.getByLabelText(/Master LUFS/i)).toHaveValue(-14);
  });

  it("lets an in-flight edit finish before Analyze refetches the working set", async () => {
    const initial = withMasterLufsParam();
    const afterSave = structuredClone(initial);
    afterSave.config.balance.dialogue_lufs = -18;
    let resolveFresh!: (value: PipelineConfigResponse) => void;
    const delayedFresh = new Promise<PipelineConfigResponse>((resolve) => {
      resolveFresh = resolve;
    });
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => delayedFresh)
      .mockResolvedValueOnce(afterSave);
    putPipelineConfig.mockImplementationOnce(async (_path, body) => ({
      ...afterSave,
      ...body,
      config: body.config ?? afterSave.config,
      enabled_steps: body.enabled_steps ?? afterSave.enabled_steps,
      unattended: body.unattended ?? afterSave.unattended,
    }));
    analyzePipeline.mockResolvedValueOnce({
      proposed_config: {},
      patches: {},
      reasons: [{ code: "complete", message: "analysis complete" }],
      report_summary: { track_count: 0, reason_count: 1, tracks: [] },
      applied: true,
      config: initial,
    });

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    fireEvent.change(await screen.findByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => expect(loadPipelineConfig).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() =>
      expect(
        screen.getByText("Analyze suggestions applied"),
      ).toBeInTheDocument(),
    );
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    expect(putPipelineConfig).not.toHaveBeenCalled();

    await act(async () => {
      resolveFresh(initial as PipelineConfigResponse);
    });
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(putPipelineConfig).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        config: expect.objectContaining({
          balance: expect.objectContaining({ dialogue_lufs: -18 }),
        }),
      }),
    );
    await waitFor(() => expect(loadPipelineConfig).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-18);
  });

  it("derives a coupled step edit from the latest working set", async () => {
    const user = userEvent.setup();
    const tightenStep = {
      id: "tighten_from_transcript",
      index: 4,
      group: "editorial",
      title: "Tighten from transcript",
      summary: "Tighten dialogue",
      kind: "tooling",
      depends_on: [],
      requires_components: [],
      param_sections: [],
      enabled_by_default: true,
    };
    const initial = {
      ...structuredClone(baseConfig),
      steps: [...structuredClone(baseConfig.steps), tightenStep],
      enabled_steps: [...baseConfig.enabled_steps, tightenStep.id],
      config: {
        ...baseConfig.config,
        tighten: { enabled: true, intensity: "medium" },
      },
    };
    const external = {
      ...initial,
      config: {
        ...initial.config,
        tighten: { enabled: true, intensity: "light" },
      },
    };
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(external);
    putPipelineConfig.mockImplementationOnce(async (_path, body) => ({
      ...external,
      ...body,
      config: body.config ?? external.config,
      enabled_steps: body.enabled_steps ?? external.enabled_steps,
    }));

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Enable Tighten from transcript",
      }),
    );

    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    expect(putPipelineConfig).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        enabled_steps: expect.not.arrayContaining([tightenStep.id]),
        config: expect.objectContaining({
          tighten: { enabled: false, intensity: "light" },
        }),
      }),
    );
  });

  it("unchecking Apply sound actions sets its own setting and leaves tighten.enabled", async () => {
    const user = userEvent.setup();
    const soundStep = {
      id: "apply_sound_actions",
      index: 5,
      group: "editorial",
      title: "Apply sound actions",
      summary: "Apply each non-speech sound's suggested action",
      kind: "heuristic",
      depends_on: [],
      requires_components: [],
      param_sections: [],
      enabled_by_default: true,
    };
    const initial = {
      ...structuredClone(baseConfig),
      steps: [...structuredClone(baseConfig.steps), soundStep],
      enabled_steps: [...baseConfig.enabled_steps, soundStep.id],
      config: {
        ...baseConfig.config,
        tighten: { enabled: false, apply_non_speech: true },
      },
    };
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial);
    putPipelineConfig.mockImplementationOnce(async (_path, body) => ({
      ...initial,
      ...body,
      config: body.config ?? initial.config,
      enabled_steps: body.enabled_steps ?? initial.enabled_steps,
    }));

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(
      await screen.findByRole("checkbox", {
        name: "Enable Apply sound actions",
      }),
    );

    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(putPipelineConfig).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        enabled_steps: expect.not.arrayContaining([soundStep.id]),
        config: expect.objectContaining({
          tighten: { enabled: false, apply_non_speech: false },
        }),
      }),
    );
  });

  it("refetches before changing unattended mode", async () => {
    const user = userEvent.setup();
    loadPipelineConfig
      .mockReset()
      .mockResolvedValueOnce(structuredClone(baseConfig))
      .mockResolvedValueOnce({
        ...structuredClone(baseConfig),
        config: {
          ...baseConfig.config,
          tighten: { intensity: "light" },
        },
      });

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await screen.findByDisplayValue("-20");
    await user.selectOptions(screen.getByLabelText("Mode"), "gates");

    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    expect(putPipelineConfig).toHaveBeenCalledWith("/tmp/ep.project.json", {
      unattended: false,
    });
  });

  it("saves a vocabulary term and offers re-transcription through the pipeline", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    shellBreakpoint = "desktop";
    vi.clearAllMocks();
    downloadModel.mockResolvedValue({ kind: "ok" });
    waitForPipelineJob.mockReset();
    // A running Analyze from another viewer stays running unless a test finishes it.
    waitForPipelineJob.mockImplementation(() => new Promise(() => {}));
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

  it("opens phone step parameters with shared modal focus and restores the trigger", async () => {
    shellBreakpoint = "phone";
    const user = userEvent.setup();
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const trigger = await screen.findByRole("button", {
      name: "Balance tracks",
    });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Step parameters" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Close$/ })).toHaveFocus(),
    );
    await expectNoA11yViolations(dialog);
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Step parameters" }),
    ).toBeNull();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("loads config and runs with visible values", async () => {
    const user = userEvent.setup();
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    expect(startPipelineRun.mock.calls[0][1].retimeWords).toBe(false);
    expect(startPipelineRun.mock.calls[0][1].overwriteEdited).toBe(false);
    expect(startPipelineRun.mock.calls[0][1].enabledSteps).toContain(
      "balance_tracks",
    );
  });

  it("does not list the missing aligner while Precise word boundaries is off", async () => {
    loadPipelineConfig.mockResolvedValue(alignerConfig(false, false));
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/Missing word-aligner/i)).not.toBeInTheDocument();
  });

  it("lists the missing aligner while Precise word boundaries is on", async () => {
    loadPipelineConfig.mockResolvedValue(alignerConfig(true, false));
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/Missing word-aligner/i)).toBeInTheDocument();
  });

  it("shows the aligner badge and downloads it next to the field", async () => {
    const user = userEvent.setup();
    loadPipelineConfig
      .mockResolvedValueOnce(alignerConfig(true, false))
      .mockResolvedValue(alignerConfig(true, true));
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    expect(
      await screen.findByText(/Word aligner needs download/i),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Download word aligner" }),
    );
    await waitFor(() => {
      expect(downloadModel).toHaveBeenCalledWith(["word-aligner"], undefined);
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByRole("button", { name: "Re-time words" }),
    ).toBeInTheDocument();
  });

  it("refetches the config when a download the panel did not start finishes", async () => {
    const user = userEvent.setup();
    loadPipelineConfig
      .mockResolvedValueOnce(alignerConfig(true, false))
      .mockResolvedValue(alignerConfig(true, true));
    const missing = modelsApi({ status: modelStatus(registryRows()) });
    const installedRows = registryRows().map((r) =>
      r.id === "word-aligner" ? { ...r, state: "installed" as const } : r,
    );
    const installed = modelsApi({ status: modelStatus(installedRows) });
    const ui = (api: typeof missing) => (
      <ModelsContext.Provider value={api}>
        <main>
          <PipelinePanel />
        </main>
      </ModelsContext.Provider>
    );
    const { rerender } = rtlRender(ui(missing));
    await user.click(
      await screen.findByRole("button", { name: "Transcribe tracks" }),
    );
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    expect(
      await screen.findByText(/Word aligner needs download/i),
    ).toBeInTheDocument();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
    rerender(ui(installed));
    expect(
      await screen.findByText(/Word aligner is downloaded/i),
    ).toBeInTheDocument();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
  });

  it("locks Precise word boundaries off with the download when the aligner is missing", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(null, false));
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));

    const toggle = await screen.findByLabelText(/Precise word boundaries/i);
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      /Precise word boundaries unavailable: word aligner 'onnx-base' is not downloaded \(podcast bootstrap --component word-aligner\)\./,
    );
    expect(
      screen.getByText(
        /Precise word boundaries unavailable: word aligner 'onnx-base' is not downloaded \(podcast bootstrap --component word-aligner\)/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download word aligner" }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Re-time words" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Missing word-aligner/i)).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("lets a person turn off a saved blocked alignment request", async () => {
    const user = userEvent.setup();
    const initialConfig = alignerConfig(true, false);
    loadPipelineConfig.mockResolvedValue(initialConfig);
    putPipelineConfig.mockResolvedValue(alignerConfig(false, false));
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(
      await screen.findByRole("button", { name: "Transcribe tracks" }),
    );
    await user.click(screen.getByRole("button", { name: "Show advanced" }));

    const toggle = await screen.findByLabelText(/Precise word boundaries/i);
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(
      /blocked: transcribe\.forced_alignment\.enabled is true.*can be turned off here/i,
    );
    await expectNoA11yViolations(container);

    toggle.focus();
    await user.keyboard(" ");
    await waitFor(() => expect(putPipelineConfig).toHaveBeenCalledTimes(1));
    expect(putPipelineConfig).toHaveBeenCalledWith(
      "/tmp/ep.project.json",
      expect.objectContaining({
        config: {
          ...initialConfig.config,
          transcribe: {
            model: "small.en",
            forced_alignment: { enabled: false },
          },
        },
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText(/Precise word boundaries/i),
      ).not.toBeChecked();
      expect(screen.getByLabelText(/Precise word boundaries/i)).toBeDisabled();
    });
  });

  it("shows Precise word boundaries on by default once the aligner is downloaded", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(null, true));
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));

    const toggle = await screen.findByLabelText(/Precise word boundaries/i);
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
    expect(toggle).toHaveAccessibleDescription(
      /Precise word boundaries on by default: word aligner 'onnx-base' is installed\./,
    );
    expect(
      screen.getByText(
        /Precise word boundaries on by default: word aligner 'onnx-base' is installed/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-time words" })).toBeEnabled();
    await expectNoA11yViolations(container);

    putPipelineConfig.mockResolvedValue(alignerConfig(false, true));
    await user.click(toggle);
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalled();
    });
    const body = putPipelineConfig.mock.calls.at(-1)?.[1] as {
      config: { transcribe: { forced_alignment: { enabled: unknown } } };
    };
    expect(body.config.transcribe.forced_alignment.enabled).toBe(false);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Re-time words" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Precise word boundaries/i)).not.toBeChecked();
  });

  it("Re-time words asks about edited tracks and starts a run from transcribe", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(true, true));
    loadTranscriptVocabulary.mockResolvedValue({
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: false,
      edited_tracks: ["host"],
    });
    const confirmSpy = confirmReply.mockReturnValue(true);
    answerQuestions(confirmSpy);

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    await user.click(
      await screen.findByRole("button", { name: "Re-time words" }),
    );
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalledWith(
        "/tmp/ep.project.json",
        expect.objectContaining({
          fromStep: "transcribe_tracks",
          retimeWords: true,
          forceTranscribe: false,
          overwriteEdited: true,
          enabledSteps: expect.arrayContaining(["transcribe_tracks"]),
        }),
      );
    });

    confirmSpy.mockReturnValue(false);
    startPipelineRun.mockClear();
    const callsBefore = loadTranscriptVocabulary.mock.calls.length;
    await user.click(
      await screen.findByRole("button", { name: "Re-time words" }),
    );
    await waitFor(() => {
      expect(loadTranscriptVocabulary.mock.calls.length).toBe(callsBefore + 1);
    });
    expect(startPipelineRun).not.toHaveBeenCalled();
  });

  it.each([
    ["Not now", "decline"],
    ["Download", "accept"],
  ])(
    "does not reopen the phone Step parameters sheet after the model prompt (%s)",
    async (button) => {
      shellBreakpoint = "phone";
      const user = userEvent.setup();
      const cfg = alignerConfig(true, true);
      cfg.config = {
        ...cfg.config,
        transcribe: {
          ...(cfg.config.transcribe as Record<string, unknown>),
          model: "large-v3-turbo",
        },
      };
      loadPipelineConfig.mockResolvedValue(cfg);
      loadTranscriptVocabulary.mockResolvedValue({
        terms: [],
        guest_names: [],
        revision: "r1",
        needs_retranscription: false,
        edited_tracks: [],
      });
      answerQuestions(confirmReply.mockReturnValue(true));
      render(
        <main>
          <PipelinePanel />
        </main>,
      );
      await user.click(
        await screen.findByRole("button", { name: "Transcribe tracks" }),
      );
      await user.click(screen.getByRole("button", { name: "Show advanced" }));
      await user.click(
        await screen.findByRole("button", { name: "Re-time words" }),
      );
      await user.click(await screen.findByRole("button", { name: button }));
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Download Whisper?" }),
        ).toBeNull(),
      );
      expect(
        screen.queryByRole("dialog", { name: "Step parameters" }),
      ).toBeNull();
      confirmReply.mockReset();
    },
  );

  it("Re-time words ignores a second click while the first is still loading", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(true, true));
    let resolveVocab!: (v: unknown) => void;
    loadTranscriptVocabulary.mockReturnValue(
      new Promise((r) => {
        resolveVocab = r;
      }),
    );
    answerQuestions(confirmReply.mockReturnValue(true));

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    const btn = await screen.findByRole("button", { name: "Re-time words" });
    const callsBefore = loadTranscriptVocabulary.mock.calls.length;

    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(loadTranscriptVocabulary.mock.calls.length).toBe(callsBefore + 1);
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveTextContent("Re-timing…");

    await act(async () => {
      resolveVocab({
        terms: [],
        guest_names: [],
        revision: "r1",
        needs_retranscription: false,
        edited_tracks: [],
      });
    });
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalledTimes(1);
    });
  });

  it("Re-time words stays busy until the run request settles", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(true, true));
    loadTranscriptVocabulary.mockResolvedValue({
      terms: [],
      guest_names: [],
      revision: "r1",
      needs_retranscription: false,
      edited_tracks: [],
    });
    let resolveRun!: (v: unknown) => void;
    startPipelineRun.mockReturnValue(
      new Promise((r) => {
        resolveRun = r;
      }),
    );

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    const btn = await screen.findByRole("button", { name: "Re-time words" });
    const vocabCalls = loadTranscriptVocabulary.mock.calls.length;
    fireEvent.click(btn);
    await waitFor(() => {
      expect(startPipelineRun).toHaveBeenCalledTimes(1);
    });
    // Vocabulary loaded, run request still pending: the button stays busy.
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(btn);
    expect(loadTranscriptVocabulary.mock.calls.length).toBe(vocabCalls + 1);
    expect(startPipelineRun).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRun({
        id: "job1",
        project_path: "/tmp/ep.project.json",
        from_step: "transcribe_tracks",
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
    expect(
      screen.queryByRole("button", { name: "Re-timing…" }),
    ).not.toBeInTheDocument();
  });

  it("has no axe violations with the aligner badge", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(alignerConfig(true, false));
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Transcribe tracks").length).toBeGreaterThan(
        0,
      );
    });
    await user.click(screen.getByRole("button", { name: "Transcribe tracks" }));
    await user.click(screen.getByRole("button", { name: "Show advanced" }));
    expect(
      await screen.findByText(/Word aligner needs download/i),
    ).toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it("has no axe violations on loaded panel", async () => {
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await expectNoA11yViolations(container);
  });

  it("rolls back param edit when the latest PUT fails", async () => {
    const user = userEvent.setup();
    putPipelineConfig.mockRejectedValue(new Error("save failed"));
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    expect(downloadModel).not.toHaveBeenCalled();
    const body = putPipelineConfig.mock.calls.at(-1)?.[1] as {
      config: { transcribe: { model: string } };
    };
    expect(body.config.transcribe.model).toBe("large-v3-turbo");
  });

  it("asks before Run when Whisper weights are missing and transcribe is enabled", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(
      withTranscribeEnabled({
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
        components: {
          ffmpeg: { state: "installed" },
          whisper: { state: "missing", hint: "not downloaded" },
          rnnoise: { state: "installed" },
        },
      }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Run pipeline" }),
      ).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: "Run pipeline" }));
    expect(
      await screen.findByRole("dialog", { name: "Download Whisper?" }),
    ).toBeInTheDocument();
    expect(startPipelineRun).not.toHaveBeenCalled();
    expect(downloadModel).not.toHaveBeenCalled();
  });

  describe("Run asks only for models the selected steps use", () => {
    const missingWhisper = () =>
      withTranscribeEnabled({
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
        components: {
          ffmpeg: { state: "installed" },
          whisper: { state: "missing", hint: "not downloaded" },
          rnnoise: { state: "installed" },
        },
      });

    async function runWith(
      user: ReturnType<typeof userEvent.setup>,
      selection: { from?: string; only?: string },
    ) {
      render(
        <main>
          <PipelinePanel />
        </main>,
      );
      const run = await screen.findByRole("button", { name: "Run pipeline" });
      await waitFor(() => expect(run).toBeEnabled());
      await user.click(screen.getByText("From / Only shortcuts"));
      if (selection.from) {
        await user.selectOptions(
          screen.getByRole("combobox", { name: "From step" }),
          selection.from,
        );
      }
      if (selection.only) {
        await user.selectOptions(
          screen.getByRole("combobox", { name: "Only step" }),
          selection.only,
        );
      }
      await user.click(run);
    }

    it.each([
      ["from a step after transcription", { from: "balance_tracks" }],
      ["only a step other than transcription", { only: "export_deliverables" }],
    ])("does not ask for Whisper when running %s", async (_name, selection) => {
      const user = userEvent.setup();
      loadPipelineConfig.mockResolvedValue(missingWhisper());
      startPipelineRun.mockResolvedValue({ id: "job-1" });
      await runWith(user, selection);

      await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it.each([
      ["from the first step", { from: "ingest_tracks" }],
      ["only transcription", { only: "transcribe_tracks" }],
    ])("asks for Whisper when running %s", async (_name, selection) => {
      const user = userEvent.setup();
      loadPipelineConfig.mockResolvedValue(missingWhisper());
      await runWith(user, selection);

      expect(
        await screen.findByRole("dialog", { name: "Download Whisper?" }),
      ).toBeInTheDocument();
      expect(startPipelineRun).not.toHaveBeenCalled();
    });

    it("does not ask for the word aligner when the run starts after transcription", async () => {
      const user = userEvent.setup();
      const cfg = alignerConfig(true, false);
      loadPipelineConfig.mockResolvedValue({
        ...cfg,
        enabled_steps: [...cfg.enabled_steps, "transcribe_tracks"],
      });
      startPipelineRun.mockResolvedValue({ id: "job-1" });
      await runWith(user, { from: "balance_tracks" });

      await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("downloads via bootstrap then persists the selected model", async () => {
    const user = userEvent.setup();
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

    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
      expect(downloadModel).toHaveBeenCalledWith(["whisper"], {
        whisperModel: "large-v3-turbo",
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(putPipelineConfig).toHaveBeenCalled();
  });

  it("downloads Whisper before re-transcribing when the model is missing", async () => {
    const user = userEvent.setup();
    answerQuestions(confirmReply.mockReturnValue(true));
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(
      await screen.findByRole("button", { name: "Re-transcribe" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Download Whisper?" }),
    ).toBeInTheDocument();
    expect(startPipelineRun).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: "Download" }));
    expect(downloadModel).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "large-v3-turbo",
    });
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
    expect(confirmReply).toHaveBeenCalledOnce();
    confirmReply.mockReset();
  });

  it("asks again after Not now, keeps Run enabled and shows the hint", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(
      withTranscribeEnabled({
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
      }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const run = await screen.findByRole("button", { name: "Run pipeline" });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(
      await screen.findByText(/Whisper is not downloaded. Run will ask again./),
    ).toBeInTheDocument();
    expect(run).toBeEnabled();
    expect(startPipelineRun).not.toHaveBeenCalled();
    await user.click(run);
    expect(
      await screen.findByRole("dialog", { name: "Download Whisper?" }),
    ).toBeInTheDocument();
  });

  describe("project change around the model gate", () => {
    const uncachedConfig = () =>
      withTranscribeEnabled({
        config: {
          ...baseConfig.config,
          transcribe: { model: "large-v3-turbo" },
        },
      });

    it("closes the prompt and forgets the decline hint when the project changes", async () => {
      const user = userEvent.setup();
      loadPipelineConfig.mockResolvedValue(uncachedConfig());
      const ui = () => (
        <main>
          <PipelinePanel />
        </main>
      );
      const { rerender } = render(ui());
      const run = await screen.findByRole("button", { name: "Run pipeline" });
      await waitFor(() => expect(run).toBeEnabled());
      await user.click(run);
      await screen.findByRole("dialog", { name: "Download Whisper?" });
      mockState.projectPath = "/tmp/other.project.json";
      rerender(ui());
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Download Whisper?" }),
        ).toBeNull(),
      );
      expect(screen.queryByText(/will ask again/)).toBeNull();
      expect(startPipelineRun).not.toHaveBeenCalled();
    });

    it("does not start a run for the old project when it changed before the resume", async () => {
      const user = userEvent.setup();
      const turbo = uncachedConfig();
      loadPipelineConfig.mockResolvedValue(turbo);
      const ui = () => (
        <main>
          <PipelinePanel />
        </main>
      );
      const { rerender } = render(ui());
      loadPipelineConfig.mockImplementation(async () => {
        mockState.projectPath = "/tmp/other.project.json";
        rerender(ui());
        return turbo;
      });
      const run = await screen.findByRole("button", { name: "Run pipeline" });
      await waitFor(() => expect(run).toBeEnabled());
      await user.click(run);
      await user.click(await screen.findByRole("button", { name: "Download" }));
      await waitFor(() => expect(downloadModel).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 50));
      expect(startPipelineRun).not.toHaveBeenCalled();
      expect(setPipelineJob).not.toHaveBeenCalled();
    });
  });

  it("opens the same prompt when a stale cache gets a model_needed 409, then resumes the run", async () => {
    const user = userEvent.setup();
    startPipelineRun
      .mockRejectedValueOnce(
        modelNeeded("whisper", "Whisper", "large-v3-turbo"),
      )
      .mockResolvedValue({ id: "job-1" });
    loadPipelineConfig.mockResolvedValue(
      withTranscribeEnabled({
        config: { ...baseConfig.config, transcribe: { model: "small.en" } },
      }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const run = await screen.findByRole("button", { name: "Run pipeline" });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await user.click(await screen.findByRole("button", { name: "Download" }));
    expect(downloadModel).toHaveBeenCalledWith(["whisper"], {
      whisperModel: "large-v3-turbo",
    });
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(2));
    expect(setPipelineJob).toHaveBeenCalledWith({ id: "job-1" });
  });

  it("prompts for the word aligner when Precise word boundaries is requested without it", async () => {
    const user = userEvent.setup();
    const cfg = alignerConfig(true, false);
    loadPipelineConfig.mockResolvedValue({
      ...cfg,
      enabled_steps: [...cfg.enabled_steps, "transcribe_tracks"],
    });
    render(
      <main>
        <PipelinePanel />
      </main>,
      [],
    );
    const run = await screen.findByRole("button", { name: "Run pipeline" });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    const dialog = await screen.findByRole("dialog", {
      name: "Download Word aligner?",
    });
    expect(dialog).toBeInTheDocument();
    expect(startPipelineRun).not.toHaveBeenCalled();
  });

  it("prompts for the aligner named by a 409 when the client thought it was installed", async () => {
    const user = userEvent.setup();
    startPipelineRun
      .mockRejectedValueOnce(modelNeeded("word-aligner", "Word aligner", null))
      .mockResolvedValue({ id: "job-2" });
    loadPipelineConfig.mockResolvedValue(
      withTranscribeEnabled({
        config: { ...baseConfig.config, transcribe: { model: "small.en" } },
      }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const run = await screen.findByRole("button", { name: "Run pipeline" });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    await screen.findByRole("dialog", { name: "Download Word aligner?" });
    await user.click(screen.getByRole("button", { name: "Download" }));
    expect(downloadModel).toHaveBeenCalledWith(["word-aligner"], undefined);
    await waitFor(() => expect(startPipelineRun).toHaveBeenCalledTimes(2));
  });

  it("shows other run errors in the banner without a prompt", async () => {
    const user = userEvent.setup();
    startPipelineRun.mockRejectedValue(new Error("Disk is full."));
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    const run = await screen.findByRole("button", { name: "Run pipeline" });
    await waitFor(() => expect(run).toBeEnabled());
    await user.click(run);
    expect(await screen.findByText("Disk is full.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Download under a run that failed for a model", async () => {
    loadPipelineConfig.mockResolvedValue(structuredClone(baseConfig));
    dawState.pipelineJob = {
      id: "j-model",
      project_path: "/tmp/p.json",
      from_step: null,
      only_step: null,
      kind: "pipeline",
      status: "error",
      current: null,
      total: null,
      error:
        "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`",
      message:
        "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`",
      error_code: "model_needed",
      error_model: {
        id: "rnnoise",
        model: "rnnoise",
        label: "Noise reduction (RNNoise)",
        purpose: "noise reduction",
        size: "~0.3 MB",
        size_bytes: 297646,
        state: "missing",
      },
      elapsed_sec: 2,
      steps: [
        {
          name: "denoise",
          status: "error",
          elapsed_sec: 1,
          error:
            "needs Noise reduction (RNNoise) (~0.3 MB); run `podcast bootstrap --component rnnoise`",
        },
      ],
    };
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(
      await screen.findByRole("button", {
        name: "Download Noise reduction (RNNoise)",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("main").textContent).toContain(
      "Noise reduction (RNNoise) is not downloaded.",
    );
    expect(screen.getByRole("main").textContent).not.toMatch(
      /podcast bootstrap/,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    const { baseElement: container, rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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

  function remoteAnalyzeResult(overrides: Record<string, unknown> = {}) {
    return {
      proposed_config: {},
      patches: {},
      reasons: [{ code: "hum", message: "host: mains hum", evidence: {} }],
      report_summary: { track_count: 1, reason_count: 1, tracks: [] },
      applied: true,
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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

  it("seeds Analyze as the Activity primary even while an agent job is live", async () => {
    const user = userEvent.setup();
    dawState.activityJob = analyzeJobSnap({
      id: "agent-1",
      kind: "agent",
      label: "align_tracks",
      tool_id: "align_tracks",
      message: "Scoring bleed windows",
      current: null,
      total: null,
    });
    analyzePipeline.mockImplementation(
      async (_path: string, opts: { onJob: (job: unknown) => void }) => {
        opts.onJob(
          analyzeJobSnap({ status: "queued", current: null, total: null }),
        );
        return null;
      },
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => {
      expect(setActivityJob).toHaveBeenCalledWith(
        expect.objectContaining({ id: "an-1", kind: "analyze" }),
      );
    });
  });

  it("shows a running Analyze job's per-track progress with Cancel", async () => {
    const user = userEvent.setup();
    dawState.activityJob = analyzeJobSnap();
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
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

  it("names a message-less Analyze progress bar Analyze progress", async () => {
    dawState.activityJob = analyzeJobSnap({ message: null });
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(
      await screen.findByRole("progressbar", { name: "Analyze progress" }),
    ).toHaveAttribute("aria-valuenow", "50");
  });

  it("renders a shared Analyze job's result that another viewer started", async () => {
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    waitForPipelineJob.mockResolvedValueOnce(
      analyzeJobSnap({
        id: "an-remote",
        status: "ok",
        message: "Analyze complete",
        result: remoteAnalyzeResult(),
      }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    expect(waitForPipelineJob).toHaveBeenCalledWith(
      "an-remote",
      expect.objectContaining({
        timeoutMs: 21_600_000,
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
  });

  it("does not render a finished Analyze it never saw running", async () => {
    dawState.activityJob = analyzeJobSnap({
      id: "an-remote",
      status: "ok",
      message: "Analyze complete",
      result: {
        proposed_config: {},
        patches: {},
        reasons: [{ code: "hum", message: "host: mains hum", evidence: {} }],
        report_summary: { track_count: 1, reason_count: 1, tracks: [] },
        applied: true,
      },
    });
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    expect(screen.queryByText("host: mains hum")).not.toBeInTheDocument();
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
    expect(waitForPipelineJob).not.toHaveBeenCalled();
  });

  it("renders a shared Analyze result after an agent job takes the Activity primary", async () => {
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    let finish!: (job: unknown) => void;
    waitForPipelineJob.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    });
    // A host-MCP agent job becomes the Activity primary before Analyze finishes.
    dawState.activityJob = analyzeJobSnap({
      id: "agent-1",
      kind: "agent",
      label: "align_tracks",
      tool_id: "align_tracks",
      message: "Scoring bleed windows",
      current: null,
      total: null,
    });
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await act(async () => {
      finish(
        analyzeJobSnap({
          id: "an-remote",
          status: "ok",
          message: "Analyze complete",
          result: remoteAnalyzeResult(),
        }),
      );
    });
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
  });

  it("stops following a remote Analyze on project switch", async () => {
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    });
    const signal = waitForPipelineJob.mock.calls[0][1].signal as AbortSignal;
    mockState.projectPath = "/tmp/other.project.json";
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(signal.aborted).toBe(true);
    });
    // The same job's next frame after the switch is not re-adopted.
    dawState.activityJob = analyzeJobSnap({
      id: "an-remote",
      current: 2,
      message: "Scanned guest (2/2)",
    });
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await act(async () => {});
    expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
  });

  it("follows a still-running remote Analyze again after switching back to its project", async () => {
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    });
    mockState.projectPath = "/tmp/other.project.json";
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await act(async () => {});
    // Another project's pane does not adopt the job.
    expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    waitForPipelineJob.mockResolvedValueOnce(
      analyzeJobSnap({
        id: "an-remote",
        status: "ok",
        message: "Analyze complete",
        result: remoteAnalyzeResult(),
      }),
    );
    mockState.projectPath = "/tmp/ep.project.json";
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    expect(waitForPipelineJob).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      // A, B and A loads, plus the re-read after the applied result.
      expect(loadPipelineConfig).toHaveBeenCalledTimes(4);
    });
  });

  it("re-reads a remote Analyze's config only after an in-flight param PUT settles", async () => {
    const user = userEvent.setup();
    const merged = withMasterLufsParam();
    merged.config.balance.dialogue_lufs = -18;
    merged.config.master.integrated_lufs = -14;
    loadPipelineConfig
      .mockResolvedValueOnce(withMasterLufsParam())
      .mockResolvedValueOnce(structuredClone(merged))
      .mockResolvedValueOnce(structuredClone(merged));
    let resolvePut!: () => void;
    putPipelineConfig.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolvePut = () => r(structuredClone(merged));
        }),
    );
    let finish!: (job: unknown) => void;
    waitForPipelineJob.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    });
    // Activity moves on, so this tab can edit while the remote result is still in flight.
    dawState.activityJob = null;
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    fireEvent.change(screen.getByLabelText(/Dialogue LUFS/i), {
      target: { value: "-18" },
    });
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      finish(
        analyzeJobSnap({
          id: "an-remote",
          status: "ok",
          message: "Analyze complete",
          result: remoteAnalyzeResult({
            patches: { master: { integrated_lufs: -14 } },
          }),
        }),
      );
    });
    // No GET while the PUT is pending: one served first would show the pre-edit value.
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvePut();
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByLabelText(/Dialogue LUFS/i)).toHaveValue(-18);
    expect(screen.getByLabelText(/Master LUFS/i)).toHaveValue(-14);
    expect(screen.getByLabelText(/Master LUFS/i).closest("label")).toHaveClass(
      "pipeline-param-highlight",
    );
  });

  it("does not highlight a remote Analyze patch the re-read config no longer holds", async () => {
    const user = userEvent.setup();
    const replaced = withMasterLufsParam();
    replaced.config.master.integrated_lufs = -12;
    loadPipelineConfig
      .mockResolvedValueOnce(withMasterLufsParam())
      .mockResolvedValueOnce(structuredClone(replaced));
    waitForPipelineJob.mockResolvedValueOnce(
      analyzeJobSnap({
        id: "an-remote",
        status: "ok",
        message: "Analyze complete",
        result: remoteAnalyzeResult({
          patches: { master: { integrated_lufs: -14 } },
        }),
      }),
    );
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    });
    dawState.activityJob = null;
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    await waitFor(() => {
      expect(screen.getByLabelText(/Master LUFS/i)).toHaveValue(-12);
    });
    expect(
      screen.getByLabelText(/Master LUFS/i).closest("label"),
    ).not.toHaveClass("pipeline-param-highlight");
  });

  it("shows an unapplied remote Analyze's reasons without highlights or a re-read", async () => {
    const user = userEvent.setup();
    loadPipelineConfig.mockResolvedValue(withMasterLufsParam());
    waitForPipelineJob.mockResolvedValueOnce(
      analyzeJobSnap({
        id: "an-remote",
        status: "ok",
        message: "Analyze complete",
        result: remoteAnalyzeResult({
          patches: { master: { integrated_lufs: -14 } },
          applied: false,
        }),
      }),
    );
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    expect(
      screen.getByText("Analyze suggestions (not applied)"),
    ).toBeInTheDocument();
    dawState.activityJob = null;
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    expect(
      screen.getByLabelText(/Master LUFS/i).closest("label"),
    ).not.toHaveClass("pipeline-param-highlight");
    expect(loadPipelineConfig).toHaveBeenCalledTimes(1);
  });

  it("leaves earlier Analyze results alone when a remote Analyze is cancelled before a result", async () => {
    const user = userEvent.setup();
    const patched = withMasterLufsParam();
    patched.config.master.integrated_lufs = -14;
    loadPipelineConfig.mockResolvedValue(withMasterLufsParam());
    analyzePipeline.mockResolvedValue({
      proposed_config: patched.config,
      patches: { master: { integrated_lufs: -14 } },
      reasons: [{ code: "hum", message: "host: mains hum", evidence: {} }],
      report_summary: { track_count: 1, reason_count: 1, tracks: [] },
      applied: true,
      config: patched,
    });
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("host: mains hum")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Balance tracks" }));
    expect(screen.getByLabelText(/Master LUFS/i).closest("label")).toHaveClass(
      "pipeline-param-highlight",
    );
    const cancelled = analyzeJobSnap({
      id: "an-remote",
      status: "cancelled",
      message: "Analyze cancelled",
      result: null,
    });
    waitForPipelineJob.mockResolvedValueOnce(cancelled);
    dawState.activityJob = analyzeJobSnap({ id: "an-remote" });
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(waitForPipelineJob).toHaveBeenCalledTimes(1);
    });
    dawState.activityJob = cancelled;
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
    await act(async () => {});
    expect(screen.getByText("host: mains hum")).toBeInTheDocument();
    expect(screen.getByText("Analyze suggestions applied")).toBeInTheDocument();
    expect(screen.getByLabelText(/Master LUFS/i).closest("label")).toHaveClass(
      "pipeline-param-highlight",
    );
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
  });

  it("a cancelled Analyze applies nothing and re-enables Analyze", async () => {
    const user = userEvent.setup();
    analyzePipeline.mockResolvedValue(null);
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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

  it("aborts the Analyze wait on project switch (analyzePipeline then cancels the job)", async () => {
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
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => {
      expect(captured).toBeInstanceOf(AbortSignal);
    });
    mockState.projectPath = "/tmp/other.project.json";
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    const { baseElement: container } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
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
    const { rerender } = render(
      <main>
        <PipelinePanel />
      </main>,
    );
    await waitFor(() => {
      expect(screen.getAllByText("Balance tracks").length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    mockState.projectPath = "/tmp/other.project.json";
    rerender(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    expect(putPipelineConfig).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst(undefined);
    });
    await waitFor(() => {
      expect(putPipelineConfig).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce(structuredClone(serverAfterPut))
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
    expect(loadPipelineConfig).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolvePut();
    });
    await waitFor(() => {
      expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce(structuredClone(merged))
      .mockResolvedValueOnce(structuredClone(merged));
    let resolveAnalyze!: (v: unknown) => void;
    analyzePipeline.mockImplementation(
      () =>
        new Promise((r) => {
          resolveAnalyze = r;
        }),
    );
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
      expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
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
      .mockResolvedValueOnce(structuredClone(serverAfterReject))
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
    render(
      <main>
        <PipelinePanel />
      </main>,
    );
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
      expect(loadPipelineConfig).toHaveBeenCalledTimes(3);
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
