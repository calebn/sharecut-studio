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

export async function analyzePipeline(
  projectPath: string,
  opts?: { apply?: boolean },
): Promise<PipelineAnalyzeResponse> {
  if (isShareProjectKey(projectPath)) {
    throw new Error("Pipeline analyze is not available for shared guests");
  }
  const res = await hostFetch("/api/pipeline/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: projectPath,
      apply: opts?.apply ?? false,
    }),
  });
  if (!res.ok) {
    throw new Error(await readApiError(res));
  }
  return res.json() as Promise<PipelineAnalyzeResponse>;
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
