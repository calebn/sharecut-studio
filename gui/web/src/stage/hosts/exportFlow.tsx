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
import { useModelResume } from "../../models";
import type { ExportRequest } from "../../stages/deliver/deliverLogic";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { runAnnouncedJob } from "../../state/runAnnouncedJob";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
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

type ExportModelNeed = ModelNeeded & {
  projectPath: string;
  projectEpoch: number;
  keys: readonly string[];
  asked: ExportRequest;
};

function sameSettings(a: ExportSettings | null, b: ExportSettings): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

function withEditHead(head: string) {
  return (request: ExportRequest | null) =>
    request && request.edits !== undefined
      ? { ...request, edits: head }
      : request;
}

export function ExportFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const activityJob = useDawStore((s) => s.activityJob);
  const projectEpoch = useDawStore((s) => s.projectEpoch);
  const [run, setRun] = useState<ExportRun>({ kind: "idle" });
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [reloads, setReloads] = useState(0);
  const [loadedGeneration, setLoadedGeneration] = useState(0);
  const generation = useRef(0);
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const restart = useRef<(need: ExportModelNeed) => void>(() => undefined);
  const retried = useRef<string | null>(null);
  const {
    stop: needs,
    stopFor,
    clear,
  } = useModelResume<ExportModelNeed>((need) => restart.current(need));
  const runRef = useRef(run);
  runRef.current = run;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsErrorRef = useRef(settingsError);
  settingsErrorRef.current = settingsError;

  useEffect(() => {
    setRun({ kind: "idle" });
    setSettings(null);
    setSettingsError(null);
    setSelected([]);
    setRequest(null);
    setLoadedGeneration(0);
    clear();
  }, [projectPath, projectEpoch, clear]);

  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    loadPipelineConfig(projectPath)
      .then((res) => {
        if (!live) return;
        const next = exportSettingsFromConfig(res.config);
        setSettingsError(null);
        if (!sameSettings(settingsRef.current, next)) {
          setSettings(next);
          setSelected(next.configured);
        }
      })
      .catch((err: unknown) => {
        if (live) setSettingsError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoadedGeneration(reloads);
      });
    return () => {
      live = false;
    };
  }, [projectPath, projectEpoch, reloads]);

  const start = useCallback(
    async (keys: readonly string[], asked: ExportRequest) => {
      const { projectPath: path, projectEpoch: epoch } = useDawStore.getState();
      if (!path || runRef.current.kind === "running") return;
      const running: ExportRun = {
        kind: "running",
        jobId: null,
        cancelling: false,
        cancelError: null,
      };
      const current = settingsRef.current;
      const formats = current ? selectedFormats(current, keys) : null;
      if (current && formats?.length === 0 && !current.wav) return;
      setSelected(keys);
      setRequest(asked);
      const scope = projectScopedSignal(path);
      runRef.current = running;
      setRun(running);
      try {
        const done = await runAnnouncedJob(
          () => startExportJob(path, formats),
          {
            failLabel: "Export failed",
            resultCopy: exportResultCopy,
            signal: scope.signal,
            onStart: (job) => {
              const history = useDawStore.getState().project?.history;
              const head = history ? editHeadOf(history) : undefined;
              if (head !== undefined) setRequest(withEditHead(head));
              setRun((r) =>
                r.kind === "running" ? { ...r, jobId: job.id } : r,
              );
            },
          },
        );
        const exportedHead = done.result?.edit_head_id;
        if (typeof exportedHead === "string")
          setRequest(withEditHead(exportedHead));
        setRun({
          kind: "done",
          paths: jobResultPaths(done),
          measured: masterMeasuredCopy(done.result?.master),
          finishedAt: Date.now(),
        });
      } catch (err) {
        if (isAbortError(err)) {
          setRun({ kind: "idle" });
        } else if (
          isModelNeeded(err) &&
          !scope.signal.aborted &&
          useDawStore.getState().stage === "deliver" &&
          retried.current !== err.model.id
        ) {
          runRef.current = { kind: "idle" };
          setRun({ kind: "idle" });
          stopFor({
            ...err.model,
            projectPath: path,
            projectEpoch: epoch,
            keys,
            asked,
          });
        } else if (isModelNeeded(err)) {
          setRun({ kind: "failed", reason: notDownloadedLine(err.model) });
        } else if (err instanceof JobCancelledError) {
          const exportedHead = err.job.result?.edit_head_id;
          if (typeof exportedHead === "string")
            setRequest(withEditHead(exportedHead));
          setRun({
            kind: "cancelled",
            paths: jobResultPaths(err.job),
            finishedAt: Date.now(),
          });
        } else {
          setRun({ kind: "failed", reason: errorMessage(err) });
        }
      } finally {
        scope.dispose();
      }
    },
    [stopFor],
  );

  restart.current = (need) => {
    const store = useDawStore.getState();
    if (
      store.projectPath !== need.projectPath ||
      store.projectEpoch !== need.projectEpoch
    )
      return;
    retried.current = need.id;
    void start(need.keys, need.asked);
  };

  const cancel = useCallback(async () => {
    const r = runRef.current;
    if (r.kind !== "running" || r.jobId == null) return;
    setRun({ ...r, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setRun((now) =>
        now.kind === "running" && now.jobId === r.jobId
          ? { ...now, cancelling: false, cancelError: errorMessage(err) }
          : now,
      );
    }
  }, []);

  const reload = useCallback(() => {
    generation.current += 1;
    setReloads(generation.current);
    return generation.current;
  }, []);
  const again = useCallback(() => {
    setRun({ kind: "idle" });
    if (settingsErrorRef.current !== null) reload();
  }, [reload]);

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
      needs,
      request,
      start: (keys, asked) => {
        clear();
        retried.current = null;
        void start(keys, asked);
      },
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
      needs,
      request,
      start,
      clear,
      cancel,
      again,
      reload,
    ],
  );
  return <Flow.Provider value={value}>{children}</Flow.Provider>;
}
