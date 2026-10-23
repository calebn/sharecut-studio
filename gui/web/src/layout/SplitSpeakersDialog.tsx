import { useEffect, useState } from "react";
import {
  cancelPipelineRun,
  followJobToOk,
  getSpeakerDoctor,
  JobCancelledError,
  startSplitSpeakersJob,
} from "../api";
import { executePointerCommand } from "../commands/pointer";
import { runRangeAction } from "../commands/rangeActions";
import { seekTransport } from "../commands/seek";
import { refreshDocumentProject } from "../document/applyDocumentUpdate";
import { ModelGateHint, useModel, useModelGate } from "../models";
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
  splitSpeakersEnrollment,
  splitSpeakersRequestBlocker,
  type VoiceSample,
  voiceSampleFromSelection,
} from "../utils/speakerSplit";
import {
  SplitSpeakersDialogView,
  type SplitSpeakersStage,
} from "./SplitSpeakersDialogView";

type Settings = {
  count: string;
  names: string[];
  /** One optional voice sample per speaker, by position. */
  samples: Array<VoiceSample | null>;
};
type SpeakerReadiness =
  | "checking"
  | "available"
  | "unavailable"
  | "check_failed";
/** The bootstrap component that gives the app a speaker-recognition model (#1998). */
const SPEAKER_MODEL_COMPONENT = "speaker-ecapa";
const DEFAULT_SETTINGS: Settings = { count: "2", names: [], samples: [] };

