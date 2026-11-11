import type { LoudnessId, PipelineJobSnapshot } from "../types/pipeline";
import type { ExactRangeTarget } from "../types/project";
import type { ExportDeliverablesRequest } from "../types/project.generated";
import { type ExportEvidence, parseExportSettingsRead } from "./exportEvidence";
import { apiFetch, HOST_KEY } from "./http";
import { followExportJob } from "./pipeline";

export async function bounceAudio(
  projectPath: string,
  body: {
    exact_range?: ExactRangeTarget | null;
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startBounceJob(projectPath, body);
  return followExportJob(job.id, "Export failed", opts);
}

export async function startBounceJob(
  projectPath: string,
  body: {
    exact_range?: ExactRangeTarget | null;
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
): Promise<PipelineJobSnapshot> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/export/bounce" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, ...body }),
    },
  );
  const data = (await res.json()) as {
    job?: PipelineJobSnapshot;
    job_id?: string;
  };
  if (data.job) {
    return data.job;
  }
  if (data.job_id) {
    return {
      id: data.job_id,
      project_path: projectPath,
      from_step: null,
      only_step: null,
      kind: "bounce",
      status: "queued",
      current: null,
      total: null,
      message: "Export",
      error: null,
      elapsed_sec: 0,
      steps: [],
    };
  }
  throw new Error("Export did not return a job");
}
export async function exportDeliverables(
  projectPath: string,
  formats?: Record<string, unknown>[] | null,
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startExportJob(projectPath, formats);
  return followExportJob(job.id, "Export failed", opts);
}

export type ExportFormats =
  | readonly Readonly<
      NonNullable<ExportDeliverablesRequest["formats"]>[number]
    >[]
  | null;

function exportPost(
  path: string,
  formats: ExportFormats,
  target: LoudnessId | null,
): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path,
      formats,
      ...(target === null ? {} : { target }),
    }),
  };
}

export async function readExportSettings(
  projectPath: string,
  formats: ExportFormats,
  target: LoudnessId | null,
  signal: AbortSignal,
): Promise<ExportEvidence | null> {
  const res = await apiFetch(
    projectPath,
    { host: "/api/export/deliverables/settings" },
    { ...exportPost(projectPath, formats, target), signal },
  );
  const data: unknown = await res.json();
  return parseExportSettingsRead(data, target);
}

export async function startExportJob(
  projectPath: string,
  formats: ExportFormats = null,
  target: LoudnessId | null = null,
): Promise<PipelineJobSnapshot> {
  const res = await apiFetch(
    projectPath,
    { host: "/api/export/deliverables" },
    exportPost(projectPath, formats, target),
  );
  const data = (await res.json()) as {
    job?: PipelineJobSnapshot;
    job_id?: string;
  };
  if (data.job) {
    return data.job;
  }
  if (data.job_id) {
    return {
      id: data.job_id,
      project_path: projectPath,
      from_step: null,
      only_step: null,
      kind: "export",
      status: "queued",
      current: null,
      total: null,
      message: "Export deliverables",
      error: null,
      elapsed_sec: 0,
      steps: [],
    };
  }
  throw new Error("Export did not return a job");
}
