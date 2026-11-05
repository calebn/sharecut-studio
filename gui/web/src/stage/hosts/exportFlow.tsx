import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  cancelPipelineRun,
  JobCancelledError,
  loadPipelineConfig,
  startExportJob,
} from "../../api";
import { useModelGate } from "../../models";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { jobResultPaths } from "../../utils/pipeline";
import { editHeadOf } from "./deliverModel";
import { type ExportFlow, type ExportRun, Flow } from "./exportFlowContext";
import {
  type ExportSettings,
  exportResultCopy,
  exportSettingsFromConfig,
  masterMeasuredCopy,
  selectedFormats,
} from "./exportSettings";

function sameSettings(a: ExportSettings | null, b: ExportSettings): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

function withEditHead(head: string) {
  return (request: ExportRequest | null) =>
    request && request.edits !== undefined
      ? { ...request, edits: head }
      : request;
}

interface ExportOwner {
  projectPath: string | null;
  projectEpoch: number;
}

type ExportAttempt = { owner: ExportOwner };

type ExportState = {
  owner: ExportOwner;
  run: ExportRun;
  attempt: ExportAttempt | null;
  settings: ExportSettings | null;
  settingsError: string | null;
  selected: readonly string[];
  reloads: number;
  loadedGeneration: number;
  request: ExportRequest | null;
};

