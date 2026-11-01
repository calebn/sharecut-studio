import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { runPointerCommand } from "../../commands/pointer";
import { usePipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { ingestFiles, pickAudioFiles } from "../../ingest/ingestFiles";
import { canIngestMedia, canManageProjects } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { mediaKeyOf } from "../../state/jobMedia";
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
import { takeSoundScanStartFailure } from "./applySoundScanStart";
import type { PrepareViewProps } from "./PrepareView";
import {
  handoffProps,
  hasMedia,
  planNote,
  prepareHandoff,
  preparePhase,
  prepareSessions,
  type RerunPlan,
  readyRows,
  readySummary,
  reuseNote,
  sourceTracks,
  trackLabel,
  transcriptIndex,
} from "./prepareMappers";
import type { ReadyAction, ReadyRowId } from "./ReadyList";
import {
  readSoundScanStart,
  SOUND_SCAN_PATH,
  SOUND_SCAN_STEP,
  soundScanTime,
  writeSoundScanStart,
} from "./soundScan";
import { useCleanup } from "./useCleanup";
import { useJobCoverage } from "./useJobCoverage";
import { usePrepareDrop } from "./usePrepareDrop";
import { usePrepareRun } from "./usePrepareRun";
import { usePrepareSources } from "./usePrepareSources";
import { useVocabulary } from "./useVocabulary";

type PrepareModel = {
  view: PrepareViewProps;
  advanced: {
    open: boolean;
    onClose: () => void;
    props: AdvancedStepsProps;
  };
};

/**
 * "Split speakers…" elsewhere sets a track to look at: scroll to its card
 * once, and let go of it when the person leaves Prepare.
 */
function usePrepareFocus(trackId: string | null, ready: boolean): void {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!trackId || !ready || done.current === trackId) return;
    const card = document.querySelector<HTMLElement>(
      `[data-source-id="${CSS.escape(trackId)}"]`,
    );
    if (!card) return;
    done.current = trackId;
    card.scrollIntoView?.({ block: "center" });
    card.focus({ preventScroll: true });
  }, [trackId, ready]);
  useEffect(
    () => () => useDawStore.getState().setPrepareFocusTrackId(null),
    [],
  );
}

const NO_ROWS: ReadonlySet<ReadyRowId> = new Set();

