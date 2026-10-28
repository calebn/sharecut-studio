import { isShareProjectKey } from "../shareMode";
import type {
  PipelineConfigResponse,
  PipelineEvent,
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../types/pipeline";
import {
  ApiError,
  modelNeededOfJob,
  notDownloadedLine,
} from "../utils/apiError";
import { isTerminalJobStatus, jobResultPaths } from "../utils/pipeline";
import { apiFetch, HOST_KEY } from "./http";
import { openJobStream } from "./jobStream";

export async function loadPipelineSteps(): Promise<string[]> {
  const res = await apiFetch(HOST_KEY, { host: "/api/pipeline/steps" });
  const data = (await res.json()) as { steps: string[] };
  return data.steps;
}

export async function loadPipelineConfig(
  projectPath: string,
): Promise<PipelineConfigResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline config is not available for shared guests");
  }
  const res = await apiFetch(HOST_KEY, {
    host: `/api/pipeline/config?path=${encodeURIComponent(projectPath)}`,
  });
  return res.json() as Promise<PipelineConfigResponse>;
}

export async function putPipelineConfig(
  projectPath: string,
  body: {
    config?: Record<string, unknown>;
    enabled_steps?: string[];
    unattended?: boolean;
    reset?: boolean;
  },
): Promise<PipelineConfigResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline config is not available for shared guests");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/pipeline/config" },
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, ...body }),
    },
  );
  return res.json() as Promise<PipelineConfigResponse>;
}

export async function loadPipelineStatus(init?: {
  signal?: AbortSignal;
}): Promise<PipelineStatusResponse> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/pipeline/status" },
    { signal: init?.signal },
  );
  return res.json() as Promise<PipelineStatusResponse>;
}

export type TranscriptVocabulary = {
  show_title: string | null;
  prompt_limit: number | null;
  prompt_primer: string;
  terms: string[];
  guest_names: string[];
  revision: string | null;
  needs_retranscription: boolean;
  /** Track ids with hand-edited transcripts; Re-transcribe asks before replacing them. */
  edited_tracks: string[];
};

export async function loadTranscriptVocabulary(
  projectPath: string,
): Promise<TranscriptVocabulary> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Vocabulary is not available for shared guests");
  }
  const params = new URLSearchParams({ path: projectPath });
  const res = await apiFetch("", {
    host: `/api/transcript/vocabulary?${params}`,
  });
  return res.json() as Promise<TranscriptVocabulary>;
}

export async function saveTranscriptVocabulary(
  projectPath: string,
  vocabulary: Pick<TranscriptVocabulary, "terms" | "guest_names"> & {
    base_revision: string | null;
  },
): Promise<TranscriptVocabulary> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Vocabulary is not available for shared guests");
  }
  const res = await apiFetch(
    "",
    { host: "/api/transcript/vocabulary" },
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath, ...vocabulary }),
    },
  );
  return res.json() as Promise<TranscriptVocabulary>;
}

export async function startPipelineRun(
  projectPath: string,
  opts?: {
    fromStep?: string;
    onlyStep?: string;
    skipSteps?: string[];
    enabledSteps?: string[];
    unattended?: boolean;
    config?: Record<string, unknown>;
    useWorkingSet?: boolean;
    forceTranscribe?: boolean;
    retimeWords?: boolean;
    overwriteEdited?: boolean;
  },
): Promise<PipelineJobSnapshot> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline is not available for shared guests");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/pipeline/run" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: projectPath,
        from_step: opts?.fromStep ?? null,
        only_step: opts?.onlyStep ?? null,
        skip_steps: opts?.skipSteps ?? null,
        enabled_steps: opts?.enabledSteps ?? null,
        unattended: opts?.unattended ?? null,
        config: opts?.config ?? null,
        use_working_set: opts?.useWorkingSet ?? true,
        force_transcribe: opts?.forceTranscribe ?? false,
        retime_words: opts?.retimeWords ?? false,
        overwrite_edited: opts?.overwriteEdited ?? false,
      }),
    },
  );
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

export async function cancelPipelineRun(
  jobId?: string | null,
): Promise<PipelineJobSnapshot> {
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/pipeline/cancel" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ job_id: jobId ?? null }),
    },
  );
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

/** Host: async job. Guest edit share: poll its token-scoped render job. */
export async function startRenderPreview(
  projectPath: string,
): Promise<
  { mode: "job"; job: PipelineJobSnapshot } | { mode: "sync"; ok: boolean }