/** What the split is doing; the live job snapshot comes from the store. */
type Flow =
  | { kind: "configure" }
  | {
      kind: "running";
      trackId: string;
      /** The track's label before the split renames it to the first speaker. */
      label: string;
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | {
      kind: "done";
      trackId: string;
      projectPath: string;
      label: string;
      result: SplitSpeakersResult;
      undoing: boolean;
      undoError: string | null;
    }
  | { kind: "failed"; trackId: string; label: string; reason: string }
  | { kind: "cancelled"; trackId: string; label: string };

export function SplitSpeakersDialog() {
  const {
    trackId,
    setTrackId,
    setReview,
    project,
    projectPath,
    activityJob,
    headId,
    selection,
  } = useDaw((s) => ({
    trackId: s.splitSpeakersTrackId,
    setTrackId: s.setSplitSpeakersTrackId,
    setReview: s.setSplitSpeakersReview,
    project: s.project,
    projectPath: s.projectPath,
    activityJob: s.activityJob,
    headId: s.project?.history?.head_id ?? null,
    selection: s.selection,
  }));
  const [flow, setFlow] = useState<Flow>({ kind: "configure" });
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [speakerReadiness, setSpeakerReadiness] =
    useState<SpeakerReadiness>("checking");
  const [readinessCheck, setReadinessCheck] = useState(0);
  const speakerModel = useModel(SPEAKER_MODEL_COMPONENT);
  const gate = useModelGate();
  const open = trackId != null && project != null;
  const resetGate = gate.reset;
  useEffect(() => {
    resetGate();
  }, [open, trackId, projectPath, resetGate]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setSpeakerReadiness("checking");
    void getSpeakerDoctor().then(
      (report) => {
        if (!current) return;
        setSpeakerReadiness(
          report.available_backends.some((backend) => backend !== "mock")
            ? "available"
            : "unavailable",
        );
      },
      () => {
        if (current) setSpeakerReadiness("check_failed");
      },
    );
    return () => {
      current = false;
    };
  }, [open, readinessCheck]);
  const [wasOpen, setWasOpen] = useState(false);
  const [sampleTrackId, setSampleTrackId] = useState<string | null>(null);
  if (trackId !== sampleTrackId) {
    // Samples are seconds of one recording, so another track starts with none.
    setSampleTrackId(trackId);
    if (settings.samples.length) setSettings((s) => ({ ...s, samples: [] }));
  }
  const doneMatchesProject =
    flow.kind === "done" &&
    flow.projectPath === projectPath &&
    flow.result.history_head_id === headId &&
    flow.result.lanes.every((lane) =>
      project?.tracks.some(
        (candidate) =>
          candidate.id === lane.track_id &&
          candidate.speaker_split_id === flow.result.split_id,
      ),
    );
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && flow.kind !== "running" && !doneMatchesProject) {
      setFlow({ kind: "configure" });
      setSettings(DEFAULT_SETTINGS);
    }
  }
  const showingConfigure =
    flow.kind === "configure" || (flow.kind === "done" && !doneMatchesProject);
  const shownTrackId = showingConfigure ? trackId : flow.trackId;
  const track = project?.tracks.find((t) => t.id === shownTrackId);
  const trackLabel = showingConfigure
    ? track?.label || shownTrackId || "this track"
    : flow.label;

  const count = settings.count.trim() === "" ? null : Number(settings.count);
  const hasSamples =
    count != null &&
    settings.samples.slice(0, count).some((sample) => sample != null);
  const names =
    count != null && Number.isInteger(count)
      ? splitSpeakerNames(settings.names, count, hasSamples)
      : null;
  const enrollment = splitSpeakersEnrollment(names, settings.samples);
  const currentSample = voiceSampleFromSelection(project, selection, trackId);

  async function finish(
    job: PipelineJobSnapshot,
    forTrackId: string,
    label: string,
  ) {
    const result = parseSplitSpeakersResult(job.result);
    if (result == null) {
      throw new Error("The split finished without saying what it made");
    }
    await refreshDocumentProject(projectPath);
    const s = useDawStore.getState();
    if (
      s.projectPath !== projectPath ||
      s.project?.history?.head_id !== result.history_head_id ||
      !result.lanes.every((lane) =>
        s.project?.tracks.some(
          (candidate) =>
            candidate.id === lane.track_id &&
            candidate.speaker_split_id === result.split_id,
        ),
      )
    ) {
      setReview(null);
      setFlow({ kind: "configure" });
      return;
    }
    setReview(
      result.history_head_id == null
        ? null
        : {
            trackId: forTrackId,
            splitId: result.split_id,
            historyHeadId: result.history_head_id,
          },
    );
    s.announceStatus(
      splitSpeakersDoneCopy(result, label),
      s.splitSpeakersTrackId == null
        ? { undo: result.history_head_id }
        : { toast: false },
    );
    s.markJobResultsSpoken([job.id]);
    setFlow({
      kind: "done",
      trackId: forTrackId,
      projectPath,
      label,
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
    const label = trackLabel;
    try {
      const started = await gate.run(async () => {
        if (scope.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        setFlow({
          kind: "running",
          trackId,
          label,
          jobId: null,
          cancelling: false,
          cancelError: null,
        });
        return startSplitSpeakersJob(projectPath, {
          trackId,
          speakerCount: count,
          names,
          enrollment,
        });
      }, [{ id: SPEAKER_MODEL_COMPONENT }]);
      if (started.kind === "declined") {
        setFlow({ kind: "configure" });
        return;
      }
      const job = started.value;
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
        label,
      );
    } catch (err) {
      if (jobId != null) {
        useDawStore.getState().settleJobResult(jobId);
      }
      if (isAbortError(err)) {
        setFlow({ kind: "configure" });
      } else if (err instanceof JobCancelledError) {
        if (parseSplitSpeakersResult(err.job.result) != null) {
          await finish(err.job, trackId, label).catch((e: unknown) =>
            setFlow({
              kind: "failed",
              trackId,
              label,
              reason: errorMessage(e),
            }),
          );
        } else {
          setFlow({ kind: "cancelled", trackId, label });
        }
      } else {
        setFlow({ kind: "failed", trackId, label, reason: errorMessage(err) });
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
        useDawStore.getState().setSplitSpeakersReview(null);
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

  const stage: SplitSpeakersStage = gate.prompt
    ? { kind: "needsModel", gate }
    : flow.kind === "configure" || (flow.kind === "done" && !doneMatchesProject)
      ? {
          kind: "configure",
          count: settings.count,
          names: settings.names,
          samples: settings.samples.map((sample) =>
            sample
              ? {
                  startSec: sample.target.intervals[0]!.start,
                  endSec: sample.target.intervals[0]!.end,
                }
              : null,
          ),
          sampleReason: currentSample.reason,
          blocker: splitSpeakersRequestBlocker(count, names),
          countError: splitSpeakersRequestBlocker(count, null),
          speakerReadiness,
        }
      : flow.kind === "running"
        ? {
            kind: "running",
            job:
              activityJob != null && activityJob.id === flow.jobId
                ? activityJob
                : null,
            cancelReason: flow.cancelling
              ? "Already cancelling the split."
              : flow.jobId == null
                ? "The split is still starting. Cancel once it has started."
                : null,
            cancelling: flow.cancelling,
            cancelError: flow.cancelError,
          }
        : flow.kind === "done"
          ? {
              kind: "done",
              result: flow.result,
              reviewSpans: flow.result.review_spans.flatMap((span) => {
                const labels = [
                  ...(span.unsure ? ["Unsure stretch"] : []),
                  ...(span.overlapping ? ["Overlapping speech"] : []),
                ];
                const trackNames = span.speakers.map(
                  (id) =>
                    flow.result.lanes.find((lane) => lane.track_id === id)
                      ?.name ?? id,
                );
                const timelineSpans = span.timeline_spans.length
                  ? span.timeline_spans
                  : [{ start_s: span.start_s, end_s: span.end_s }];
                return timelineSpans.map((timelineSpan) => ({
                  ...timelineSpan,
                  clock: span.timeline_spans.length
                    ? ("Timeline" as const)
                    : ("Recording" as const),
                  labels,
                  trackNames,
                  timelineSec: span.timeline_spans.length
                    ? timelineSpan.start_s
                    : null,
                }));
              }),
              durationSec: track?.duration_sec ?? null,
              canUndo:
                flow.result.history_head_id != null &&
                flow.result.history_head_id === headId,
              undoing: flow.undoing,
              undoError: flow.undoError,
            }
          : flow;

  if (stage.kind === "configure") {
    stage.blocker ??=
      stage.speakerReadiness === "checking"
        ? "Checking speaker recognition"
        : stage.speakerReadiness === "unavailable"
          ? "Speaker recognition isn't available on this computer."
          : stage.speakerReadiness === "check_failed"
            ? "Couldn't check speaker recognition. Close and reopen this dialog to try again."
            : null;
  }

  return (
    <SplitSpeakersDialogView
      open={open}
      onClose={() => {
        if (gate.prompt) {
          gate.decline();
          return;
        }
        if (
          flow.kind === "done" &&
          stage.kind === "done" &&
          stage.canUndo &&
          flow.result.history_head_id != null
        ) {
          useDawStore
            .getState()
            .announceStatus(splitSpeakersDoneCopy(flow.result, flow.label), {
              undo: flow.result.history_head_id,
            });
        }
        setTrackId(null);
      }}
      trackLabel={trackLabel}
      stage={stage}
      modelHint={<ModelGateHint gate={gate} actionLabel="Split speakers" />}
      speakerModel={{ row: speakerModel.row, busy: speakerModel.busy }}
      onDownloadSpeakerModel={() =>
        void speakerModel.download().then((outcome) => {
          if (outcome.kind === "ok") {
            setReadinessCheck((n) => n + 1);
          }
        })
      }
      onCountChange={(next) => setSettings((s) => ({ ...s, count: next }))}
      onNameChange={(index, name) =>
        setSettings((s) => {
          const next = [...s.names];
          next[index] = name;
          return { ...s, names: next };
        })
      }
      onMarkSample={(index) => {
        if (currentSample.sample == null) return;
        const sample = currentSample.sample;
        setSettings((s) => {
          const samples = [...s.samples];
          samples[index] = sample;
          return { ...s, samples };
        });
      }}
      onClearSample={(index) =>
        setSettings((s) => {
          const samples = [...s.samples];
          samples[index] = null;
          return { ...s, samples };
        })
      }
      onListenSample={(index) => {
        const sample = settings.samples[index];
        if (!sample) return;
        useDawStore
          .getState()
          .setSelection({ kind: "range", target: sample.target });
        void runRangeAction("play").then((result) => {
          if (result.status === "disabled")
            useDawStore.getState().announceStatus(result.reason);
        });
      }}
      onSplit={() => void onSplit()}
      onCancelSplit={() => void onCancelSplit()}
      onUndo={() => void onUndo()}
      onGoTo={(sec) => void seekTransport(sec)}
      onRestart={() => setFlow({ kind: "configure" })}
    />
  );
}
