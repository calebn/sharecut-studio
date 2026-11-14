import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type BootstrapJobSnapshot,
  type BootstrapStatus,
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
import type { NeedTarget } from "./capability";
import {
  canPickFolderOf,
  downloadRows,
  failureKey,
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
  ModelObservation,
  RemoveOutcome,
} from "./types";
import { type ModelsApi, ModelsContext } from "./useModels";

const BUSY_CODE = "bootstrap_job_running";

const NONE: readonly string[] = [];

type DownloadSlot =
  | { kind: "starting"; cancelRequested: boolean }
  | { kind: "running"; id: string };

export function ModelsProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const [startingModelIds, setStartingModelIds] = useState<readonly string[]>(
    [],
  );
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  const latest = useLatestRequest();
  const mounted = useMountedRef();
  const controller = useRef<AbortController | null>(null);
  const running = useRef<DownloadSlot | null>(null);
  const requested = useRef<string | undefined>(undefined);
  const readGeneration = useRef(0);
  const variantReads = useRef(new Map<string, number>());
  const startingVariant = useRef("");

  const readVariant = useCallback(
    async (variant: string | undefined): Promise<BootstrapStatus | null> => {
      const generation = ++readGeneration.current;
      const key = variant ?? stateRef.current.variant;
      variantReads.current.set(key, generation);
      if (key)
        dispatch({ type: "variantReadStarted", variant: key, generation });
      try {
        const status = await fetchBootstrapStatus(variant);
        if (!mounted.current || variantReads.current.get(key) !== generation)
          return null;
        const target = variant ?? status.whisper_model;
        if ((variantReads.current.get(target) ?? 0) <= generation) {
          variantReads.current.set(target, generation);
          dispatch({
            type: "variantReadFinished",
            variant: target,
            generation,
            status,
          });
        }
        return status;
      } catch (error: unknown) {
        if (!mounted.current || variantReads.current.get(key) !== generation)
          return null;
        if (key)
          dispatch({
            type: "variantReadFinished",
            variant: key,
            generation,
            status: null,
          });
        throw error;
      }
    },
    [mounted],
  );

  const readTarget = useCallback(
    async (variant: string) => {
      return readVariant(variant).catch(() => null);
    },
    [readVariant],
  );

  const reload = useCallback(
    async (variant: string | undefined = requested.current) => {
      const token = latest.begin();
      dispatch({ type: "loadStarted" });
      try {
        const next = await readVariant(variant);
        if (next && latest.isCurrent(token)) {
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
    },
    [latest, readVariant],
  );

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
        const target =
          done.components.includes("whisper") &&
          done.whisper_model !== stateRef.current.variant
            ? await readTarget(done.whisper_model)
            : null;
        const selected = await reload(
          done.components.includes("whisper") &&
            done.whisper_model === stateRef.current.variant
            ? done.whisper_model
            : undefined,
        );
        const refreshed =
          done.components.includes("whisper") &&
          done.whisper_model !== selected?.whisper_model
            ? target
            : selected;
        const stillMissing = done.components.filter(
          (id) =>
            !(
              (id !== "whisper" ||
                done.whisper_model === refreshed?.whisper_model) &&
              refreshed?.models.find((m) => m.id === id)?.state === "installed"
            ),
        );
        const failures = jobFailures(done, stillMissing);
        dispatch({ type: "failed", failures });
        dispatch({ type: "jobSeen", job: done });
        if (done.status === "cancelled") {
          return { kind: "cancelled" };
        }
        const failed = ids.filter(
          (id) => failures[failureKey(id, done.whisper_model)],
        );
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
          failures: Object.fromEntries(
            job.components.map((id) => [
              failureKey(id, job.whisper_model),
              lost,
            ]),
          ),
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
    [reload, readTarget, mounted],
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
    const reads = variantReads.current;
    void reload();
    void adoptRunning();
    return () => {
      reads.clear();
      ctrl.abort();
    };
  }, [reload, adoptRunning]);

  const jobVariant = state.job?.components.includes("whisper")
    ? state.job.whisper_model
    : null;
  const jobObservation = jobVariant ? state.variants[jobVariant] : null;
  useEffect(() => {
    if (state.status && jobVariant && !jobObservation)
      void readTarget(jobVariant);
  }, [state.status, jobVariant, jobObservation, readTarget]);

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
      const whisperModel = options?.whisperModel ?? stateRef.current.variant;
      startingVariant.current = whisperModel;
      dispatch({ type: "downloadStarted", ids, variant: whisperModel });
      setStartingModelIds(ids);
      const current = stateRef.current;
      const target = current.variants[whisperModel];
      const force = ids.some((id) => {
        const observation =
          id === "whisper" ? target?.observation : current.observation;
        const status = id === "whisper" ? target?.status : current.status;
        return (
          observation?.kind === "current" &&
          status?.models.find((model) => model.id === id)?.state ===
            "update_needed"
        );
      });
      try {
        const started = await runBootstrap({
          components: ids,
          ...(ids.includes("whisper") && whisperModel
            ? { whisper_model: whisperModel }
            : {}),
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
          failures: Object.fromEntries(
            ids.map((id) => [failureKey(id, whisperModel), failure]),
          ),
        });
        return { kind: "failed", failed: ids };
      }
    },
    [adoptRunning, track, cancelJob],
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
      if (id === "whisper" && variant && variant !== stateRef.current.variant) {
        await readTarget(variant);
      }
      await reload();
      return { kind: "ok" };
    },
    [reload, readTarget],
  );

  const refresh = useCallback(async () => {
    const targets = [...variantReads.current.keys()].filter(
      (variant) => variant && variant !== stateRef.current.variant,
    );
    await Promise.all([...targets.map(readTarget), reload()]);
  }, [reload, readTarget]);

  const observe = useCallback(
    async (target: Pick<NeedTarget, "id" | "variant">) => {
      if (
        target.id === "whisper" &&
        target.variant &&
        target.variant !== stateRef.current.variant
      ) {
        await readTarget(target.variant);
      } else {
        await reload(
          target.id === "whisper" ? (target.variant ?? undefined) : undefined,
        );
      }
    },
    [readTarget, reload],
  );

  const choose = useCallback(
    (variant: string) => {
      dispatch({ type: "variantChosen", variant });
      requested.current = variant;
      void reload();
    },
    [reload],
  );

  const api = useMemo<ModelsApi>(() => {
    const models = state.status
      ? overlay(
          state.status,
          state.job,
          state.failures,
          state.variant,
          startingModelIds.filter(
            (id) =>
              id !== "whisper" || startingVariant.current === state.variant,
          ),
          state.observation.kind,
        )
      : null;
    return {
      models,
      observe,
      lookup: (target) => {
        if (target.id !== "whisper" || !target.variant) {
          return {
            row: models?.find((row) => row.id === target.id) ?? null,
            observation: state.observation,
          };
        }
        const cached = state.variants[target.variant];
        const observation: ModelObservation = cached?.observation ?? {
          kind: "checking",
          generation: 0,
        };
        const status = cached?.status ?? state.status;
        const row = status
          ? (overlay(
              status,
              state.job,
              state.failures,
              target.variant,
              startingVariant.current === target.variant
                ? startingModelIds
                : NONE,
              observation.kind,
            ).find((row) => row.id === target.id) ?? null)
          : null;
        const failure = state.failures[failureKey(target.id, target.variant)];
        if (
          row &&
          failure &&
          observation.kind !== "current" &&
          row.state.kind !== "queued" &&
          row.state.kind !== "downloading"
        ) {
          return {
            row: { ...row, state: { kind: "failed", failure } },
            observation,
          };
        }
        return { row, observation };
      },
      downloads:
        state.status && models
          ? downloadRows(
              (state.job && state.variants[state.job.whisper_model]?.status) ||
                state.status,
              state.job,
              state.failures,
              models,
            )
          : [],
      tools: toolsOf(state.status),
      canPickFolder: canPickFolderOf(state.status),
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
    };
  }, [
    state,
    startingModelIds,
    choose,
    download,
    cancel,
    remove,
    refresh,
    observe,
  ]);

  return (
    <ModelsContext.Provider value={api}>{children}</ModelsContext.Provider>
  );
}
