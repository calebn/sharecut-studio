import { useEffect, useEffectEvent, useRef } from "react";
import { loadPipelineStatus, pipelineEventsUrl } from "../api";
import type {
  PipelineEvent,
  PipelineJobSnapshot,
  PipelineStatusResponse,
} from "../types/pipeline";
import { isAbortError } from "../utils/apiError";
import { createFallbackPoll, type FallbackPoll } from "../utils/fallbackPoll";
import { isPipelineKindJob, isPipelineRunning } from "../utils/pipeline";

const STATUS_POLL_MS = 1000;
const DISCOVER_POLL_MS = 5000;
/** No frame for this long (server keepalive is 1s) counts as the stream being down. */
const STREAM_SILENCE_MS = 5000;

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
 * Pipeline tab). The attached job's SSE stream (connect snapshot, live
 * events, 1s keepalive snapshots, `done`) is the only source for that job
 * while it is open; the 1s status poll runs only while the stream is down
 * (from `onerror`, or `STREAM_SILENCE_MS` without a frame, until a
 * reconnected stream delivers a frame). The 5s discover poll owns
 * activityJob / running_count for other jobs and discovers in-process agent
 * jobs started from host MCP without a prior POST; a stream frame updates
 * activityJob only when no other job is the live primary, so a non-attached
 * primary's chip refreshes at the 5s discover cadence.
 */
export function usePipelineJob(
  pipelineJob: PipelineJobSnapshot | null,
  setPipelineJob: (job: PipelineJobSnapshot | null) => void,
  options: Options = {},
): void {
  const enabled = options.enabled ?? true;
  const activityJob = options.activityJob ?? null;
  const esRef = useRef<EventSource | null>(null);
  const statusPollRef = useRef<FallbackPoll | null>(null);
  const attachedJobId = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const setJobRef = useRef(setPipelineJob);
  setJobRef.current = setPipelineJob;
  const setActivityRef = useRef(options.setActivityJob);
  setActivityRef.current = options.setActivityJob;
  const setCountRef = useRef(options.setActivityRunningCount);
  setCountRef.current = options.setActivityRunningCount;
  const activityRef = useRef(activityJob);
  activityRef.current = activityJob;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const discoverKeyRef = useRef<string | null>(null);

  const stopPoll = () => {
    statusPollRef.current?.stop();
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current != null) {
      window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  /** Close the attached stream (if any) and forget it and its watchdog. */
  const closeStream = () => {
    clearSilenceTimer();
    esRef.current?.close();
    esRef.current = null;
    attachedJobId.current = null;
  };

  /**
   * True while any job stream is attached. The status fetches and the
   * reconnect timer are only fallbacks for a down stream, so a result that
   * lands while a stream is attached (even one back on the same job id) is
   * stale and must be dropped.
   */
  const streamOwnsChrome = () => esRef.current != null;

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

  // One tick of the stream-down status poll.
  const pollStatusOnce = useEffectEvent(() => {
    void loadPipelineStatus({ signal: abortRef.current?.signal })
      .then((st) => {
        // A stream that is attached BY THE TIME this result comes back owns
        // the job now, whether it (re)attached before or after this fetch
        // started — the poll is only a down-time fallback, so any live
        // stream, even one back on the same job id, wins over a stale result.
        if (!mountedRef.current || streamOwnsChrome()) {
          return;
        }
        apply(st);
        if (!st.running) {
          stopPoll();
          clearReconnectTimer();
          closeStream();
        }
      })
      .catch((err: unknown) => {
        if (isAbortError(err)) {
          return;
        }
        /* ignore transient poll errors */
      });
  });

  const attachEvents = useEffectEvent((jobId: string) => {
    if (!enabledRef.current || !mountedRef.current) {
      return;
    }
    if (attachedJobId.current === jobId && esRef.current) {
      return;
    }
    closeStream();
    attachedJobId.current = jobId;
    const es = new EventSource(pipelineEventsUrl(jobId));
    esRef.current = es;

    // `onerror`, or a stream that stays open but goes silent (buffering
    // proxy, half-open socket, sleep/wake): fall back to the status poll and
    // schedule a reconnect.
    const onStreamDown = () => {
      if (esRef.current !== es) {
        return;
      }
      closeStream();
      statusPollRef.current?.start();
      void loadPipelineStatus({ signal: abortRef.current?.signal })
        .then((st) => {
          // Same rule as pollStatusOnce: a stream that attached while this
          // re-check was in flight (discover tick, or a new running job) owns
          // the chrome now, so a stale result must not overwrite it or
          // schedule a reconnect that would close it.
          if (!mountedRef.current || streamOwnsChrome()) {
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
            // A stream attached during the 2s wait already recovered.
            if (
              !enabledRef.current ||
              !mountedRef.current ||
              streamOwnsChrome()
            ) {
              return;
            }
            attachEvents(next);
          }, 2000);
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
        });
    };

    const armSilenceWatchdog = () => {
      clearSilenceTimer();
      silenceTimerRef.current = window.setTimeout(
        onStreamDown,
        STREAM_SILENCE_MS,
      );
    };
    armSilenceWatchdog();

    es.onmessage = (ev) => {
      if (esRef.current !== es) {
        return;
      }
      // Any frame proves the stream is live again: drop the socket-down poll.
      armSilenceWatchdog();
      stopPoll();
      try {
        const data = JSON.parse(ev.data) as PipelineEvent;
        if (data.job) {
          if (isPipelineKindJob(data.job)) {
            setJobRef.current(data.job);
          }
          const primary = activityRef.current;
          if (
            primary == null ||
            primary.id === data.job.id ||
            !isPipelineRunning(primary)
          ) {
            setActivityRef.current?.(data.job);
          }
        }
        if (data.type === "done") {
          closeStream();
          void loadPipelineStatus({ signal: abortRef.current?.signal })
            .then((st) => {
              // Same rule as pollStatusOnce / onStreamDown: a stream that
              // attached while this refetch was in flight (discover tick, or a
              // prop switch to another job) owns the chrome now, so a stale
              // result must not overwrite it or reattach and close it.
              if (!mountedRef.current || streamOwnsChrome()) {
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
              if (isAbortError(err)) {
                return;
              }
            });
        }
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = onStreamDown;
  });

  // Bootstrap + discover jobs started outside this viewer (host MCP fan-in).
  useEffect(() => {
    if (!enabled) {
      return;
    }
    mountedRef.current = true;
    const ac = new AbortController();
    abortRef.current = ac;
    const statusPoll = createFallbackPoll(
      () => pollStatusOnce(),
      STATUS_POLL_MS,
    );
    statusPollRef.current = statusPoll;
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
        if (isAbortError(err)) {
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
          if (isAbortError(err)) {
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
      closeStream();
      statusPoll.stop();
      statusPollRef.current = null;
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
