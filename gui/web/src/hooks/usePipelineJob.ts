import { useEffect, useEffectEvent, useRef } from "react";
import { loadPipelineStatus, pipelineEventsUrl } from "../api";
import type {
  PipelineEvent,
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../types/pipeline";
import { isPipelineKindJob, isPipelineRunning } from "../utils/pipeline";

const STATUS_POLL_MS = 1000;
const DISCOVER_POLL_MS = 5000;

type Options = {
  enabled?: boolean;
  activityJob?: PipelineJobSnapshot | null;
  setActivityJob?: (job: PipelineJobSnapshot | null) => void;
  setActivityRunningCount?: (count: number) => void;
};

type StatusPayload = {
  running: boolean;
  job: PipelineJobSnapshot | null;
  jobs?: PipelineJobSnapshot[];
  running_count?: number;
};

function statusJobs(st: StatusPayload): PipelineJobSnapshot[] {
  return st.jobs ?? (st.job ? [st.job] : []);
}

function chromeKey(
  job: PipelineJobSnapshot | null | undefined,
  count: number,
): string {
  return `${job?.id ?? ""}:${job?.status ?? ""}:${job?.message ?? ""}:${count}`;
}

function livePipelineJob(
  jobs: PipelineJobSnapshot[],
): PipelineJobSnapshot | undefined {
  return jobs.find((job) => isPipelineKindJob(job) && isPipelineRunning(job));
}

function pickPipelineJob(st: StatusPayload): PipelineJobSnapshot | null {
  const jobs = statusJobs(st);
  const livePipe = livePipelineJob(jobs);
  const anyPipe = jobs.find(isPipelineKindJob);
  return (
    livePipe ?? anyPipe ?? (st.job && isPipelineKindJob(st.job) ? st.job : null)
  );
}

/** Apply /api/pipeline/status to pipeline vs activity chrome. Always clears stale pipelineJob. */
export function applyPipelineJobStatus(
  st: StatusPayload,
  setPipelineJob: (job: PipelineJobSnapshot | null) => void,
  setActivityJob?: (job: PipelineJobSnapshot | null) => void,
  setActivityRunningCount?: (count: number) => void,
): void {
  const jobs = statusJobs(st);
  const running = jobs.filter(isPipelineRunning);
  setActivityRunningCount?.(st.running_count ?? running.length);
  setActivityJob?.(st.job ?? null);
  setPipelineJob(pickPipelineJob(st));
}

export const applyStatus = applyPipelineJobStatus;

export function attachTargetId(st: PipelineStatusResponse): string | null {
  const livePipe = livePipelineJob(statusJobs(st));
  if (livePipe) {
    return livePipe.id;
  }
  if (st.running && st.job && isPipelineRunning(st.job)) {
    return st.job.id;
  }
  return null;
}

/**
 * Keep pipelineJob in the store live for the whole DAW session (status bar +
 * Pipeline tab). SSE for pipeline step transitions; 1s status poll owns
 * activityJob / running_count so an agent stream cannot steal pipeline chrome.
 * Discovers in-process agent jobs started from host MCP without a prior POST.
 */
export function usePipelineJob(
  pipelineJob: PipelineJobSnapshot | null,
  setPipelineJob: (job: PipelineJobSnapshot | null) => void,
  options: Options = {},
): void {
  const enabled = options.enabled ?? true;
  const activityJob = options.activityJob ?? null;
  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);
  const attachedJobId = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const setJobRef = useRef(setPipelineJob);
  setJobRef.current = setPipelineJob;
  const setActivityRef = useRef(options.setActivityJob);
  setActivityRef.current = options.setActivityJob;
  const setCountRef = useRef(options.setActivityRunningCount);
  setCountRef.current = options.setActivityRunningCount;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const discoverKeyRef = useRef<string | null>(null);

  const stopPoll = () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const apply = (st: StatusPayload, opts?: { skipUnchanged?: boolean }) => {
    const count =
      st.running_count ?? statusJobs(st).filter(isPipelineRunning).length;
    const key = chromeKey(st.job, count);
    if (opts?.skipUnchanged && discoverKeyRef.current === key) {
      return;
    }
    discoverKeyRef.current = key;
    applyPipelineJobStatus(
      st,
      setJobRef.current,
      setActivityRef.current,
      setCountRef.current,
    );
  };

  const attachEvents = useEffectEvent((jobId: string) => {
    if (!enabledRef.current || !mountedRef.current) {
      return;
    }

    const startPoll = () => {
      if (pollRef.current != null) {
        return;
      }
      pollRef.current = window.setInterval(() => {
        void loadPipelineStatus({ signal: abortRef.current?.signal })
          .then((st) => {
            if (!mountedRef.current) {
              return;
            }
            apply(st);
            if (!st.running) {
              stopPoll();
              esRef.current?.close();
              esRef.current = null;
              attachedJobId.current = null;
            }
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === "AbortError") {
              return;
            }
            /* ignore transient poll errors */
          });
      }, STATUS_POLL_MS);
    };

    if (attachedJobId.current === jobId && esRef.current) {
      startPoll();
      return;
    }
    esRef.current?.close();
    attachedJobId.current = jobId;
    const es = new EventSource(pipelineEventsUrl(jobId));
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as PipelineEvent;
        if (data.job) {
          if (isPipelineKindJob(data.job)) {
            setJobRef.current(data.job);
          }
          setActivityRef.current?.(data.job);
        }
        if (data.type === "done") {
          es.close();
          esRef.current = null;
          attachedJobId.current = null;
          void loadPipelineStatus({ signal: abortRef.current?.signal })
            .then((st) => {
              if (!mountedRef.current) {
                return;
              }
              apply(st);
              if (!st.running) {
                stopPoll();
                return;
              }
              const next = attachTargetId(st);
              if (next) {
                attachEvents(next);
              }
            })
            .catch((err: unknown) => {
              if (err instanceof DOMException && err.name === "AbortError") {
                return;
              }
            });
        }
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      es.close();
      esRef.current = null;
      attachedJobId.current = null;
      startPoll();
      void loadPipelineStatus({ signal: abortRef.current?.signal })
        .then((st) => {
          if (!mountedRef.current) {
            return;
          }
          apply(st);
          if (!st.running) {
            stopPoll();
            return;
          }
          const next = attachTargetId(st);
          if (!next) {
            return;
          }
          clearReconnectTimer();
          reconnectTimerRef.current = window.setTimeout(() => {
            reconnectTimerRef.current = null;
            if (!enabledRef.current || !mountedRef.current) {
              return;
            }
            attachEvents(next);
          }, 2000);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
        });
    };
    startPoll();
  });

  // Bootstrap + discover jobs started outside this viewer (host MCP fan-in).
  useEffect(() => {
    if (!enabled) {
      return;
    }
    mountedRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    void loadPipelineStatus({ signal: ac.signal })
      .then((st) => {
        if (!mountedRef.current) {
          return;
        }
        apply(st);
        const target = attachTargetId(st);
        if (target) {
          attachEvents(target);
        }
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
      });

    const discover = window.setInterval(() => {
      void loadPipelineStatus({ signal: ac.signal })
        .then((st) => {
          if (!mountedRef.current) {
            return;
          }
          apply(st, { skipUnchanged: true });
          const target = attachTargetId(st);
          if (target && attachedJobId.current !== target) {
            attachEvents(target);
          }
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }
          /* ignore */
        });
    }, DISCOVER_POLL_MS);

    return () => {
      mountedRef.current = false;
      ac.abort();
      abortRef.current = null;
      window.clearInterval(discover);
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
      attachedJobId.current = null;
      stopPoll();
    };
  }, [enabled]);

  const runningJobId = (() => {
    if (pipelineJob && isPipelineRunning(pipelineJob)) {
      return pipelineJob.id;
    }
    if (activityJob && isPipelineRunning(activityJob)) {
      return activityJob.id;
    }
    return null;
  })();
  useEffect(() => {
    if (!enabled || runningJobId == null) {
      return;
    }
    attachEvents(runningJobId);
  }, [enabled, runningJobId]);
}
