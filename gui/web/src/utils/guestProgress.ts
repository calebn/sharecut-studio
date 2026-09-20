import type { PipelineJobSnapshot } from "../types/pipeline";

export type GuestProgressEvent = {
  type?: string;
  plane?: string;
  kind?: string;
  task_id?: string;
  label?: string | null;
  message?: string | null;
  current?: number | null;
  total?: number | null;
  elapsed_sec?: number;
  status?: string;
  phase?: string | null;
};

export function guestProgressToJob(
  event: GuestProgressEvent,
  prev?: PipelineJobSnapshot | null,
): PipelineJobSnapshot | null {
  if (event.plane !== "progress" && event.type !== "progress") {
    return prev ?? null;
  }
  const status = event.status ?? "running";
  const terminal =
    status === "ok" || status === "error" || status === "cancelled";
  return {
    id: event.task_id || prev?.id || "guest",
    project_path: "",
    from_step: null,
    only_step: null,
    kind: "agent",
    label: event.label ?? prev?.label ?? event.task_id ?? "Activity",
    tool_id: event.task_id ?? prev?.tool_id,
    status: terminal ? status : "running",
    current: event.current ?? prev?.current ?? null,
    total: event.total ?? prev?.total ?? null,
    message: event.message ?? event.label ?? prev?.message ?? null,
    error: status === "error" ? (event.message ?? "failed") : null,
    elapsed_sec: event.elapsed_sec ?? prev?.elapsed_sec ?? 0,
    last_progress_at: Date.now() / 1000,
    steps: prev?.steps ?? [],
  };
}

export function guestProgressWsUrl(token: string): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/api/review/${encodeURIComponent(token)}/progress/ws`;
}
