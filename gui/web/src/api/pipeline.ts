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
import { jobResultPaths } from "../utils/pipeline";

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

/** Host: async job. Guest edit share: sync rebuild on host. */
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
    const data = (await res.json()) as {
      ok?: boolean;
      render?: { ok?: boolean };
    };
    const ok = data.ok !== false && data.render?.ok !== false;
    if (!ok) {
      throw new Error("Render preview failed");
    }
    return { mode: "sync", ok: true };
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
  opts?: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal },
): Promise<string[]> {
  // Poll-only: the viewer already attaches SSE via usePipelineJob; a second
  // EventSource on the same Queue can steal `done`.
  const done = await waitForPipelineJob(jobId, {
    ...opts,
    pollOnly: true,
  });
  if (done.status !== "ok") {
    throw new Error(done.error || done.message || failLabel);
  }
  return jobResultPaths(done);
}

export async function waitForPipelineJob(
  jobId: string,
  opts?: {
    timeoutMs?: number;
    pollMs?: number;
    pollOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<PipelineJobSnapshot> {
  const timeoutMs = opts?.timeoutMs ?? 600_000;
  const pollMs = opts?.pollMs ?? 250;
  const pollOnly = opts?.pollOnly ?? false;
  const signal = opts?.signal;
  const started = Date.now();

  const fromStatus = async (): Promise<PipelineJobSnapshot | null> => {
    const st = await loadPipelineStatus();
    const rows = [st.job, ...(st.jobs ?? [])].filter(
      (job): job is PipelineJobSnapshot => job != null,
    );
    return (
      rows.find(
        (job) =>
          job.id === jobId &&
          (job.status === "ok" ||
            job.status === "error" ||
            job.status === "cancelled"),
      ) ?? null
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
    let pollTimer: number | null = null;
    const es = pollOnly ? null : new EventSource(pipelineEventsUrl(jobId));

    const finish = (job: PipelineJobSnapshot) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
      }
      window.clearTimeout(timeout);
      es?.close();
      signal?.removeEventListener("abort", onAbort);
      resolve(job);
    };

    const fail = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (pollTimer != null) {
        window.clearInterval(pollTimer);
      }
      window.clearTimeout(timeout);
      es?.close();
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

    if (es) {
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as PipelineEvent;
          const job = data.job;
          if (
            job?.id === jobId &&
            (job.status === "ok" ||
              job.status === "error" ||
              job.status === "cancelled")
          ) {
            finish(job);
          }
        } catch {
          /* ignore malformed */
        }
      };

      es.onerror = () => {
        // EventSource retries; poll as a safety net while open.
      };
    }

    pollTimer = window.setInterval(() => {
      if (Date.now() - started >= timeoutMs) {
        fail(new Error("Timed out waiting for job"));
        return;
      }
      void fromStatus()
        .then((job) => {
          if (job) {
            finish(job);
          }
        })
        .catch(() => {
          /* ignore transient */
        });
    }, pollMs);
  });
}

export function pipelineEventsUrl(jobId?: string | null): string {
  if (jobId) {
    return `/api/pipeline/events?job_id=${encodeURIComponent(jobId)}`;
  }
  return "/api/pipeline/events";
}
