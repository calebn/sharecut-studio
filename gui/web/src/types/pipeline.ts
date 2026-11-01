/**
 * How many results a step took from the cache and how many it made new.
 * The engine does not report this yet; Prepare shows "1 new · 3 reused" and
 * the run's reuse line only for steps that carry it.
 */
export interface PipelineStepReuse {
  reused: number;
  recomputed: number;
}

export interface PipelineStepTiming {
  name: string;
  status: string;
  elapsed_sec: number;
  error: string | null;
  summary?: string | null;
  /** Left out (or null) when the step does not report reuse. */
  reuse?: PipelineStepReuse | null;
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
    | "split_speakers"
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
  error_code?: string | null;
  error_model?: Record<string, unknown> | null;
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

export type ModelInstallState = "installed" | "missing" | "update_needed";

/** One component's readiness, as GET /api/pipeline/config lists it; the bootstrap `ModelStatus` is the same record. */
export interface PipelineComponentStatus {
  state: ModelInstallState;
  tier?: "required" | "recommended" | "offered";
  label?: string;
  size?: string;
  model?: string;
  path?: string;
  hint?: string;
  bootstrap?: string;
}

export interface PipelineConfigResponse {
  defaults: Record<string, unknown>;
  config: Record<string, unknown>;
  enabled_steps: string[];
  unattended: boolean;
  steps: PipelineStepMeta[];
  params: PipelineParamField[];
  components: Record<string, PipelineComponentStatus>;
  step_names: string[];
}
