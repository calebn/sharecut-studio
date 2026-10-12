import { useState } from "react";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  startSplitSpeakersJob,
} from "../api";
import { executePointerCommand } from "../commands/pointer";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { useDawStore } from "../state/dawStore";
import { projectScopedSignal } from "../state/projectScopedSignal";
import { seedStudioJob } from "../state/seedStudioJob";
import { useDaw } from "../state/useDaw";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { errorMessage, isAbortError } from "../utils/apiError";
import {
  parseSplitSpeakersResult,
  type SplitSpeakersResult,
  splitSpeakerNames,
  splitSpeakersDoneCopy,
  splitSpeakersRequestBlocker,
} from "../utils/speakerSplit";
import {
  SplitSpeakersDialogView,
  type SplitSpeakersStage,
} from "./SplitSpeakersDialogView";

type Settings = { count: string; names: string[] };
const DEFAULT_SETTINGS: Settings = { count: "2", names: [] };

/** What the split is doing; the live job snapshot comes from the store. */
type Flow =
  | { kind: "configure" }
  | {
      kind: "running";
      trackId: string;
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | {
      kind: "done";
      trackId: string;
      result: SplitSpeakersResult;
      undoing: boolean;
      undoError: string | null;
    }
  | { kind: "failed"; trackId: string; reason: string }
  | { kind: "cancelled"; trackId: string };

/**
 * Host Split speakers dialog: the same `SpeakerService.split_speakers` as MCP
 * `speaker_split_tool` and CLI `podcast speaker split`, run as a job. The flow
 * outlives the dialog: closing it leaves the split running on the Activity
 * chip, and reopening shows its progress. A project switch stops following
 * the job and returns to the settings.
 */
export function SplitSpeakersDialog() {
  const { trackId, setTrackId, project, projectPath, activityJob, headId } =
    useDaw((s) => ({
      trackId: s.splitSpeakersTrackId,
      setTrackId: s.setSplitSpeakersTrackId,
      project: s.project,
      projectPath: s.projectPath,
      activityJob: s.activityJob,
      headId: s.project?.history?.head_id ?? null,
    }));
  const [flow, setFlow] = useState<Flow>({ kind: "configure" });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const open = trackId != null && project != null;
  const [wasOpen, setWasOpen] = useState(false);
  // Opening shows a running split's progress; anything finished starts over
  // (its outcome was already announced).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && flow.kind !== "running") {
      setFlow({ kind: "configure" });
      setSettings(DEFAULT_SETTINGS);
    }
  }
  const shownTrackId = flow.kind === "configure" ? trackId : flow.trackId;
  const track = project?.tracks.find((t) => t.id === shownTrackId);
  const trackLabel = track?.label || shownTrackId || "this track";

  const count = settings.count.trim() === "" ? null : Number(settings.count);
  const names =
    count != null && Number.isInteger(count)
      ? splitSpeakerNames(settings.names, count)
      : null;

  async function finish(job: PipelineJobSnapshot, forTrackId: string) {
    const result = parseSplitSpeakersResult(job.result);
    if (result == null) {
      throw new Error("The split finished without saying what it made");
    }
    await refreshDocumentProject(projectPath);
    const s = useDawStore.getState();
    const label =
      s.project?.tracks.find((t) => t.id === forTrackId)?.label || forTrackId;
    s.announceStatus(splitSpeakersDoneCopy(result, label), {
      undo: result.history_head_id,
    });
    s.markJobResultsSpoken([job.id]);
    setFlow({
      kind: "done",
      trackId: forTrackId,
      result,
      undoing: false,
      undoError: null,
    });
  }

  async function onSplit() {
    if (trackId == null || count == null) {
      return;
    }
    const scope = projectScopedSignal(projectPath);
    let jobId: string | null = null;
    setFlow({
      kind: "running",
      trackId,
      jobId: null,
      cancelling: false,
      cancelError: null,
    });
    try {
      const job = await startSplitSpeakersJob(projectPath, {
        trackId,
        speakerCount: count,
        names,
      });
      jobId = job.id;
      if (scope.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const s = useDawStore.getState();
      s.expectJobResult(job.id);
      seedStudioJob(job);
      setFlow((f) => (f.kind === "running" ? { ...f, jobId: job.id } : f));
      await finish(
        await followJobToOk(job.id, "Split failed", { signal: scope.signal }),
        trackId,
      );
    } catch (err) {
      if (jobId != null) {
        useDawStore.getState().settleJobResult(jobId);
      }
      if (isAbortError(err)) {
        setFlow({ kind: "configure" });
      } else if (err instanceof JobCancelledError) {
        if (parseSplitSpeakersResult(err.job.result) != null) {
          await finish(err.job, trackId).catch((e: unknown) =>
            setFlow({ kind: "failed", trackId, reason: errorMessage(e) }),
          );
        } else {
          setFlow({ kind: "cancelled", trackId });
        }
      } else {
        setFlow({ kind: "failed", trackId, reason: errorMessage(err) });
      }
    } finally {
      scope.dispose();
    }
  }

  async function onCancelSplit() {
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

  async function onUndo() {
    if (flow.kind !== "done" || flow.result.history_head_id == null) {
      return;
    }
    const done = flow;
    setFlow({ ...done, undoing: true, undoError: null });
    try {
      const result = await executePointerCommand("history.undo", {
        expectedHeadId: done.result.history_head_id,
      });
      if (result.status === "ok") {
        useDawStore.getState().announceStatus("Undone: speaker split");
        setFlow({ kind: "configure" });
      } else {
        setFlow({
          ...done,
          undoing: false,
          undoError:
            result.status === "disabled" ? result.reason : "Nothing was undone",
        });
      }
    } catch (err) {
      setFlow({ ...done, undoing: false, undoError: errorMessage(err) });
    }
  }

  const stage: SplitSpeakersStage =
    flow.kind === "configure"
      ? {
          kind: "configure",
          count: settings.count,
          names: settings.names,
          blocker: splitSpeakersRequestBlocker(count, names),
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
        : flow.kind === "done"
          ? {
              kind: "done",
              result: flow.result,
              durationSec: track?.duration_sec ?? null,
              canUndo:
                flow.result.history_head_id != null &&
                flow.result.history_head_id === headId,
              undoing: flow.undoing,
              undoError: flow.undoError,
            }
          : flow;

  return (
    <SplitSpeakersDialogView
      open={open}
      onClose={() => setTrackId(null)}
      trackLabel={trackLabel}
      stage={stage}
      onCountChange={(next) => setSettings((s) => ({ ...s, count: next }))}
      onNameChange={(index, name) =>
        setSettings((s) => {
          const next = [...s.names];
          next[index] = name;
          return { ...s, names: next };
        })
      }
      onSplit={() => void onSplit()}
      onCancelSplit={() => void onCancelSplit()}
      onUndo={() => void onUndo()}
      onRestart={() => setFlow({ kind: "configure" })}
    />
  );
}
