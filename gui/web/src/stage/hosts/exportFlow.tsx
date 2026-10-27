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
import {
  type ExportSettings,
  exportResultCopy,
  exportSettingsFromConfig,
  masterMeasured,
  masterMeasuredCopy,
  selectedFormats,
} from "../dialogs/exportSettings";
import { type ExportFlow, type ExportRun, Flow } from "./exportFlowContext";

function sameSettings(a: ExportSettings | null, b: ExportSettings): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function ExportFlowProvider({ children }: { children: ReactNode }) {
  const projectPath = useDawStore((s) => s.projectPath);
  const activityJob = useDawStore((s) => s.activityJob);
  const [run, setRun] = useState<ExportRun>({ kind: "idle" });
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [reloads, setReloads] = useState(0);
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const gate = useModelGate();
  const resetGate = gate.reset;
  const runRef = useRef(run);
  runRef.current = run;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsErrorRef = useRef(settingsError);
  settingsErrorRef.current = settingsError;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    setRun({ kind: "idle" });
    setSettings(null);
    setSettingsError(null);
    setSelected([]);
    setRequest(null);
    resetGate();
  }, [projectPath, resetGate]);

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
      });
    return () => {
      live = false;
    };
  }, [projectPath, reloads]);

  const start = useCallback(
    async (keys: readonly string[], asked: ExportRequest) => {
      const path = useDawStore.getState().projectPath;
      if (!path || runRef.current.kind === "running") return;
      selectedRef.current = keys;
      setSelected(keys);
      setRequest(asked);
      const current = settingsRef.current;
      const formats = current ? selectedFormats(current, keys) : null;
      const scope = projectScopedSignal(path);
      setRun({
        kind: "running",
        jobId: null,
        cancelling: false,
        cancelError: null,
      });
      try {
        const ran = await gate.run(async () => {
          try {
            return await runAnnouncedJob(() => startExportJob(path, formats), {
              failLabel: "Export failed",
              resultCopy: exportResultCopy,
              signal: scope.signal,
              onStart: (job) =>
                setRun((r) =>
                  r.kind === "running" ? { ...r, jobId: job.id } : r,
                ),
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
        if (ran.kind === "declined") {
          setRun(
            scope.signal.aborted
              ? { kind: "idle" }
              : { kind: "failed", reason: `${ran.label} is not downloaded.` },
          );
          return;
        }
        const done = ran.value;
        const measured = masterMeasured(done.result?.master);
        setRun({
          kind: "done",
          paths: jobResultPaths(done),
          measured: masterMeasuredCopy(done.result?.master),
          lufs: measured?.lufs ?? null,
          truePeak: measured?.truePeak ?? null,
          finishedAt: Date.now(),
        });
      } catch (err) {
        if (isAbortError(err)) {
          setRun({ kind: "idle" });
        } else if (err instanceof JobCancelledError) {
          setRun({ kind: "cancelled", paths: jobResultPaths(err.job) });
        } else {
          setRun({ kind: "failed", reason: errorMessage(err) });
        }
      } finally {
        scope.dispose();
      }
    },
    [gate],
  );

  const cancel = useCallback(async () => {
    const r = runRef.current;
    if (r.kind !== "running" || r.jobId == null) return;
    setRun({ ...r, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(r.jobId);
    } catch (err) {
      setRun((now) =>
        now.kind === "running"
          ? { ...now, cancelling: false, cancelError: errorMessage(err) }
          : now,
      );
    }
  }, []);

  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const again = useCallback(() => {
    setRun({ kind: "idle" });
    if (settingsErrorRef.current !== null) setReloads((n) => n + 1);
  }, []);

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
      selected,
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
