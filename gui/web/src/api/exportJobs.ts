import { hostFetch } from "../api/documentTransport";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { readApiError } from "../utils/apiError";
import { followExportJob } from "./pipeline";

export async function bounceAudio(
  projectPath: string,
  body: {
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startBounceJob(projectPath, body);
  return followExportJob(job.id, "Bounce failed", opts);
}

export async function startBounceJob(
  projectPath: string,
  body: {
    track_ids?: string[] | null;
    start_s?: number | null;
    end_s?: number | null;
    formats?: string[] | null;
  },
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/export/bounce", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
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
      message: "Bounce",
      error: null,
      elapsed_sec: 0,
      steps: [],
    };
  }
  throw new Error("Bounce did not return a job");
}
export async function exportDeliverables(
  projectPath: string,
  formats?: Record<string, unknown>[] | null,
  opts?: { signal?: AbortSignal },
): Promise<string[]> {
  const job = await startExportJob(projectPath, formats);
  return followExportJob(job.id, "Export failed", opts);
}

export async function startExportJob(
  projectPath: string,
  formats?: Record<string, unknown>[] | null,
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/export/deliverables", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, formats: formats ?? null }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
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