> {
  if (isShareProjectKey(projectPath)) {
    const res = await apiFetch(
      projectPath,
      { guest: "/daw/render-preview" },
      { method: "POST" },
    );
    const data = (await res.json()) as { job: { id: string } };
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const statusRes = await apiFetch(projectPath, {
        guest: `/daw/render-preview/${encodeURIComponent(data.job.id)}`,
      });
      const status = (await statusRes.json()) as {
        job: { status: string; error: string | null };
      };
      if (status.job.status === "ok") {
        return { mode: "sync", ok: true };
      }
      // ok returned above, so any other terminal status is a failure.
      if (isTerminalJobStatus(status.job.status)) {
        throw new Error(status.job.error ?? "Render preview failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Timed out waiting for render preview");
  }
  const res = await apiFetch(
    HOST_KEY,
    { host: "/api/pipeline/render-preview" },
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: projectPath }),
    },
  );
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return { mode: "job", job: data.job };
}
/**
 * A followed job ended `cancelled`: someone asked it to stop. Not a failure.
 * `job` is the terminal snapshot; a cancel that came after the job wrote its
 * files still lists them in `result.paths`.
 */
export class JobCancelledError extends Error {
  override name = "JobCancelledError";
  readonly job: PipelineJobSnapshot;

  constructor(job: PipelineJobSnapshot, message: string) {
    super(message);
    this.job = job;
  }
}

/**
 * The error a failed job raises: a `model_needed` ApiError when the snapshot
 * names the missing model, so a model gate can offer the download.
 */
export function jobFailure(
  done: PipelineJobSnapshot,
  failLabel: string,
): Error {
  const model = modelNeededOfJob(done);
  return model
    ? new ApiError(notDownloadedLine(model), "model_needed", 409, model)
    : new Error(done.error || done.message || failLabel);
}

/**
 * Follow a job to its terminal snapshot. Resolves only on `ok`; a cancelled job
 * throws `JobCancelledError`, a failed one an `Error` with its message.
 */
export async function followJobToOk(
  jobId: string,
  failLabel: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<PipelineJobSnapshot> {
  const done = await waitForPipelineJob(jobId, opts);
  if (done.status === "cancelled") {
    throw new JobCancelledError(done, done.message || failLabel);
  }
  if (done.status !== "ok") {
    throw jobFailure(done, failLabel);
  }
  return done;
}

export async function followExportJob(
  jobId: string,
  failLabel: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string[]> {
  return jobResultPaths(await followJobToOk(jobId, failLabel, opts));
}

/**
 * Wait until a Studio job reaches ok|error|cancelled.
 *
 * Checks the current status once (a job can already be terminal), then
 * follows that job's own SSE stream: each subscriber has its own queue, so
 * any number of concurrent callers get the full stream. If the stream
 * closes without a terminal job, a one-shot status re-check either finishes
 * the wait or fails it with "Lost connection…". While the stream is open, a
 * status re-check every `JOB_STREAM_RECHECK_MS` finishes the wait if the
 * stream went silent.
 */
export async function waitForPipelineJob(
  jobId: string,
  opts?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<PipelineJobSnapshot> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const signal = opts?.signal;

  const fromStatus = async (): Promise<PipelineJobSnapshot | null> => {
    const st = await loadPipelineStatus();
    const rows = [st.job, ...(st.jobs ?? [])].filter(
      (job): job is PipelineJobSnapshot => job != null,
    );
    return (
      rows.find((job) => job.id === jobId && isTerminalJobStatus(job.status)) ??
      null
    );
  };

  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const early = await fromStatus();
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (early) {
    return early;
  }

  return new Promise<PipelineJobSnapshot>((resolve, reject) => {
    let settled = false;
    const stream = openJobStream<PipelineEvent, PipelineJobSnapshot>({
      url: pipelineEventsUrl(jobId),
      recheck: { check: fromStatus, onResult: (job) => finish(job) },
      onFrame: (data) => {
        const job = data.job;
        if (job?.id === jobId && isTerminalJobStatus(job.status)) {
          finish(job);
        }
      },
      onError: (es) => {
        if (settled) {
          return;
        }
        void fromStatus()
          .then((job) => {
            if (job) {
              finish(job);
              return;
            }
            if (es.readyState === EventSource.CLOSED) {
              fail(new Error("Lost connection while waiting for job"));
            }
          })
          .catch(() => {
            /* ignore transient */
          });
      },
    });

    const finish = (job: PipelineJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      stream.close();
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      stream.close();
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    };

    const onAbort = () => {
      fail(new DOMException("Aborted", "AbortError"));
    };

    const timeout = window.setTimeout(() => {
      fail(new Error("Timed out waiting for job"));
    }, timeoutMs);

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export function pipelineEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/pipeline/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/pipeline/events";
}
