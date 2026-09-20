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

export interface PipelineComponentStatus {
  ok: boolean;
  path?: string;
  hint?: string;
  bootstrap?: string;
}

export interface WhisperModelCatalogRow {
  id: string;
  label: string;
  size: string;
  description: string;
  cached: boolean;
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
  /** Catalog for Pipeline Whisper picker (Downloaded / Needs download). */
  whisper_models?: WhisperModelCatalogRow[];
}

export interface PipelineAnalyzeResponse {
  proposed_config: Record<string, unknown>;
  patches: Record<string, unknown>;
  reasons: Array<{ code: string; message: string; track_id?: string }>;
  report_summary?: { track_count?: number; reason_count?: number };
  applied: boolean;
  config?: PipelineConfigResponse;
}
