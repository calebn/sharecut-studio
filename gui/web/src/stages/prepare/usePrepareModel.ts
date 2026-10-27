import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { usePipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import { canIngestMedia, canManageProjects } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { errorMessage } from "../../utils/apiError";
import { getByPath } from "../../utils/configPath";
import { isPipelineKindJob, isPipelineRunning } from "../../utils/pipeline";
import type { AdvancedStepsProps } from "./AdvancedSteps";
import {
  advancedGroups,
  paramPath,
  withParam,
  withStepSwitch,
} from "./advancedModel";
import type { PrepareViewProps } from "./PrepareView";
import {
  handoffProps,
  hasMedia,
  prepareHandoff,
  preparePhase,
  prepareSessions,
  readyRows,
  readySummary,
  sourceTracks,
  trackLabel,
  transcriptIndex,
} from "./prepareMappers";
import type { ReadyAction, ReadyRowId } from "./ReadyList";
import { useCleanup } from "./useCleanup";
import { usePrepareDrop } from "./usePrepareDrop";
import { usePrepareRun } from "./usePrepareRun";
import { usePrepareSources } from "./usePrepareSources";
import { useVocabulary } from "./useVocabulary";

export type PrepareModel = {
  view: PrepareViewProps;
  advanced: {
    open: boolean;
    onClose: () => void;
    props: AdvancedStepsProps;
  };
  /** The person may add audio here. */
  canIngest: boolean;
};

/**
 * The Prepare stage's model: the project, the pipeline job and the model
 * downloads mapped onto the props of the presentational `PrepareView`, with
 * the actions behind its buttons. The mappers are in `prepareMappers.ts`;
 * this only reads the store and wires the callbacks.
 */
export function usePrepareModel(): PrepareModel {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    pipelineJob,
    activityJob,
    ingestBusy,
    isPlaying,
    openStage,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      pipelineJob: s.pipelineJob,
      activityJob: s.activityJob,
      ingestBusy: s.ingestBusy,
      isPlaying: s.isPlaying,
      openStage: s.openStage,
    })),
  );
  const canIngest = canIngestMedia(projectPath, guestMode, shareCapabilities);
  const mayManage = canManageProjects(projectPath);
  const allTracks = project?.tracks;
  const job = isPipelineKindJob(pipelineJob) ? pipelineJob : null;
  const running = isPipelineRunning(job ?? undefined);

  const { transcribed, voices } = useMemo(
    () => transcriptIndex(project?.transcript?.utterances),
    [project?.transcript],
  );
  const workingSet = usePipelineWorkingSet(projectPath, true);
  const sourcesNow = sourceTracks(allTracks ?? []);
  const untranscribed = sourcesNow.filter((t) => !transcribed.has(t.id));
  const mediaKey = sourcesNow
    .filter(hasMedia)
    .map((t) => `${t.id}:${t.media_path}`)
    .join("|");

  const run = usePrepareRun({
    projectPath,
    workingSet,
    untranscribed: untranscribed.length,
    mediaKey,
    ingestBusy,
    canRun: canIngest,
    nameOf: (id) => {
      const track = allTracks?.find((t) => t.id === id);
      return track ? track.speaker?.trim() || trackLabel(track) : id;
    },
  });
  const sourceState = usePrepareSources({
    projectPath,
    tracks: allTracks ?? [],
    activityJob,
    isPlaying,
  });
  const { cleanup, onCleanup } = useCleanup(workingSet);
  const vocabulary = useVocabulary(
    projectPath,
    job && !running ? `${job.id}:${job.status}` : "",
  );
  const drop = usePrepareDrop(canIngest);

  const tracks = (allTracks ?? []).map((track) =>
    sourceState.names[track.id] === undefined
      ? track
      : { ...track, speaker: sourceState.names[track.id] },
  );
  const sessions = prepareSessions({
    tracks,
    transcribed,
    voicesIn: voices,
    mayManage,
    ingestBusy,
    playingId: sourceState.playingId,
    chosenVoices: sourceState.chosenVoices,
    splitting: sourceState.splitting,
    splitFailed: sourceState.splitFailed,
    job,
  });
  const sourceCount = sessions.reduce(
    (sum, one) => sum + one.sources.length,
    0,
  );
  const rows = readyRows({
    sourceCount,
    ingestBusy,
    transcribed: sourceCount > 0 && untranscribed.length === 0,
    starting: run.starting,
    job,
    pendingSuggestions: project?.edit_impact.pending_review_count ?? 0,
    model: run.model,
    approximateTiming: run.approximateTiming,
    keepFixes: run.keepFixes,
  });
  const { phase, failure } = preparePhase({
    sources: sourceCount,
    ingestBusy,
    checking: run.starting && job === null,
    rows,
  });
  const target = prepareHandoff({
    pendingReviewCount: project?.edit_impact.pending_review_count ?? 0,
  });

  const onRowAction = (_row: ReadyRowId, action: ReadyAction) => {
    switch (action) {
      case "download-model":
        run.getModel();
        break;
      case "download-aligner":
        run.getAligner();
        break;
      case "try-again":
        run.tryAgain();
        break;
      case "keep-fixes":
        run.keepMyFixes();
        break;
      case "replace":
        run.replaceFixes();
        break;
      default:
        break;
    }
  };

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedStep, setSelectedStep] = useState<string | undefined>();
  const cfg = workingSet.cfg;
  const busyRow = rows.find((row) => row.state === "running");
  const failed = (error: unknown) =>
    useDawStore
      .getState()
      .announceStatus(`Could not save: ${errorMessage(error)}`, {
        tone: "error",
      });
  const advancedProps: AdvancedStepsProps = {
    groups: cfg ? advancedGroups(cfg, job) : [],
    selectedId: selectedStep,
    running: running
      ? { title: busyRow?.title ?? "Getting ready", detail: busyRow?.detail }
      : undefined,
    onSelect: setSelectedStep,
    onBack: () => setSelectedStep(undefined),
    onToggle: (id, enabled) =>
      void workingSet
        .update((current) => withStepSwitch(current, id, enabled))
        .catch(failed),
    onParam: (stepId, paramId, value) => {
      const path = paramPath(stepId, paramId);
      if (!path) return;
      void workingSet
        .update((current) => ({
          config: withParam(current.config, path, value),
        }))
        .catch(failed);
    },
    onReset: (stepId, paramId) => {
      const path = paramPath(stepId, paramId);
      const fallback = cfg && path ? getByPath(cfg.defaults, path) : undefined;
      if (!path) return;
      const value =
        typeof fallback === "number" || typeof fallback === "string"
          ? fallback
          : "auto";
      void workingSet
        .update((current) => ({
          config: withParam(current.config, path, value),
        }))
        .catch(failed);
    },
    onRunFromHere: (id) => {
      setAdvancedOpen(false);
      void run.run("run", false, id);
    },
    onCancel: () => void run.cancel(),
  };

  const view: PrepareViewProps = {
    phase,
    sessions,
    rows,
    readySummary: readySummary(rows),
    terms: vocabulary.terms,
    onTermsChange: vocabulary.onTermsChange,
    needsRetranscribe: vocabulary.needsRetranscribe,
    onRetranscribe: run.retranscribe,
    cleanup,
    onCleanup,
    handoff: handoffProps(phase, target),
    addCount: ingestBusy ? Math.max(sourceCount, 1) : undefined,
    dropActive: drop.active,
    dropCount: drop.count,
    failure,
    sourceActions: sourceState.actions,
    onImport: () => {
      void pickAudioFiles(true).then((files) => {
        if (files.length > 0) void ingestFiles(files, { kind: "new" });
      });
    },
    onRecord: () => runPointerCommand("stage.record"),
    onAdvanced: () => {
      setSelectedStep(undefined);
      setAdvancedOpen(true);
    },
    onRowAction,
    onHandoff: () => openStage(target.target),
  };
  return {
    view,
    advanced: {
      open: advancedOpen,
      onClose: () => setAdvancedOpen(false),
      props: advancedProps,
    },
    canIngest,
  };
}
