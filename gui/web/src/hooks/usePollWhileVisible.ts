import { useEffect } from "react";
import { useStableCallback } from "../utils/useStableCallback";

export type PollVerdict = "continue" | "stop";

type Options<T> = {
  enabled: boolean;
  intervalMs: number;
  fetcher: (signal: AbortSignal) => Promise<T>;
  /** Return "stop" to end polling until `enabled` or `intervalMs` changes. */
  onResult: (value: T) => PollVerdict | undefined;
  onError: (error: unknown) => PollVerdict | undefined;
};

/**
 * Poll while `enabled` and the tab is visible. No timer runs while the tab is
 * hidden; coming back (visibility or window focus) reads at once and restarts
 * the cadence. One read at a time. Cleanup aborts the read in flight, and an
 * answer that lands after cleanup is dropped before `onResult` sees it.
 */
export function usePollWhileVisible<T>({
  enabled,
  intervalMs,
  fetcher,
  onResult,
  onError,
}: Options<T>): void {
  const fetchStable = useStableCallback(fetcher);
  const resultStable = useStableCallback(onResult);
  const errorStable = useStableCallback(onError);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let stopped = false;
    let busy = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
    const stop = () => {
      stopped = true;
      clearTimer();
    };
    const run = async () => {
      if (!alive || stopped || busy) return;
      busy = true;
      const own = new AbortController();
      controller = own;
      try {
        const value = await fetchStable(own.signal);
        if (!alive || own.signal.aborted) return;
        if (resultStable(value) === "stop") stop();
      } catch (error) {
        if (!alive || own.signal.aborted) return;
        if (errorStable(error) === "stop") stop();
      } finally {
        if (controller === own) controller = null;
        busy = false;
      }
    };
    const startTimer = () => {
      clearTimer();
      timer = window.setInterval(() => void run(), intervalMs);
    };
    const wake = () => {
      if (stopped || document.visibilityState !== "visible") return;
      startTimer();
      void run();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") wake();
      else clearTimer();
    };

    if (document.visibilityState === "visible") {
      startTimer();
      void run();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", wake);
    return () => {
      alive = false;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", wake);
    };
  }, [enabled, intervalMs, fetchStable, resultStable, errorStable]);
}
