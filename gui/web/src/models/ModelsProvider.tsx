import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type BootstrapJobSnapshot,
  cancelBootstrap,
  fetchBootstrapJob,
  fetchBootstrapStatus,
  removeBootstrapModel,
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
import type {
  DownloadOptions,
  DownloadOutcome,
  ModelFailure,
  RemoveOutcome,
} from "./types";
import { type ModelsApi, ModelsContext } from "./useModels";

const BUSY_CODE = "bootstrap_job_running";

const NONE: readonly string[] = [];

type DownloadSlot =
  | { kind: "starting"; cancelRequested: boolean }
  | { kind: "running"; id: string };

/**
 * The one owner of model status and of the server's single download slot. It reads status at mount
 * and again when a job ends (never on a progress frame), adopts a job it finds running, and starts a
 * download only when `download` is called.
 */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [startingModelIds, setStartingModelIds] = useState<readonly string[]>(
    [],
  );
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const latest = useLatestRequest();
  const mounted = useMountedRef();
  const controller = useRef<AbortController | null>(null);
  const running = useRef<DownloadSlot | null>(null);
  const requested = useRef<string | undefined>(undefined);

  const reload = useCallback(async () => {
    const token = latest.begin();
    dispatch({ type: "loadStarted" });
    try {
      const next = await fetchBootstrapStatus(requested.current);
      if (latest.isCurrent(token)) {
        dispatch({ type: "statusLoaded", status: next });
        return next;
      }
      return null;
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
      const slot: DownloadSlot = { kind: "running", id: job.id };
      running.current = slot;
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
        if (running.current === slot) running.current = null;
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

  const cancelJob = useCallback(
    async (id: string) => {
      try {
        await cancelBootstrap(id);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const download = useCallback(
    async (
      ids: string[],
      options?: DownloadOptions,
    ): Promise<DownloadOutcome> => {
      if (running.current !== null) {
        return { kind: "busy" };
      }
      const pending: DownloadSlot = {
        kind: "starting",
        cancelRequested: false,
      };
      running.current = pending;
      if (options?.whisperModel && ids.includes("whisper")) {
        dispatch({ type: "variantChosen", variant: options.whisperModel });
        requested.current = options.whisperModel;
        if (options.whisperModel !== stateRef.current.status?.whisper_model) {
          void reload();
        }
      }
      dispatch({ type: "downloadStarted", ids });
      setStartingModelIds(ids);
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
        const outcome = track(started.job, ids);
        setStartingModelIds(NONE);
        if (pending.cancelRequested) void cancelJob(started.job.id);
        return await outcome;
      } catch (e: unknown) {
        setStartingModelIds(NONE);
        if (running.current === pending) running.current = null;
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
    [adoptRunning, track, reload, cancelJob],
  );

  const cancel = useCallback(async () => {
    const slot = running.current;
    if (slot?.kind === "starting") {
      slot.cancelRequested = true;
      return;
    }
    if (slot) await cancelJob(slot.id);
  }, [cancelJob]);

  const remove = useCallback(
    async (id: string, variant?: string | null): Promise<RemoveOutcome> => {
      try {
        await removeBootstrapModel(id, id === "whisper" ? variant : null);
      } catch (e: unknown) {
        if (
          e instanceof ApiError &&
          (e.code === BUSY_CODE || e.code === "pipeline_busy")
        ) {
          return { kind: "busy" };
        }
        return { kind: "failed", plain: plainError(errorMessage(e)) };
      }
      await reload();
      return { kind: "ok" };
    },
    [reload],
  );

  const refresh = useCallback(async () => {
    await reload();
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
        ? overlay(
            state.status,
            state.job,
            state.failures,
            state.variant,
            startingModelIds,
            state.observation.kind,
          )
        : null,
      tools: toolsOf(state.status),
      ready:
        state.observation.kind === "current" &&
        state.status?.whisper_model === state.variant &&
        (state.status?.ready ?? false),
      observation: state.observation,
      busy: state.job !== null || startingModelIds.length > 0,
      loadError: state.loadError,
      whisper: {
        variant: state.variant,
        variants: state.status?.whisper_models ?? [],
        choose,
      },
      download,
      cancel,
      remove,
      refresh,
    }),
    [state, startingModelIds, choose, download, cancel, remove, refresh],
  );

  return (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}
