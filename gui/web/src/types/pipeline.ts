export interface PipelineStepTiming {
  name: string;
  status: string;
  elapsed_sec: number;
  error: string | null;
  summary?: string | null;
}

export interface PipelineJobSnapshot {
  id: string;
  project_path: string;
  from_step: string | null;
  only_step: string | null;
  kind?:
    | "pipeline"
    | "render_preview"
    | "bounce"
    | "export"
    | "analyze"
    | "agent"
    | (string & {});
  label?: string | null;
  tool_id?: string | null;
  result?: { paths?: string[]; [key: string]: unknown } | null;
  status: "queued" | "running" | "ok" | "error" | "cancelled" | (string & {});
  current: number | null;
  total: number | null;
  message: string | null;
  error: string | null;
  elapsed_sec: number;
  last_progress_at?: number | null;
  unattended?: boolean;
  skip_steps?: string[];
  steps: PipelineStepTiming[];
}

/**
 * Result copy owed by jobs whose callers announce their own outcome (Bounce,
 * Export deliverables), keyed by job id: `null` while the job still runs, then
 * its copy (e.g. "Bounced 1 file(s) to export/bounces/") until
 * `useJobStatusAnnouncement` speaks it and drops the entry (#704).
 */
export type PendingJobResults = Readonly<Record<string, string | null>>;

export interface PipelineStatusResponse {
  running: boolean;
  job: PipelineJobSnapshot | null;
  jobs?: PipelineJobSnapshot[];
  running_count?: number;
}

export interface PipelineEvent {
  type: "status" | "progress" | "done" | (string & {});
  kind?: string;
  task_id?: string;
  label?: string;
  current?: number | null;
  total?: number | null;
  elapsed_sec?: number;
  message?: string | null;
  job?: PipelineJobSnapshot;
}

export interface ProjectMeta {
  path: string;
  mtime_ns: number;
  size: number;
  server_seq?: number;
}

export type PipelineStepKind = "tooling" | "gate" | "heuristic";

export interface PipelineStepMeta {
  id: string;
  index: number;
  group: string;
  title: string;
  summary: string;
  kind: PipelineStepKind;
  depends_on: string[];
  requires_components: string[];
  param_sections: string[];
  enabled_by_default: boolean;
}

export interface PipelineParamField {
  path: string;
  label: string;
  description: string;
  type:
    | "number"
    | "integer"
    | "boolean"
    | "string"
    | "enum"
    | "object"
    | (string & {});
  default?: unknown;
  minimum?: number;
  maximum?: number;
  unit?: string;
  enum?: string[];
  group: "common" | "advanced" | (string & {});
  section: string;
  affects: string[];
}

/** One component's readiness; shared by GET /api/pipeline/config and /api/bootstrap/status (BootstrapComponentStatus extends it). */
export interface PipelineComponentStatus {
  ok: boolean;
  path?: string;
  hint?: string;
  bootstrap?: string;
  opt_in?: boolean;
  model?: string;
  label?: string;
  size?: string;
  /** True when a pinned model snapshot is present but fails its sha256 manifest (#728). */
  pin_mismatch?: boolean;
}

export interface WhisperModelCatalogRow {
  id: string;
  label: string;
  size: string;
  description: string;
  cached: boolean;
}

/**
 * `transcribe.forced_alignment.enabled` resolved against the installed word aligner (#780).
 * `requested` is the raw config value (null = follow the model); `enabled` is what a run does.
 * `blocked` = explicitly on without the model, which a run refuses.
 */
export interface PipelineForcedAlignment {
  enabled: boolean;
  model: string | null;
  requested: boolean | null;
  installed: boolean;
  blocked: boolean;
  reason: string;
}

export interface PipelineConfigResponse {
  defaults: Record<string, unknown>;
  config: Record<string, unknown>;
  enabled_steps: string[];
  unattended: boolean;
  steps: PipelineStepMeta[];
  params: PipelineParamField[];
  components: Record<string, PipelineComponentStatus>;
  /** Drives the Precise word boundaries toggle; absent only from older hosts. */
  forced_alignment?: PipelineForcedAlignment;
  step_names: string[];
  /** Catalog for Pipeline Whisper picker (Downloaded / Needs download). */
  whisper_models?: WhisperModelCatalogRow[];
}

export interface PipelineAnalyzeReason {
  code: string;
  message: string;
  track_id?: string;
  evidence?: Record<string, unknown>;
  suggested_skip_steps?: string[];
}

export interface PipelineAnalyzeResponse {
  proposed_config: Record<string, unknown>;
  patches: Record<string, unknown>;
  reasons: PipelineAnalyzeReason[];
  report_summary?: {
    track_count?: number;
    reason_count?: number;
    tracks?: Array<Record<string, unknown>>;
  };
  applied: boolean;
  config?: PipelineConfigResponse;
}
