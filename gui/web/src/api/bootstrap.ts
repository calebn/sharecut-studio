import type {
  ModelInstallState,
  PipelineComponentStatus,
} from "../types/pipeline";
import { isTerminalJobStatus } from "../utils/pipeline";
import { apiFetch, HOST_KEY } from "./http";
import { openJobStream } from "./jobStream";

export type WhisperModelChoice = {
  id: string;
  label: string;
  size: string;
  description: string;
  /** Present on pipeline config / bootstrap status when cache was probed. */
  cached?: boolean;
};

/** One registry model as GET /api/bootstrap/status lists it: the Pipeline component record with the registry fields present. */
export type ModelStatus = PipelineComponentStatus &
  Required<
    Pick<PipelineComponentStatus, "tier" | "label" | "size" | "model">
  > & {
    id: string;
    purpose: string;
    /** Null when the source gives no size. */
    size_bytes: number | null;
  };

export type BootstrapToolStatus = {
  state: ModelInstallState;
  source: string;
  hint: string | null;
};

export type BootstrapStatus = {
  ready: boolean;
  /** True when a HTTPS funnel CDN base is configured (env or manifest default). Not the latest.json URL string. */
  cdn_base: boolean;
  whisper_model: string;
  whisper_models: WhisperModelChoice[];
  tools: { ffmpeg: BootstrapToolStatus };
  /** Registry order: the only list of models. */
  models: ModelStatus[];
};

export type BootstrapDownload = {
  component: string;
  bytes: number;
  /** Null when the source gives no size (an unpinned Whisper model). */
  total: number | null;
};

export type BootstrapFailure = {
  kind: "http" | "pin_mismatch" | "network" | "disk";
  status: number | null;
  /** Plain text safe to show: it names no path, URL or environment variable. */
  plain: string;
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
  download?: BootstrapDownload | null;
  failure?: BootstrapFailure | null;
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
  const res = await apiFetch(HOST_KEY, {
    host: `/api/bootstrap/status${query}`,
  });
  return (await res.json()) as BootstrapStatus;
}

export async function runBootstrap(opts?: {
  components?: string[];
  whisper_model?: string;
  force?: boolean;
}): Promise<{ job: BootstrapJobSnapshot; adopted?: boolean }> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/bootstrap/run" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        components: opts?.components ?? null,
        whisper_model: opts?.whisper_model ?? null,
        force: opts?.force ?? false,
      }),
    },
  );
  return (await res.json()) as { job: BootstrapJobSnapshot; adopted?: boolean };
}

export async function cancelBootstrap(
  jobId: string,
): Promise<BootstrapJobSnapshot> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/bootstrap/cancel" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId }),
    },
  );
  return ((await res.json()) as { job: BootstrapJobSnapshot }).job;
}

export function bootstrapEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/bootstrap/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/bootstrap/events";
}

export async function fetchBootstrapJob(
  jobId?: string | null,
): Promise<BootstrapJobSnapshot | null> {
  const query = jobId ? `?job_id=${encodeURIComponent(jobId)}` : "";
  const res = await apiFetch(HOST_KEY, {
    host: `/api/bootstrap/status-job${query}`,
  });
  const body = (await res.json()) as { job?: BootstrapJobSnapshot | null };
  return body.job ?? null;
}

function aborted(): Error {
  return new DOMException("The wait was aborted", "AbortError");
}

/**
 * Wait for a bootstrap job via SSE and resolve with its terminal snapshot: `ok`, `error` or
 * `cancelled`, with `failure`, `download` and `result` intact (a failed download is data, not an
 * exception). Rejects only on transport loss or when `signal` aborts. Re-checks status-job when
 * EventSource errors and every JOB_STREAM_RECHECK_MS while the stream is open (backstop for a silent
 * stream; no hard timeout because model downloads can be long).
 */
export function waitForBootstrapJob(
  jobId: string,
  opts?: {
    onUpdate?: (job: BootstrapJobSnapshot) => void;
    signal?: AbortSignal;
  },
): Promise<BootstrapJobSnapshot> {
  return new Promise<BootstrapJobSnapshot>((resolve, reject) => {
    if (opts?.signal?.aborted) {
      reject(aborted());
      return;
    }
    let settled = false;
    const stream = openJobStream<
      { type?: string; job?: BootstrapJobSnapshot },
      BootstrapJobSnapshot
    >({
      url: bootstrapEventsUrl(jobId),
      recheck: {
        check: () =>
          fetchBootstrapJob(jobId).then((job) => {
            if (job === null) {
              // The host no longer knows this job (restart or replaced): nothing will ever finish it.
              finishErr(
                new Error("Bootstrap job is no longer known to the host"),
              );
            }
            return job;
          }),
        onResult: (job) => considerTerminal(job),
      },
      onFrame: (data) => {
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
      },
      onError: (es) => {
        void fetchBootstrapJob(jobId)
          .then((job) => {
            considerTerminal(job);
            if (!settled && es.readyState === EventSource.CLOSED) {
              finishErr(
                new Error("Lost connection while waiting for bootstrap job"),
              );
            }
          })
          .catch(() => {
            // A closed stream never retries; with status-job failing too, nothing else can settle us.
            if (!settled && es.readyState === EventSource.CLOSED) {
              finishErr(
                new Error("Lost connection while waiting for bootstrap job"),
              );
            }
          });
      },
    });

    const onAbort = () => finishErr(aborted());
    opts?.signal?.addEventListener("abort", onAbort);

    const cleanup = () => {
      opts?.signal?.removeEventListener("abort", onAbort);
      stream.close();
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
      if (!job || settled) {
        return;
      }
      opts?.onUpdate?.(job);
      if (isTerminalJobStatus(job.status)) {
        finishOk(job);
      }
    };

    // Status re-checks are a backstop only: a non-terminal snapshot must not
    // roll back newer SSE progress, so they act only on a terminal job.
    const considerTerminal = (job: BootstrapJobSnapshot | null | undefined) => {
      if (job && isTerminalJobStatus(job.status)) {
        consider(job);
      }
    };
  });
}