export function usePrepareModel(): PrepareModel {
  const {
    project,
    projectPath,
    guestMode,
    shareCapabilities,
    pipelineJob,
    activityJob,
    ingestBusy,
    ingestFileCount,
    isPlaying,
    openStage,
    focusTrackId,
  } = useDawStore(
    useShallow((s) => ({
      project: s.project,
      projectPath: s.projectPath,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
      pipelineJob: s.pipelineJob,
      activityJob: s.activityJob,
      ingestBusy: s.ingestBusy,
      ingestFileCount: s.ingestFileCount,
      isPlaying: s.isPlaying,
      openStage: s.openStage,
      focusTrackId: s.prepareFocusTrackId,
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
  const mediaKey = mediaKeyOf(sourcesNow);

  const jobCoversMedia = useJobCoverage(job?.id ?? null, mediaKey);

  const run = usePrepareRun({
    projectPath,
    workingSet,
    untranscribed: untranscribed.length,
    transcribed: sourcesNow.length - untranscribed.length,
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

  // Audio added after a finished run: the rows show the plan and nothing
  // starts until Process new audio. Skips on its rows are for that one run.
  const [skippedRows, setSkippedRows] =
    useState<ReadonlySet<ReadyRowId>>(NO_ROWS);
  const [soundScanStart, setSoundScanStart] = useState(readSoundScanStart);
  const newTracks = untranscribed.filter(hasMedia);
  const planWaits =
    canIngest &&
    !ingestBusy &&
    newTracks.length > 0 &&
    sourcesNow.length > newTracks.length &&
    !jobCoversMedia;
  const planShown =
    planWaits &&
    !running &&
    !run.starting &&
    !run.waiting &&
    !run.model &&
    !run.keepFixes &&
    !run.startError;
  // A skip belongs to the plan that is on screen; any other state drops it.
  if (!planShown && skippedRows.size > 0) setSkippedRows(NO_ROWS);

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
    focusTrackId,
    newTrackIds: planShown ? new Set(newTracks.map((t) => t.id)) : undefined,
  });
  usePrepareFocus(focusTrackId, sessions.length > 0);
  useEffect(() => {
    if (!takeSoundScanStartFailure(projectPath)) return;
    useDawStore
      .getState()
      .announceStatus(
        "Could not confirm this browser's choice for sound actions. Check Advanced before processing. Episode switches reset when ShareCut restarts.",
        { tone: "error" },
      );
  }, [projectPath]);
  const sourceCount = sessions.reduce(
    (sum, one) => sum + one.sources.length,
    0,
  );
  const cfg = workingSet.cfg;
  const nameOfTrack = (id: string) => {
    const track = tracks.find((t) => t.id === id);
    return track ? track.speaker?.trim() || trackLabel(track) : id;
  };
  const plan: RerunPlan | null = planShown
    ? {
        newNames: newTracks.map((t) => nameOfTrack(t.id)),
        kept: sourcesNow.length - newTracks.length,
        skipped: skippedRows,
        settings: cfg,
        settingsError: workingSet.loadError,
        scan:
          cfg?.enabled_steps.includes(SOUND_SCAN_STEP) &&
          getByPath(cfg.config, SOUND_SCAN_PATH) === true
            ? {
                time: soundScanTime(
                  sourcesNow.reduce((sum, t) => sum + (t.duration_sec ?? 0), 0),
                ),
              }
            : null,
      }
    : null;
  const rows = readyRows({
    sourceCount,
    ingestBusy,
    transcribed: sourceCount > 0 && untranscribed.length === 0,
    jobCoversMedia,
    starting: run.starting,
    waiting: run.waiting,
    startError: run.startError,
    job,
    pendingSuggestions: project?.edit_impact.pending_review_count ?? 0,
    model: run.model,
    approximateTiming: run.approximateTiming,
    keepFixes: run.keepFixes,
    plan,
  });
  const { phase, failure } = preparePhase({
    sources: sourceCount,
    ingestBusy,
    checking: run.starting && job === null,
    model: run.model,
    waiting: run.waiting,
    plan: planShown,
    rows,
  });
  const target = prepareHandoff({
    pendingReviewCount: project?.edit_impact.pending_review_count ?? 0,
    newAudio: planShown,
  });
  const processNewAudio = () => {
    if (!cfg) return;
    const skipped = skippedRows;
    setSkippedRows(NO_ROWS);
    void run.run("run", false, undefined, skipped);
  };

  const onRowAction = (row: ReadyRowId, action: ReadyAction) => {
    switch (action) {
      case "skip":
      case "include":
        setSkippedRows((current) => {
          const next = new Set(current);
          if (action === "skip") next.add(row);
          else next.delete(row);
          return next;
        });
        break;
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
  const busyRow = rows.find((row) => row.state === "running");
  const failed = (error: unknown) =>
    useDawStore
      .getState()
      .announceStatus(`Could not save: ${errorMessage(error)}`, {
        tone: "error",
      });
  const advancedProps: AdvancedStepsProps = {
    groups: cfg ? advancedGroups(cfg, job, { soundScanStart }) : [],
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
    onPersonal: (stepId, on) => {
      if (stepId !== SOUND_SCAN_STEP) return;
      writeSoundScanStart(on);
      setSoundScanStart(on);
    },
    onReset: (stepId, paramId) => {
      const path = paramPath(stepId, paramId);
      if (!path) return;
      const fallback = cfg ? getByPath(cfg.defaults, path) : undefined;
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
    readySummary: readySummary(rows, planShown),
    readyNote: plan
      ? planNote(plan)
      : job && !running && jobCoversMedia
        ? reuseNote(job)
        : undefined,
    onRunAll:
      canIngest && sourcesNow.length > untranscribed.length
        ? run.retranscribe
        : undefined,
    terms: vocabulary.terms,
    onTermsChange: vocabulary.onTermsChange,
    needsRetranscribe: vocabulary.needsRetranscribe,
    onRetranscribe: run.retranscribe,
    cleanup,
    onCleanup,
    handoff:
      planShown && !cfg
        ? {
            label: target.label,
            disabledReason: workingSet.loadError
              ? "Open Advanced to try loading saved steps again"
              : "Loading saved steps",
          }
        : handoffProps(phase, target),
    addCount: ingestBusy && ingestFileCount > 0 ? ingestFileCount : undefined,
    dropActive: drop.active,
    dropCount: drop.count,
    failure,
    sourceActions: {
      ...sourceState.actions,
      onSplit: (id) => {
        useDawStore.getState().setPrepareFocusTrackId(null);
        sourceState.actions.onSplit(id);
      },
    },
    onImport: () => {
      void pickAudioFiles(true).then((files) => {
        if (files.length > 0) void ingestFiles(files, { kind: "new" });
      });
    },
    onRecord: () => runPointerCommand("stage.record"),
    onAdvanced: () => {
      if (!cfg && workingSet.loadError) workingSet.reload();
      setSelectedStep(undefined);
      setAdvancedOpen(true);
    },
    onRowAction,
    onHandoff: () =>
      target.target === "process"
        ? processNewAudio()
        : openStage(target.target),
  };
  return {
    view,
    advanced: {
      open: advancedOpen,
      onClose: () => setAdvancedOpen(false),
      props: advancedProps,
    },
  };
}
