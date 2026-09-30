import { hostFetch } from "../api/documentTransport";
import {
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import type {
  PipelineAnalyzeResponse,
  PipelineConfigResponse,
  PipelineEvent,
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../types/pipeline";
import { readApiError, readApiFailure } from "../utils/apiError";
import { isTerminalJobStatus, jobResultPaths } from "../utils/pipeline";

export async function loadPipelineSteps(): Promise<string[]> {
  const res = await hostFetch("/api/pipeline/steps");
  if (!res.ok) {
    throw new Error(await res.text());
  }
  const data = (await res.json()) as { steps: string[] };
  return data.steps;
}

export async function loadPipelineConfig(
  projectPath: string,
): Promise<PipelineConfigResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline config is not available for shared guests");
  }
  const res = await hostFetch(
    `/api/pipeline/config?path=${encodeURIComponent(projectPath)}`,
  );
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
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
  const res = await hostFetch("/api/pipeline/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...body }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<PipelineConfigResponse>;
}

/** Start heuristic Analyze as a `kind=analyze` pipeline-slot job (409 while one runs). */
export async function startPipelineAnalyze(
  projectPath: string,
  opts?: { apply?: boolean },
): Promise<PipelineJobSnapshot> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline analyze is not available for shared guests");
  }
  const res = await hostFetch("/api/pipeline/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, apply: opts?.apply ?? false }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

/** Analyze decodes every dialogue track; a multi-hour episode can outlast the 10 min default (stays under the 2^31-1 ms timer cap). */
export const ANALYZE_WAIT_MS = 6 * 60 * 60 * 1000;

/** Fire-and-forget cancel for an Analyze job its caller abandoned (the pipeline slot is process-wide). */
function cancelAbandonedJob(jobId: string): void {
  void cancelPipelineRun(jobId).catch(() => undefined);
}

/**
 * Start Analyze, hand its job to `onJob` (seed Studio chrome), then follow it to a
 * terminal snapshot. Resolves the Analyze response carried on `result` (also for a
 * cancel that landed after the working set was patched), `null` when it was cancelled
 * before a result, and throws the job error when it failed. Aborting `signal` (even
 * while the start POST is in flight) stops the wait and cancels the started job, so an
 * abandoned Analyze never holds the process-wide pipeline slot.
 */
export async function analyzePipeline(
  projectPath: string,
  opts?: {
    apply?: boolean;
    signal?: AbortSignal;
    onJob?: (job: PipelineJobSnapshot) => void;
  },
): Promise<PipelineAnalyzeResponse | null> {
  const signal = opts?.signal;
  // The start POST is deliberately not aborted: once the server has it a job may
  // exist, and only the response names it, so an abort is honoured right after.
  const job = await startPipelineAnalyze(projectPath, { apply: opts?.apply });
  if (signal?.aborted) {
    cancelAbandonedJob(job.id);
    throw new DOMException("Aborted", "AbortError");
  }
  opts?.onJob?.(job);
  let done: PipelineJobSnapshot;
  try {
    done = await waitForPipelineJob(job.id, {
      timeoutMs: ANALYZE_WAIT_MS,
      signal,
    });
  } catch (e) {
    if (signal?.aborted) {
      cancelAbandonedJob(job.id);
    }
    throw e;
  }
  if (done.result) {
    return done.result as unknown as PipelineAnalyzeResponse;
  }
  if (done.status === "cancelled") {
    return null;
  }
  throw new Error(done.error || "Analyze failed");
}

export async function loadPipelineStatus(init?: {
  signal?: AbortSignal;
}): Promise<PipelineStatusResponse> {
  const res = await hostFetch("/api/pipeline/status", { signal: init?.signal });
  if (!res.ok) {
    throw new Error(await res.text());
  }
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
  const res = await hostFetch(`/api/transcript/vocabulary?${params}`);
  if (!res.ok) throw await readApiFailure(res);
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
  const res = await hostFetch("/api/transcript/vocabulary", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath, ...vocabulary }),
  });
  if (!res.ok) throw await readApiFailure(res);
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
  const res = await hostFetch("/api/pipeline/run", {
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
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return data.job;
}

export async function cancelPipelineRun(
  jobId?: string | null,
): Promise<PipelineJobSnapshot> {
  const res = await hostFetch("/api/pipeline/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ job_id: jobId ?? null }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
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
    const token = shareTokenFromKey(projectPath)!;
    const res = await fetch(`${reviewApiBase(token)}/daw/render-preview`, {
      method: "POST",
    });
    if (!res.ok) {
      throw new Error(await readApiError(res));
    }
    const data = (await res.json()) as { job: { id: string } };
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      const statusRes = await fetch(
        `${reviewApiBase(token)}/daw/render-preview/${encodeURIComponent(data.job.id)}`,
      );
      if (!statusRes.ok) {
        throw new Error(await readApiError(statusRes));
      }
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
  const res = await hostFetch("/api/pipeline/render-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: projectPath }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  const data = (await res.json()) as { job: PipelineJobSnapshot };
  return { mode: "job", job: data.job };
}
export async function followExportJob(
  jobId: string,
  failLabel: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<string[]> {
  const done = await waitForPipelineJob(jobId, opts);
  if (done.status !== "ok") {
    throw new Error(done.error || done.message || failLabel);
  }
  return jobResultPaths(done);
}

/** Slow status re-check while a job SSE stream is open: backstop for a stream that stays OPEN but goes silent (buffering proxy, half-open socket, backgrounded webview). */
export const JOB_STREAM_RECHECK_MS = 15_000;

/**
 * Re-check a job every `JOB_STREAM_RECHECK_MS` while its SSE stream is open
 * (backstop for a stream that stays open but goes silent). Transient fetch
 * errors are ignored; null results are skipped. Returns a stop function.
 * Session-wide hooks that poll only while their stream is down
 * (`usePipelineJob`, `useGuestSync`) use `createFallbackPoll` in
 * `utils/fallbackPoll.ts` instead.
 */
export function startJobStatusRecheck<T>(
  check: () => Promise<T | null | undefined>,
  onResult: (result: T) => void,
): () => void {
  const id = window.setInterval(() => {
    void check()
      .then((result) => {
        if (result != null) {
          onResult(result);
        }
      })
      .catch(() => {
        /* ignore transient */
      });
  }, JOB_STREAM_RECHECK_MS);
  return () => window.clearInterval(id);
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
    const es = new EventSource(pipelineEventsUrl(jobId));

    const finish = (job: PipelineJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      stopRecheck();
      es.close();
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeout);
      stopRecheck();
      es.close();
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    };

    const onAbort = () => {
      fail(new DOMException("Aborted", "AbortError"));
    };

    const timeout = window.setTimeout(() => {
      fail(new Error("Timed out waiting for job"));
    }, timeoutMs);

    const stopRecheck = startJobStatusRecheck(fromStatus, finish);

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      onAbort();
    }

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as PipelineEvent;
        const job = data.job;
        if (job?.id === jobId && isTerminalJobStatus(job.status)) {
          finish(job);
        }
      } catch {
        /* ignore malformed */
      }
    };

    es.onerror = () => {
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
    };
  });
}

export function pipelineEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/pipeline/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/pipeline/events";
}
