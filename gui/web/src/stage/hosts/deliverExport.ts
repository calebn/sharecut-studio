import {
  COMPRESSED_BYTES_PER_SECOND,
  type ExportFile,
  type ExportOptions,
  type ExportState,
  type FormatOption,
  LOSSLESS_BYTES_PER_SECOND,
} from "../../stages/deliver/deliverLogic";
import { lateCancelCopy } from "../../utils/pipeline";
import {
  pipelineProgressPercent,
  pipelineUnitsLabel,
  staleUpdateLabel,
} from "../../utils/pipelineProgress";
import { formatTimeShort } from "../../utils/time";
import type { ExportFlow } from "./exportFlowContext";
import {
  type ExportSettings,
  exportFileName,
  exportResultCopy,
  isLossless,
  loudnessTargetCopy,
} from "./exportSettings";

function exportFormatOptions(settings: ExportSettings): FormatOption[] {
  return settings.choices.map(({ key, label, spec }) => ({
    id: key,
    label,
    bytesPerSecond:
      typeof spec.bitrate_kbps === "number"
        ? spec.bitrate_kbps * 125
        : isLossless(spec.ext)
          ? LOSSLESS_BYTES_PER_SECOND
          : COMPRESSED_BYTES_PER_SECOND,
  }));
}

export function exportOptionsOf(flow: ExportFlow): ExportOptions {
  const { settings, run } = flow;
  return {
    formats: settings ? exportFormatOptions(settings) : [],
    wavAlwaysWritten: settings?.wav ?? false,
    selected: flow.selected,
    loading: flow.loading,
    settingsError: flow.settingsError ?? undefined,
    loudnessNote:
      (settings && loudnessTargetCopy(settings.target)) ?? undefined,
    loudness: false,
    range: false,
    gate: flow.gate,
    onExportAgain:
      run.kind === "failed" || run.kind === "cancelled"
        ? flow.again
        : undefined,
  };
}

function filesOf(paths: readonly string[]): ExportFile[] {
  return paths.map((path) => ({
    name: exportFileName(path),
    format: path.split(".").pop()?.toLowerCase() ?? "",
  }));
}

function exportWhen(finishedAt: number): string {
  const time = new Date(finishedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return `at ${time}`;
}

const STARTING_REASON =
  "The export is still starting. Cancel once it has started.";
const CANCELLING_REASON = "Already cancelling the export.";
const CANCELLING_DETAIL =
  "Cancelling… If the master is still being prepared, the export stops once it is ready.";
const CANCELLED_NOTHING =
  "Export cancelled. Files from an earlier export are unchanged.";

export function exportStateOf(flow: ExportFlow, nowSec: number): ExportState {
  const { run, job, gate } = flow;
  if (gate.prompt) {
    return {
      phase: "needs-model",
      model: gate.prompt.label,
      size: gate.prompt.size,
    };
  }
  switch (run.kind) {
    case "idle":
      return { phase: "never" };
    case "running": {
      const units = pipelineUnitsLabel(
        job && job.current != null && job.total != null
          ? { current: Math.min(job.current, job.total), total: job.total }
          : job,
      );
      const stale = staleUpdateLabel(job?.last_progress_at, nowSec);
      const detail = [
        run.cancelling
          ? CANCELLING_DETAIL
          : (job?.message ?? "Starting export…"),
        units,
        `Elapsed ${formatTimeShort(job?.elapsed_sec ?? 0)}`,
        stale,
      ]
        .filter(Boolean)
        .join(" · ");
      const percent = pipelineProgressPercent(job);
      return {
        phase: "running",
        progress: percent === null ? null : percent / 100,
        detail,
        cancelReason: run.cancelling
          ? CANCELLING_REASON
          : run.jobId === null
            ? STARTING_REASON
            : undefined,
        cancelError: run.cancelError ?? undefined,
      };
    }
    case "done":
      return flow.request
        ? {
            phase: "done",
            files: filesOf(run.paths),
            when: exportWhen(run.finishedAt),
            exported: flow.request,
            summary: exportResultCopy(run.paths),
            measured: run.measured ?? undefined,
          }
        : { phase: "never" };
    case "failed":
      return { phase: "failed", cause: run.reason };
    case "cancelled":
      return {
        phase: "cancelled",
        files: filesOf(run.paths),
        detail: run.paths.length
          ? lateCancelCopy(exportResultCopy(run.paths))
          : CANCELLED_NOTHING,
      };
  }
}
