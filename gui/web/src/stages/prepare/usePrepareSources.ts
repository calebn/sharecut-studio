import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPipelineRun,
  followJobToOk,
  JobCancelledError,
  setTrackMetaCommand,
  startSplitSpeakersJob,
} from "../../api";
import {
  executePointerCommand,
  runPointerCommand,
} from "../../commands/pointer";
import { refreshDocumentProject } from "../../document/applyDocumentUpdate";
import { audioFilesFromDrop } from "../../ingest/dropLabels";
import { ingestFiles } from "../../ingest/ingestFiles";
import { useModelResume } from "../../models";
import { useDawStore } from "../../state/dawStore";
import { projectScopedSignal } from "../../state/projectScopedSignal";
import { seedStudioJob } from "../../state/seedStudioJob";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { HistoryEntryId, TrackView } from "../../types/project";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { plainError } from "../../utils/plainError";
import {
  parseSplitSpeakersResult,
  splitSpeakersDoneCopy,
} from "../../utils/speakerSplit";
import { MIN_VOICES, type SplitProgress, sourceTracks } from "./prepareMappers";
import type { SourceActions } from "./prepareTypes";

const NAME_SAVE_MS = 600;
const HEAR_SEC = 4;

type Keyed<T> = Readonly<Record<string, T>>;

type SplitRequest = {
  projectPath: string;
  projectEpoch: number;
  trackId: string;
  speakerCount: number;
  label: string;
};

type SplitOperation = {
  request: SplitRequest;
  state:
    | { kind: "starting" }
    | { kind: "cancelling" }
    | { kind: "running"; jobId: string }
    | { kind: "cancelling-job"; jobId: string };
};

function ownsSplit(request: SplitRequest) {
  const store = useDawStore.getState();
  return (
    store.projectPath === request.projectPath &&
    store.projectEpoch === request.projectEpoch
  );
}

function without<T>(map: Keyed<T>, id: string): Keyed<T> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
}

