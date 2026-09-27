import { hostFetch } from "../api/documentTransport";
import { readApiError } from "../utils/apiError";
import { JOB_STREAM_RECHECK_MS } from "./pipeline";

export type BootstrapComponentStatus = {
  ok: boolean;
  required_for_first_run?: boolean;
  source?: string;
  model?: string;
  cache?: string;
  path?: string;
  note?: string;
};

export type WhisperModelChoice = {
  id: string;
  label: string;
  size: string;
  description: string;
  /** Present on pipeline config / bootstrap status when cache was probed. */
  cached?: boolean;
};

export type BootstrapStatus = {
  ready: boolean;
  /** True when a HTTPS funnel CDN base is configured (env or manifest default). Not the latest.json URL string. */
  cdn_base: boolean;
  whisper_model: string;
  whisper_models?: WhisperModelChoice[];
  components: Record<string, BootstrapComponentStatus>;
  default_components: string[];
  optional_components: string[];
};

export type BootstrapJobSnapshot = {
  id: string;
  kind: string;
  components: string[];
  whisper_model: string;
  status: string;
  current?: number | null;
  total?: number | null;
  message?: string | null;
  error?: string | null;
  elapsed_sec?: number;
  result?: Record<string, unknown> | null;
};

export async function fetchBootstrapStatus(
  whisperModel?: string,
): Promise<BootstrapStatus> {
  const query =
    whisperModel != null && whisperModel !== ""
      ? `?whisper_model=${encodeURIComponent(whisperModel)}`
      : "";
  const res = await hostFetch(`/api/bootstrap/status${query}`);
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return (await res.json()) as BootstrapStatus;
}

export async function runBootstrap(opts?: {
  components?: string[];
  whisper_model?: string;
  force?: boolean;
}): Promise<{ job: BootstrapJobSnapshot }> {
  const res = await hostFetch("/api/bootstrap/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      components: opts?.components ?? null,
      whisper_model: opts?.whisper_model ?? null,
      force: opts?.force ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return (await res.json()) as { job: BootstrapJobSnapshot };
}

export function bootstrapEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/bootstrap/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/bootstrap/events";
}

export type DistributionMetadata = {
  support_url: string;
  report_available: boolean;
  privacy_url: string;
  repository_url: string;
  release_manifest_url: string | null;
};

export async function fetchDiagnosticsMeta(): Promise<DistributionMetadata> {
  const res = await hostFetch("/api/diagnostics");
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<DistributionMetadata>;
}

export type DiagnosticsBundleResult = {
  path: string;
  filename: string;
  support_url: string;
  size_bytes: number;
  files: string[];
  app_version: string;
  created_at: string;
};

export async function submitDiagnosticsReport(input: {
  filename: string;
  description: string;
  consent: boolean;
}): Promise<{ status: string; status_url: string }> {
  const res = await hostFetch("/api/diagnostics/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json() as Promise<{ status: string; status_url: string }>;
}

export async function fetchDiagnosticsReportStatus(
  url: string,
): Promise<{ status: string; issue_url: string | null }> {
  const res = await hostFetch(
    `/api/diagnostics/report-status?url=${encodeURIComponent(url)}`,
  );
  if (!res.ok) throw new Error(await readApiError(res));
  return res.json() as Promise<{ status: string; issue_url: string | null }>;
}

export async function createDiagnosticsBundle(opts?: {
  outDir?: string;
  path?: string;
}): Promise<DiagnosticsBundleResult> {
  const res = await hostFetch("/api/diagnostics/bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      out_dir: opts?.outDir ?? null,
      path: opts?.path ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<DiagnosticsBundleResult>;
}

export async function fetchBootstrapJob(
  jobId: string,
): Promise<BootstrapJobSnapshot | null> {
  const res = await hostFetch(
    `/api/bootstrap/status-job?job_id=${encodeURIComponent(jobId)}`,
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const body = (await res.json()) as { job?: BootstrapJobSnapshot | null };
  return body.job ?? null;
}

/** Wait for a bootstrap job via SSE; re-check status-job when EventSource errors and every JOB_STREAM_RECHECK_MS while the stream is open (backstop for a silent stream; no hard timeout because model downloads can be long). */
export function waitForBootstrapJob(
  jobId: string,
  opts?: {
    onUpdate?: (job: BootstrapJobSnapshot) => void;
  },
): Promise<BootstrapJobSnapshot> {
  return new Promise<BootstrapJobSnapshot>((resolve, reject) => {
    let settled = false;
    const es = new EventSource(bootstrapEventsUrl(jobId));

    const recheck = window.setInterval(() => {
      void fetchBootstrapJob(jobId)
        .then((job) => consider(job))
        .catch(() => {
          /* ignore transient */
        });
    }, JOB_STREAM_RECHECK_MS);

    const cleanup = () => {
      window.clearInterval(recheck);
      es.close();
    };

    const finishOk = (job: BootstrapJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(job);
    };

    const finishErr = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    const consider = (job: BootstrapJobSnapshot | null | undefined) => {
      if (!job) {
        return;
      }
      opts?.onUpdate?.(job);
      if (job.status === "ok") {
        finishOk(job);
      } else if (job.status === "error" || job.status === "cancelled") {
        finishErr(
          new Error(job.error || job.message || `Bootstrap ${job.status}`),
        );
      }
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as {
          type?: string;
          job?: BootstrapJobSnapshot;
        };
        if (data.job) {
          consider(data.job);
        } else if (data.type === "done") {
          void fetchBootstrapJob(jobId)
            .then((job) => {
              if (job) {
                consider(job);
              } else {
                finishOk({
                  id: jobId,
                  kind: "bootstrap",
                  components: [],
                  whisper_model: "",
                  status: "ok",
                });
              }
            })
            .catch((e: unknown) => {
              finishErr(e instanceof Error ? e : new Error(String(e)));
            });
        }
      } catch {
        /* ignore malformed SSE */
      }
    };

    es.onerror = () => {
      void fetchBootstrapJob(jobId)
        .then((job) => {
          consider(job);
          if (!settled && es.readyState === EventSource.CLOSED) {
            finishErr(
              new Error("Lost connection while waiting for bootstrap job"),
            );
          }
        })
        .catch(() => {
          /* ignore transient */
        });
    };
  });
}