export function ExportFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const activityJob = useDawStore((s) => s.activityJob);
  const [state, setState] = useState<ExportState>(() => ({
    owner: { projectPath, projectEpoch },
    run: { kind: "idle" },
    attempt: null,
    settings: null,
    settingsError: null,
    selected: [],
    reloads: 0,
    loadedGeneration: 0,
    request: null,
  }));
  const {
    owner,
    run,
    settings,
    settingsError,
    selected,
    reloads,
    loadedGeneration,
    request,
  } = state;
  if (
    owner.projectPath !== projectPath ||
    owner.projectEpoch !== projectEpoch
  ) {
    setState({
      owner: { projectPath, projectEpoch },
      run: { kind: "idle" },
      attempt: null,
      settings: null,
      settingsError: null,
      selected: [],
      reloads,
      loadedGeneration: 0,
      request: null,
    });
  }
  const generation = useRef(0);
  const inFlight = useRef<ExportAttempt | null>(null);
  const gate = useModelGate();
  const resetGate = gate.reset;
  useEffect(() => resetGate(), [owner, resetGate]);

  useEffect(() => {
    if (!owner.projectPath) return;
    let live = true;
    loadPipelineConfig(owner.projectPath)
      .then((res) => {
        if (!live) return;
        const next = exportSettingsFromConfig(res.config);
        setState((current) => {
          if (current.owner !== owner || current.reloads !== reloads)
            return current;
          return sameSettings(current.settings, next)
            ? { ...current, settingsError: null }
            : {
                ...current,
                settingsError: null,
                settings: next,
                selected: next.configured,
              };
        });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState((current) =>
          current.owner === owner && current.reloads === reloads
            ? { ...current, settingsError: errorMessage(err) }
            : current,
        );
      })
      .finally(() => {
        if (!live) return;
        setState((current) =>
          current.owner === owner && current.reloads === reloads
            ? { ...current, loadedGeneration: reloads }
            : current,
        );
      });
    return () => {
      live = false;
    };
  }, [owner, reloads]);

  const setSelected = useCallback(
    (keys: readonly string[]) => {
      setState((current) =>
        current.owner === owner ? { ...current, selected: keys } : current,
      );
    },
    [owner],
  );

  const start = useCallback(
    async (keys: readonly string[], asked: ExportRequest) => {
      const store = useDawStore.getState();
      const path = store.projectPath;
      if (
        !path ||
        path !== owner.projectPath ||
        store.projectEpoch !== owner.projectEpoch ||
        inFlight.current?.owner === owner
      )
        return;
      const running: ExportRun = {
        kind: "running",
        jobId: null,
        cancelling: false,
        cancelError: null,
      };
      const current = settings;
      const formats = current ? selectedFormats(current, keys) : null;
      if (current && formats?.length === 0 && !current.wav) return;
      const scope = projectScopedSignal({
        lifetime: "document",
        path,
        epoch: owner.projectEpoch,
      });
      const attempt: ExportAttempt = { owner };
      inFlight.current = attempt;
      setState((now) =>
        now.owner === owner
          ? { ...now, attempt, selected: keys, request: asked, run: running }
          : now,
      );
      try {
        const ran = await gate.run(async () => {
          try {
            return await runAnnouncedJob(() => startExportJob(path, formats), {
              failLabel: "Export failed",
              resultCopy: exportResultCopy,
              signal: scope.signal,
              onStart: (job) => {
                const history = useDawStore.getState().project?.history;
                const head = history ? editHeadOf(history) : undefined;
                setState((now) =>
                  now.owner === owner &&
                  now.attempt === attempt &&
                  now.run.kind === "running"
                    ? {
                        ...now,
                        request:
                          head !== undefined
                            ? withEditHead(head)(now.request)
                            : now.request,
                        run: { ...now.run, jobId: job.id },
                      }
                    : now,
                );
              },
            });
          } catch (err) {
            if (
              isModelNeeded(err) &&
              useDawStore.getState().stage !== "deliver"
            ) {
              throw new Error(notDownloadedLine(err.model));
            }
            throw err;
          }
        });
        if (scope.signal.aborted) return;
        if (ran.kind === "declined") {
          setState((now) =>
            now.owner === owner && now.attempt === attempt
              ? {
                  ...now,
                  run: {
                    kind: "failed",
                    reason: `${ran.label} is not downloaded.`,
                  },
                }
              : now,
          );
          return;
        }
        const done = ran.value;
        const exportedHead = done.result?.edit_head_id;
        const finishedAt = Date.now();
        setState((now) =>
          now.owner === owner && now.attempt === attempt
            ? {
                ...now,
                request:
                  typeof exportedHead === "string"
                    ? withEditHead(exportedHead)(now.request)
                    : now.request,
                run: {
                  kind: "done",
                  paths: jobResultPaths(done),
                  measured: masterMeasuredCopy(done.result?.master),
                  finishedAt,
                },
              }
            : now,
        );
      } catch (err) {
        if (scope.signal.aborted) return;
        if (isAbortError(err)) {
          setState((now) =>
            now.owner === owner && now.attempt === attempt
              ? { ...now, run: { kind: "idle" } }
              : now,
          );
        } else if (err instanceof JobCancelledError) {
          const exportedHead = err.job.result?.edit_head_id;
          const finishedAt = Date.now();
          setState((now) =>
            now.owner === owner && now.attempt === attempt
              ? {
                  ...now,
                  request:
                    typeof exportedHead === "string"
                      ? withEditHead(exportedHead)(now.request)
                      : now.request,
                  run: {
                    kind: "cancelled",
                    paths: jobResultPaths(err.job),
                    finishedAt,
                  },
                }
              : now,
          );
        } else {
          setState((now) =>
            now.owner === owner && now.attempt === attempt
              ? { ...now, run: { kind: "failed", reason: errorMessage(err) } }
              : now,
          );
        }
      } finally {
        scope.dispose();
        if (inFlight.current === attempt) inFlight.current = null;
      }
    },
    [gate, owner, settings],
  );

  const cancel = useCallback(async () => {
    const r = run;
    const attempt = state.attempt;
    const currentProject = useDawStore.getState();
    if (
      r.kind !== "running" ||
      r.jobId == null ||
      attempt === null ||
      inFlight.current !== attempt ||
      currentProject.projectPath !== owner.projectPath ||
      currentProject.projectEpoch !== owner.projectEpoch
    )
      return;
    setState((now) =>
      now.owner === owner && now.attempt === attempt
        ? { ...now, run: { ...r, cancelling: true, cancelError: null } }
        : now,
    );
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setState((now) =>
        now.owner === owner &&
        now.attempt === attempt &&
        now.run.kind === "running" &&
        now.run.jobId === r.jobId
          ? {
              ...now,
              run: {
                ...now.run,
                cancelling: false,
                cancelError: errorMessage(err),
              },
            }
          : now,
      );
    }
  }, [owner, run, state.attempt]);

  const reload = useCallback(() => {
    generation.current += 1;
    const next = generation.current;
    setState((now) => (now.owner === owner ? { ...now, reloads: next } : now));
    return next;
  }, [owner]);
  const again = useCallback(() => {
    setState((now) =>
      now.owner === owner ? { ...now, run: { kind: "idle" } } : now,
    );
    if (settingsError !== null) reload();
  }, [owner, settingsError, reload]);

  const job =
    run.kind === "running" &&
    activityJob != null &&
    activityJob.id === run.jobId
      ? activityJob
      : null;
  const value = useMemo<ExportFlow>(
    () => ({
      run,
      job,
      settings,
      settingsError,
      loading:
        settings === null && settingsError === null && projectPath !== null,
      loadedGeneration,
      selected,
      setSelected,
      gate,
      request,
      start: (keys, asked) => void start(keys, asked),
      cancel: () => void cancel(),
      again,
      reload,
    }),
    [
      run,
      job,
      settings,
      settingsError,
      projectPath,
      loadedGeneration,
      selected,
      setSelected,
      gate,
      request,
      start,
      cancel,
      again,
      reload,
    ],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