/** What the Source cards show and do that the project does not hold. */
export function usePrepareSources(input: {
  projectPath: string;
  tracks: readonly TrackView[];
  /** The job the Activity chip follows, for the split's progress. */
  activityJob: PipelineJobSnapshot | null;
  isPlaying: boolean;
  /** False for a guest or a share link: a card then takes no drop. */
  canIngest: boolean;
}) {
  const { projectPath, tracks, activityJob, isPlaying, canIngest } = input;
  const [names, setNames] = useState<Keyed<string>>({});
  const [chosenVoices, setChosenVoices] = useState<Keyed<number>>({});
  const [splitting, setSplitting] = useState<Keyed<SplitProgress>>({});
  const [splitFailed, setSplitFailed] = useState<Keyed<string>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const splitOperations = useRef(new Map<string, SplitOperation>());
  const retrySplits = useRef(new Map<string, SplitRequest>());
  const splitUndos = useRef(new Map<string, HistoryEntryId>());
  const [splitNeeds, setSplitNeeds] = useState<Keyed<ModelNeeded>>({});
  const pendingSplits = useRef(
    new Map<string, { request: SplitRequest; model: ModelNeeded }>(),
  );
  const drainingSplits = useRef<SplitRequest | null>(null);
  /** Tracks whose split already ran again after a model landed, so a second refusal says so. */
  const resumed = useRef(new Set<string>());
  const startSplitRef = useRef<(request: SplitRequest) => Promise<boolean>>(
    async () => false,
  );
  const { stopFor, clear } = useModelResume((model) => {
    const waiting = [...pendingSplits.current.values()].filter(
      (pending) =>
        ownsSplit(pending.request) &&
        pending.model.id === model.id &&
        pending.model.variant === model.variant,
    );
    const operation = waiting[0]?.request;
    if (!operation || drainingSplits.current) return;
    drainingSplits.current = operation;
    for (const { request } of waiting) {
      setSplitNeeds((current) => without(current, request.trackId));
      setSplitting((current) => ({
        ...current,
        [request.trackId]: { detail: "Waiting for another split" },
      }));
    }
    void (async () => {
      try {
        for (const pending of pendingSplits.current.values()) {
          if (drainingSplits.current !== operation || !ownsSplit(operation))
            return;
          if (
            pending.model.id !== model.id ||
            pending.model.variant !== model.variant
          )
            continue;
          const { request } = pending;
          if (!ownsSplit(request)) return;
          if (pendingSplits.current.get(request.trackId) !== pending) continue;
          resumed.current.add(request.trackId);
          const completed = await startSplitRef.current(request);
          if (drainingSplits.current !== operation || !ownsSplit(operation))
            return;
          if (!completed) {
            for (const remaining of pendingSplits.current.values()) {
              const id = remaining.request.trackId;
              if (
                !ownsSplit(remaining.request) ||
                pendingSplits.current.get(id) !== remaining
              )
                continue;
              pendingSplits.current.delete(id);
              retrySplits.current.set(id, remaining.request);
              setSplitting((current) => without(current, id));
              setSplitFailed((current) => ({
                ...current,
                [id]: "Another split did not finish. Try again.",
              }));
            }
            return;
          }
        }
      } finally {
        if (drainingSplits.current === operation) drainingSplits.current = null;
      }
    })();
  });
  const timers = useRef(new Map<string, { timer: number; name: string }>());
  const latest = useRef({ projectPath, tracks, chosenVoices });
  latest.current = { projectPath, tracks, chosenVoices };
  const soloBefore = useRef<Record<string, boolean> | null>(null);

  // A typed name is shown at once and saved a moment after the last key.
  const saveName = useCallback((trackId: string, name: string) => {
    const { projectPath: path } = latest.current;
    const trimmed = name.trim();
    if (!trimmed) return;
    // The rename becomes the newest history entry, so a standing Undo would be refused as stale.
    const toast = useDawStore.getState().feedbackToast;
    if (toast?.undo) useDawStore.getState().dropFeedbackUndo(toast.id);
    void setTrackMetaCommand(path, trackId, {
      label: trimmed,
      speaker: trimmed,
    }).catch((error: unknown) => {
      useDawStore
        .getState()
        .announceStatus(`Could not save the name: ${errorMessage(error)}`, {
          tone: "error",
        });
    });
  }, []);

  // A draft ends once the project holds what it says.
  useEffect(() => {
    setNames((current) => {
      const settled = Object.keys(current).filter((id) => {
        const track = tracks.find((candidate) => candidate.id === id);
        return !track || (track.speaker ?? "") === current[id];
      });
      return settled.length === 0
        ? current
        : Object.fromEntries(
            Object.entries(current).filter(([id]) => !settled.includes(id)),
          );
    });
  }, [tracks]);

  // Leaving Prepare saves a name still waiting for its timer.
  useEffect(
    () => () => {
      for (const [id, pending] of timers.current) {
        window.clearTimeout(pending.timer);
        saveName(id, pending.name);
      }
      timers.current.clear();
    },
    [saveName],
  );

  // Hearing a voice solos it for a moment; the solo goes back when it stops.
  useEffect(() => {
    if (isPlaying || playingId === null) return;
    setPlayingId(null);
    if (soloBefore.current) {
      useDawStore.getState().setSoloMap(soloBefore.current);
      soloBefore.current = null;
    }
  }, [isPlaying, playingId]);

  const hear = useCallback((id: string) => {
    const store = useDawStore.getState();
    if (store.isPlaying && soloBefore.current) {
      store.setIsPlaying(false);
      return;
    }
    const first = store.project?.transcript?.utterances.find(
      (row) => row.track_id === id,
    );
    const start = first?.timeline_start ?? first?.start ?? 0;
    soloBefore.current = store.soloTracks;
    store.setSoloMap({ [id]: true });
    store.beginAudition({ playheadSec: start, untilSec: start + HEAR_SEC });
    setPlayingId(id);
  }, []);

  const cancelSplit = useCallback(
    (operation: SplitOperation, jobId: string) => {
      void cancelPipelineRun(jobId).catch(() => {
        const { request } = operation;
        if (
          !ownsSplit(request) ||
          splitOperations.current.get(request.trackId) !== operation
        )
          return;
        operation.state = { kind: "running", jobId };
        useDawStore
          .getState()
          .announceStatus("Could not cancel splitting. Try again.", {
            tone: "error",
          });
      });
    },
    [],
  );

  const startSplit = useCallback(
    async (request: SplitRequest): Promise<boolean> => {
      if (!ownsSplit(request)) return false;
      const { projectPath: path, trackId, label, speakerCount } = request;
      if (splitOperations.current.has(trackId)) return false;
      if (!latest.current.tracks.some((track) => track.id === trackId))
        return false;
      pendingSplits.current.delete(trackId);
      retrySplits.current.delete(trackId);
      const operation: SplitOperation = {
        request,
        state: { kind: "starting" },
      };
      splitOperations.current.set(trackId, operation);
      const ownsOperation = () =>
        ownsSplit(request) &&
        splitOperations.current.get(trackId) === operation;
      setSplitFailed((current) => without(current, trackId));
      setSplitNeeds((current) => without(current, trackId));
      setSplitting((current) => ({
        ...current,
        [trackId]: { detail: "Starting" },
      }));
      const scope = projectScopedSignal(path);
      let jobId: string | null = null;
      try {
        const job = await startSplitSpeakersJob(path, {
          trackId,
          speakerCount,
          names: null,
          enrollment: null,
        });
        jobId = job.id;
        const cancelled = operation.state.kind === "cancelling";
        operation.state = cancelled
          ? { kind: "cancelling-job", jobId: job.id }
          : { kind: "running", jobId: job.id };
        if (cancelled) cancelSplit(operation, job.id);
        if (!ownsOperation()) return false;
        const store = useDawStore.getState();
        store.expectJobResult(job.id);
        seedStudioJob(job);
        const done = await followJobToOk(job.id, "Split failed", {
          signal: scope.signal,
        });
        if (!ownsOperation()) return false;
        const result = parseSplitSpeakersResult(done.result);
        if (result == null) {
          throw new Error("The split finished without saying what it made");
        }
        await refreshDocumentProject(path);
        if (!ownsOperation()) return false;
        const after = useDawStore.getState();
        after.announceStatus(splitSpeakersDoneCopy(result, label), {
          undo: result.history_head_id,
        });
        if (result.history_head_id) {
          splitUndos.current.set(trackId, result.history_head_id);
        }
        after.markJobResultsSpoken([job.id]);
        resumed.current.delete(trackId);
        return true;
      } catch (error) {
        if (jobId !== null) useDawStore.getState().settleJobResult(jobId);
        if (!ownsOperation()) return false;
        if (
          operation.state.kind === "cancelling" ||
          operation.state.kind === "cancelling-job"
        )
          return false;
        if (isAbortError(error) || error instanceof JobCancelledError)
          return false;
        if (isModelNeeded(error) && !resumed.current.has(trackId)) {
          pendingSplits.current.set(trackId, { request, model: error.model });
          setSplitNeeds((current) => ({ ...current, [trackId]: error.model }));
          stopFor(error.model);
        } else if (isModelNeeded(error)) {
          resumed.current.delete(trackId);
          setSplitFailed((current) => ({
            ...current,
            [trackId]: notDownloadedLine(error.model),
          }));
        } else {
          resumed.current.delete(trackId);
          setSplitFailed((current) => ({
            ...current,
            [trackId]: plainError(errorMessage(error)),
          }));
        }
        return false;
      } finally {
        scope.dispose();
        if (ownsOperation()) {
          if (
            operation.state.kind === "cancelling" ||
            operation.state.kind === "cancelling-job"
          )
            resumed.current.delete(trackId);
          splitOperations.current.delete(trackId);
          setSplitting((current) => without(current, trackId));
        }
      }
    },
    [stopFor, cancelSplit],
  );
  startSplitRef.current = startSplit;

  const splitTrack = (trackId: string) => {
    const {
      projectPath: path,
      tracks: all,
      chosenVoices: chosen,
    } = latest.current;
    const track = all.find((candidate) => candidate.id === trackId);
    if (!track) return;
    const pending = pendingSplits.current.get(trackId);
    void startSplit(
      pending?.request ??
        retrySplits.current.get(trackId) ?? {
          projectPath: path,
          projectEpoch: useDawStore.getState().projectEpoch,
          trackId,
          speakerCount: chosen[trackId] ?? MIN_VOICES,
          label: track.speaker?.trim() || track.label || trackId,
        },
    );
  };

  const projectEpoch = useDawStore((s) => s.projectEpoch);
  useEffect(() => {
    const pending = pendingSplits.current;
    const operations = splitOperations.current;
    const retries = retrySplits.current;
    drainingSplits.current = null;
    setSplitNeeds({});
    setSplitFailed({});
    setSplitting({});
    pendingSplits.current.clear();
    splitOperations.current.clear();
    retrySplits.current.clear();
    resumed.current.clear();
    clear();
    return () => {
      drainingSplits.current = null;
      pending.clear();
      operations.clear();
      retries.clear();
    };
  }, [projectPath, projectEpoch, clear]);

  // The split's own progress, from the job the Activity chip follows.
  const shownSplitting = Object.fromEntries(
    Object.entries(splitting).map(([id, progress]) => {
      const state = splitOperations.current.get(id)?.state;
      const jobId =
        state?.kind === "running" || state?.kind === "cancelling-job"
          ? state.jobId
          : null;
      const job = activityJob?.id === jobId ? activityJob : null;
      const total = job?.total ?? 0;
      return [
        id,
        job && total > 0
          ? {
              detail: `Finding voices · ${job.current ?? 0} of ${total}`,
              progress: (job.current ?? 0) / total,
            }
          : progress,
      ];
    }),
  );

  const moveTo = (id: string, targetId: string | undefined) => {
    const all = latest.current.tracks;
    const here = all.findIndex((track) => track.id === id);
    const to = all.findIndex((track) => track.id === targetId);
    if (here < 0 || to < 0) return;
    void executePointerCommand("track.reorder", { trackId: id, index: to });
  };

  const actions: SourceActions = {
    onName: (id, name) => {
      const toast = useDawStore.getState().feedbackToast;
      if (toast?.undo && toast.undo === splitUndos.current.get(id)) {
        useDawStore.getState().dropFeedbackUndo(toast.id);
      }
      setNames((current) => ({ ...current, [id]: name }));
      window.clearTimeout(timers.current.get(id)?.timer);
      timers.current.set(id, {
        name,
        timer: window.setTimeout(() => {
          timers.current.delete(id);
          saveName(id, name);
        }, NAME_SAVE_MS),
      });
    },
    onRemove: (id) => runPointerCommand("track.remove", { trackId: id }),
    onHear: hear,
    onVoices: (id, voices) =>
      setChosenVoices((current) => ({ ...current, [id]: voices })),
    onSplit: splitTrack,
    onCancelSplit: (id) => {
      pendingSplits.current.delete(id);
      setSplitNeeds((current) => without(current, id));
      retrySplits.current.delete(id);
      const operation = splitOperations.current.get(id);
      if (!operation) {
        setSplitting((current) => without(current, id));
      } else if (operation.state.kind === "starting") {
        operation.state = { kind: "cancelling" };
      } else if (operation.state.kind === "running") {
        const { jobId } = operation.state;
        operation.state = { kind: "cancelling-job", jobId };
        cancelSplit(operation, jobId);
      }
    },
    onRetry: (id) => {
      if (splitFailed[id] || pendingSplits.current.has(id)) splitTrack(id);
      else runPointerCommand("media.import", { trackId: id });
    },
    onDetails: (id) => {
      const cause = splitFailed[id];
      if (cause) useDawStore.getState().announceStatus(cause);
    },
    onReplace: (id) => runPointerCommand("media.import", { trackId: id }),
    onDropAudio: canIngest
      ? (id, dropped) => {
          const { announceStatus } = useDawStore.getState();
          if (dropped.length > 1) {
            announceStatus(
              "Drop one file on a card to replace its audio. Drop several anywhere else to add them as new tracks.",
            );
            return;
          }
          const files = audioFilesFromDrop(dropped);
          if (files.length === 0) {
            announceStatus("Only audio files can replace a track.");
          } else {
            void ingestFiles(files, { kind: "track", id });
          }
        }
      : undefined,
    onMove: (id, direction) => {
      const mine = sourceTracks(latest.current.tracks);
      const at = mine.findIndex((track) => track.id === id);
      moveTo(id, mine[direction === "up" ? at - 1 : at + 1]?.id);
    },
    onReorder: moveTo,
  };

  return {
    actions,
    names,
    chosenVoices,
    splitting: shownSplitting,
    splitFailed,
    splitNeeds,
    playingId,
  };
}
