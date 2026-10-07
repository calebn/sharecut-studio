import { useEffect, useState } from "react";
import {
  cancelPipelineRun,
  JobCancelledError,
  loadPipelineConfig,
  startExportJob,
} from "../api";
import { projectScopedSignal } from "../state/projectScopedSignal";
import { runAnnouncedJob } from "../state/runAnnouncedJob";
import { useDaw } from "../state/useDaw";
import { errorMessage, isAbortError } from "../utils/apiError";
import { jobResultPaths } from "../utils/pipeline";
import { ExportDialogView, type ExportStage } from "./ExportDialogView";
import {
  type ExportSettings,
  exportResultCopy,
  exportSettingsFromConfig,
  exportStartBlocker,
  masterMeasuredCopy,
  selectedFormats,
} from "./exportSettings";

/** The export's own progress; the live job snapshot comes from the store. */
type Flow =
  | { kind: "configure" }
  | {
      kind: "running";
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | { kind: "done"; paths: string[]; measured: string | null }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; paths: string[] };

/**
 * Host Export deliverables dialog: the same `PipelineService.export_audio` job
 * as MCP `export_audio_tool` and CLI `podcast pipeline export-audio`. The flow
 * outlives the dialog: closing it leaves the export running on the Activity
 * chip, and reopening shows its progress or outcome. A project switch stops
 * following the job and returns to settings.
 */
export function ExportDialog() {
  const { open, setOpen, project, projectPath, activityJob } = useDaw((s) => ({
    open: s.exportDialogOpen,
    setOpen: s.setExportDialogOpen,
    project: s.project,
    projectPath: s.projectPath,
    activityJob: s.activityJob,
  }));
  const [flow, setFlow] = useState<Flow>({ kind: "configure" });
  const [settings, setSettings] = useState<ExportSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [wasOpen, setWasOpen] = useState(false);
  // Opening shows a running export's progress; anything finished starts over
  // from freshly loaded settings (its outcome was already announced).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && flow.kind !== "running") {
      setFlow({ kind: "configure" });
      setSettings(null);
      setSettingsError(null);
    }
  }
  const needsSettings =
    open && flow.kind === "configure" && !settings && !settingsError;

  useEffect(() => {
    if (!needsSettings || !projectPath) {
      return;
    }
    let live = true;
    loadPipelineConfig(projectPath)
      .then((res) => {
        if (!live) return;
        const next = exportSettingsFromConfig(res.config);
        setSettings(next);
        setSelected(next.configured);
      })
      .catch((err: unknown) => {
        if (live) setSettingsError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, [needsSettings, projectPath]);

  async function onExport() {
    const formats = settings ? selectedFormats(settings, selected) : null;
    const scope = projectScopedSignal(projectPath);
    setFlow({
      kind: "running",
      jobId: null,
      cancelling: false,
      cancelError: null,
    });
    try {
      const done = await runAnnouncedJob(
        () => startExportJob(projectPath, formats),
        {
          failLabel: "Export failed",
          resultCopy: exportResultCopy,
          signal: scope.signal,
          onStart: (job) =>
            setFlow((f) =>
              f.kind === "running" ? { ...f, jobId: job.id } : f,
            ),
        },
      );
      setFlow({
        kind: "done",
        paths: jobResultPaths(done),
        measured: masterMeasuredCopy(done.result?.master),
      });
    } catch (err) {
      if (isAbortError(err)) {
        setFlow({ kind: "configure" });
      } else if (err instanceof JobCancelledError) {
        setFlow({ kind: "cancelled", paths: jobResultPaths(err.job) });
      } else {
        setFlow({ kind: "failed", reason: errorMessage(err) });
      }
    } finally {
      scope.dispose();
    }
  }

  async function onCancelExport() {
    if (flow.kind !== "running" || flow.jobId == null) {
      return;
    }
    setFlow({ ...flow, cancelling: true, cancelError: null });
    try {
      await cancelPipelineRun(flow.jobId);
    } catch (err) {
      setFlow((f) =>
        f.kind === "running"
          ? { ...f, cancelling: false, cancelError: errorMessage(err) }
          : f,
      );
    }
  }

  const stage: ExportStage =
    flow.kind === "configure"
      ? {
          kind: "configure",
          settings,
          settingsError,
          selected,
          blocker: exportStartBlocker(settings, selected),
        }
      : flow.kind === "running"
        ? {
            kind: "running",
            job:
              activityJob != null && activityJob.id === flow.jobId
                ? activityJob
                : null,
            canCancel: flow.jobId != null && !flow.cancelling,
            cancelling: flow.cancelling,
            cancelError: flow.cancelError,
          }
        : flow;

  return (
    <ExportDialogView
      open={open && project != null}
      onClose={() => setOpen(false)}
      stage={stage}
      onToggleFormat={(key, on) =>
        setSelected((prev) =>
          on
            ? [...prev.filter((k) => k !== key), key]
            : prev.filter((k) => k !== key),
        )
      }
      onExport={() => void onExport()}
      onCancelExport={() => void onCancelExport()}
      onRestart={() => setFlow({ kind: "configure" })}
    />
  );
}
