/** Slow status re-check while a job SSE stream is open: backstop for a stream that stays OPEN but goes silent (buffering proxy, half-open socket, backgrounded webview). */
export const JOB_STREAM_RECHECK_MS = 15_000;

/**
 * Re-check a job every `JOB_STREAM_RECHECK_MS` while its SSE stream is open.
 * Transient fetch errors are ignored; null results are skipped. Returns a
 * stop function. Session-wide hooks that poll only while their stream is down
 * (`usePipelineJob`, `useGuestSync`) use `createFallbackPoll` instead.
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

export type JobStreamOptions<Frame, Job> = {
  url: string;
  /** One parsed JSON frame; malformed frames are dropped before this. */
  onFrame: (frame: Frame, source: EventSource) => void;
  onError?: (source: EventSource) => void;
  /** Periodic status backstop that runs for as long as the stream is open. */
  recheck?: {
    check: () => Promise<Job | null | undefined>;
    onResult: (job: Job) => void;
  };
};

export type JobStream = {
  source: EventSource;
  /** Close the stream and stop its recheck. */
  close: () => void;
};

/** The one place a job SSE stream is opened. */
export function openJobStream<Frame, Job = never>(
  options: JobStreamOptions<Frame, Job>,
): JobStream {
  const source = new EventSource(options.url);
  const stopRecheck = options.recheck
    ? startJobStatusRecheck(options.recheck.check, options.recheck.onResult)
    : null;
  source.onmessage = (ev) => {
    try {
      options.onFrame(JSON.parse(ev.data) as Frame, source);
    } catch {
      /* a malformed frame or a throwing handler must not break the stream */
    }
  };
  source.onerror = () => options.onError?.(source);
  return {
    source,
    close: () => {
      stopRecheck?.();
      source.close();
    },
  };
}
