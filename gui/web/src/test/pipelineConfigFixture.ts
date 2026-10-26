import type {
  PipelineConfigResponse,
  PipelineParamField,
  PipelineStepMeta,
} from "../types/pipeline";

function step(
  overrides: Partial<PipelineStepMeta> & Pick<PipelineStepMeta, "id" | "title">,
  index: number,
): PipelineStepMeta {
  return {
    index,
    group: "transcript",
    summary: "",
    kind: "tooling",
    depends_on: [],
    requires_components: [],
    param_sections: [],
    enabled_by_default: true,
    ...overrides,
  };
}

const STEPS: PipelineStepMeta[] = [
  step(
    {
      id: "ingest_tracks",
      title: "Ingest tracks",
      summary: "Probe audio and validate track paths.",
      requires_components: ["ffmpeg"],
    },
    0,
  ),
  step(
    {
      id: "transcribe_tracks",
      title: "Transcribe tracks",
      summary: "Whisper speech recognition per dialogue track.",
      depends_on: ["ingest_tracks"],
      requires_components: ["whisper"],
      param_sections: ["transcribe"],
    },
    1,
  ),
  step(
    {
      id: "require_transcript_refine",
      title: "Require transcript refine",
      summary: "Gate until refine is done, waived, or batch/unattended.",
      kind: "gate",
      depends_on: ["transcribe_tracks"],
    },
    2,
  ),
  step(
    {
      id: "analyze_fillers_pauses",
      title: "Analyze fillers and pauses",
      summary: "Propose cuts for fillers, pauses, repetitions and restarts.",
      group: "editorial",
      kind: "heuristic",
      depends_on: ["require_transcript_refine"],
      param_sections: ["tighten"],
    },
    3,
  ),
  step(
    {
      id: "balance_tracks",
      title: "Balance tracks",
      summary: "Match track loudness before mixing.",
      group: "mix",
      depends_on: ["analyze_fillers_pauses"],
      requires_components: ["ffmpeg"],
      param_sections: ["balance"],
    },
    4,
  ),
  step(
    {
      id: "master_mix",
      title: "Master mix",
      summary: "Loudness-normalize and limit the final mix.",
      group: "mix",
      depends_on: ["balance_tracks"],
      requires_components: ["ffmpeg"],
      param_sections: ["master"],
    },
    5,
  ),
];

const PARAMS: PipelineParamField[] = [
  {
    path: "tighten.intensity",
    label: "Intensity",
    description: "How aggressively fillers and pauses are proposed.",
    type: "enum",
    default: "medium",
    enum: ["light", "medium", "aggressive"],
    group: "common",
    section: "tighten",
    affects: ["analyze_fillers_pauses"],
  },
  {
    path: "tighten.max_pause_sec",
    label: "Longest pause kept",
    description: "Pauses longer than this are proposed for shortening.",
    type: "number",
    default: 1.2,
    minimum: 0.2,
    maximum: 5,
    unit: "s",
    group: "common",
    section: "tighten",
    affects: ["analyze_fillers_pauses"],
  },
  {
    path: "tighten.repetition_candidates",
    label: "Propose repetitions",
    description: "Propose review-only repeated words and restarts.",
    type: "boolean",
    default: true,
    group: "advanced",
    section: "tighten",
    affects: ["analyze_fillers_pauses"],
  },
  {
    path: "balance.target_lufs",
    label: "Target loudness",
    description: "Loudness each dialogue track is balanced to.",
    type: "number",
    default: -19,
    minimum: -40,
    maximum: -6,
    unit: "LUFS",
    group: "common",
    section: "balance",
    affects: ["balance_tracks"],
  },
  {
    path: "master.true_peak_db",
    label: "True peak ceiling",
    description: "The limiter never lets the master exceed this level.",
    type: "number",
    default: -1,
    minimum: -6,
    maximum: 0,
    unit: "dB",
    group: "advanced",
    section: "master",
    affects: ["master_mix"],
  },
];

export function pipelineConfig(
  overrides: Partial<PipelineConfigResponse> = {},
): PipelineConfigResponse {
  return {
    defaults: {
      tighten: { intensity: "medium", max_pause_sec: 1.2 },
      balance: { target_lufs: -19 },
    },
    config: {
      tighten: { intensity: "medium", max_pause_sec: 1.2 },
      balance: { target_lufs: -19 },
    },
    enabled_steps: STEPS.map((s) => s.id),
    unattended: false,
    steps: STEPS,
    params: PARAMS,
    components: {
      ffmpeg: { state: "installed", label: "ffmpeg" },
      whisper: { state: "installed", label: "Whisper" },
    },
    forced_alignment: {
      enabled: true,
      model: "wav2vec2",
      requested: null,
      installed: true,
      blocked: false,
      reason: "",
    },
    step_names: STEPS.map((s) => s.id),
    whisper_models: [],
    ...overrides,
  };
}
