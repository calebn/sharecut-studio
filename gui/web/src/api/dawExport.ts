import type { PipelineJobSnapshot } from "../types/pipeline";
import { apiFetch } from "./http";

export type DawFormat = "rpp" | "aaf" | "sesx";

export async function loadDawFormats(projectPath: string, signal: AbortSignal) {
  const response = await apiFetch(
    projectPath,
    { host: "/api/export/daw/formats" },
    { signal },
  );
  const body: unknown = await response.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("rpp" in body) ||
    !("aaf" in body) ||
    !("sesx" in body)
  )
    throw new Error("Could not check DAW formats.");
  const blocker = (value: unknown) => {
    if (value === null || typeof value === "string") return value;
    throw new Error("Could not check DAW formats.");
  };
  return {
    rpp: blocker(body.rpp),
    aaf: blocker(body.aaf),
    sesx: blocker(body.sesx),
  };
}

export async function startDawSession(
  projectPath: string,
  format: DawFormat,
  signal: AbortSignal,
): Promise<PipelineJobSnapshot> {
  const response = await apiFetch(
    projectPath,
    { host: "/api/export/daw" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ path: projectPath, format }),
    },
  );
  const { job }: { job: PipelineJobSnapshot } = await response.json();
  if (!job || typeof job.id !== "string" || job.kind !== "daw_export")
    throw new Error("Could not track the DAW export.");
  return job;
}
