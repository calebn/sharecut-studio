import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import {
  type BootstrapJobSnapshot,
  cancelBootstrap,
  fetchBootstrapJob,
  fetchBootstrapStatus,
  runBootstrap,
  waitForBootstrapJob,
} from "../api";
import { useLatestRequest } from "../hooks/useLatestRequest";
import { useMountedRef } from "../hooks/useMountedRef";
import { ApiError, errorMessage, isAbortError } from "../utils/apiError";
import { isTerminalJobStatus } from "../utils/pipeline";
import { plainError } from "../utils/plainError";
import {
  initialState,
  jobFailures,
  overlay,
  reduce,
  toolsOf,
} from "./controller";
import type { DownloadOptions, DownloadOutcome, ModelFailure } from "./types";
import { type ModelsApi, ModelsContext } from "./useModels";

const BUSY_CODE = "bootstrap_job_running";

/**
 * The one owner of model status and of the server's single download slot. It reads status at mount
 * and again when a job ends (never on a progress frame), adopts a job it finds running, and starts a
 * download only when `download` is called.
 */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const latest = useLatestRequest();
  const mounted = useMountedRef();
  const controller = useRef<AbortController | null>(null);
  const running = useRef<string | null>(null);
  const requested = useRef<string | undefined>(undefined);

  const reload = useCallback(async () => {
    const token = latest.begin();
    try {
      const next = await fetchBootstrapStatus(requested.current);
      if (latest.isCurrent(token)) {
        dispatch({ type: "statusLoaded", status: next });
      }
      return next;
    } catch (e: unknown) {
      if (latest.isCurrent(token)) {
        dispatch({ type: "loadFailed", message: errorMessage(e) });
      }
      return null;
    }
  }, [latest]);

  const track = useCallback(
    async (
      job: BootstrapJobSnapshot,
      ids: string[],
    ): Promise<DownloadOutcome> => {
      running.current = job.id;
      dispatch({ type: "jobSeen", job });
      const signal = controller.current?.signal;
      try {
        const done = await waitForBootstrapJob(job.id, {
          signal,
          onUpdate: (next) => {
            if (!isTerminalJobStatus(next.status)) {
              dispatch({ type: "jobSeen", job: next });
            }
          },
        });
        const refreshed = await reload();
        const stillMissing = done.components.filter(
          (id) =>
            (id !== "whisper" ||
              done.whisper_model === refreshed?.whisper_model) &&
            refreshed?.models.find((m) => m.id === id)?.state !== "installed",
        );
        const failures = jobFailures(done, stillMissing);
        dispatch({ type: "failed", failures });
        dispatch({ type: "jobSeen", job: done });
        if (done.status === "cancelled") {
          return { kind: "cancelled" };
        }
        const failed = ids.filter((id) => failures[id]);
        return failed.length > 0 ? { kind: "failed", failed } : { kind: "ok" };
      } catch (e: unknown) {
        if (isAbortError(e) || !mounted.current) {
          return { kind: "cancelled" };
        }
        const lost: ModelFailure = {
          kind: null,
          plain: "Lost the connection to the download. Retry it in a moment.",
        };
        dispatch({
          type: "failed",
          failures: Object.fromEntries(job.components.map((id) => [id, lost])),
        });
        dispatch({ type: "jobSeen", job: null });
        return {
          kind: "failed",
          failed: ids.filter((id) => job.components.includes(id)),
        };
      } finally {
        running.current = null;
      }
    },
    [reload, mounted],
  );

  const adoptRunning = useCallback(async () => {
    const found = await fetchBootstrapJob().catch(() => null);
    if (
      found &&
      !isTerminalJobStatus(found.status) &&
      mounted.current &&
      running.current === null
    ) {
      void track(found, []);
    }
  }, [mounted, track]);

  useEffect(() => {
    const ctrl = new AbortController();
    controller.current = ctrl;
    void reload();
    void adoptRunning();
    return () => ctrl.abort();
  }, [reload, adoptRunning]);

  const download = useCallback(
    async (
      ids: string[],
      options?: DownloadOptions,
    ): Promise<DownloadOutcome> => {
      if (running.current !== null) {
        return { kind: "busy" };
      }
      running.current = "starting";
      if (options?.whisperModel && ids.includes("whisper")) {
        dispatch({ type: "variantChosen", variant: options.whisperModel });
        requested.current = options.whisperModel;
        if (options.whisperModel !== stateRef.current.status?.whisper_model) {
          void reload();
        }
      }
      dispatch({ type: "downloadStarted", ids });
      const rows = stateRef.current.status?.models ?? [];
      const force = ids.some(
        (id) => rows.find((m) => m.id === id)?.state === "update_needed",
      );
      const whisperModel = ids.includes("whisper")
        ? (options?.whisperModel ?? stateRef.current.variant)
        : undefined;
      try {
        const started = await runBootstrap({
          components: ids,
          ...(whisperModel ? { whisper_model: whisperModel } : {}),
          force,
        });
        return await track(started.job, ids);
      } catch (e: unknown) {
        running.current = null;
        if (e instanceof ApiError && e.code === BUSY_CODE) {
          await adoptRunning();
          return { kind: "busy" };
        }
        const plain = plainError(errorMessage(e));
        const failure: ModelFailure = { kind: null, plain };
        dispatch({
          type: "failed",
          failures: Object.fromEntries(ids.map((id) => [id, failure])),
        });
        return { kind: "failed", failed: ids };
      }
    },
    [adoptRunning, track, reload],
  );

  const cancel = useCallback(async () => {
    const id = stateRef.current.job?.id;
    if (!id) {
      return;
    }
    try {
      await cancelBootstrap(id);
    } catch {
      await reload();
    }
  }, [reload]);

  const choose = useCallback(
    (variant: string) => {
      dispatch({ type: "variantChosen", variant });
      requested.current = variant;
      void reload();
    },
    [reload],
  );

  const api = useMemo<ModelsApi>(
    () => ({
      models: state.status
        ? overlay(state.status, state.job, state.failures, state.variant)
        : null,
      tools: toolsOf(state.status),
      ready: state.status?.ready ?? false,
      busy: state.job !== null,
      loadError: state.loadError,
      whisper: {
        variant: state.variant,
        variants: state.status?.whisper_models ?? [],
        choose,
      },
      download,
      cancel,
    }),
    [state, choose, download, cancel],
  );

  return (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}
