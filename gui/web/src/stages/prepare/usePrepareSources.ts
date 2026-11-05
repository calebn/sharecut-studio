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
import { useModels } from "../../models";
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
import { useStableCallback } from "../../utils/useStableCallback";
import { MIN_VOICES, type SplitProgress, sourceTracks } from "./prepareMappers";
import type { SourceActions } from "./prepareTypes";

const NAME_SAVE_MS = 600;
const HEAR_SEC = 4;

type Keyed<T> = Readonly<Record<string, T>>;

function without<T>(map: Keyed<T>, id: string): Keyed<T> {
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
}

type SourceOwner = { path: string; epoch: number };
type SplitAttempt = { owner: SourceOwner; jobId: string | null };
type SplitRead = {
  attempt: SplitAttempt;
  progress: SplitProgress;
  jobId: string | null;
};
type SourceRead = {
  owner: SourceOwner;
  tracks: readonly TrackView[];
  names: Keyed<string>;
  chosenVoices: Keyed<number>;
  splitting: Keyed<SplitRead>;
  splitFailed: Keyed<string>;
  playingId: string | null;
};
type PendingName = { owner: SourceOwner; timer: number; name: string };

function currentSource(owner: SourceOwner): boolean {
  const store = useDawStore.getState();
  return store.projectPath === owner.path && store.projectEpoch === owner.epoch;
}

/** What the Source cards show and do that the project does not hold. */
export function usePrepareSources(input: {
  projectPath: string;
  tracks: readonly TrackView[];
  /** The job the Activity chip follows, for the split's progress. */
  activityJob: PipelineJobSnapshot | null;
  isPlaying: boolean;
}) {
  const { projectPath, tracks, activityJob, isPlaying } = input;
  const epoch = useDawStore((store) => store.projectEpoch);
  const { download } = useModels();
  const [read, setRead] = useState<SourceRead>(() => ({
    owner: { path: projectPath, epoch },
    tracks,
    names: {},
    chosenVoices: {},
    splitting: {},
    splitFailed: {},
    playingId: null,
  }));
  const { owner } = read;
  if (owner.path !== projectPath || owner.epoch !== epoch) {
    setRead({
      owner: { path: projectPath, epoch },
      tracks,
      names: {},
      chosenVoices: {},
      splitting: {},
      splitFailed: {},
      playingId: null,
    });
  } else if (
    read.tracks !== tracks ||
    (!isPlaying && read.playingId !== null)
  ) {
    const names =
      read.tracks !== tracks
        ? Object.fromEntries(
            Object.entries(read.names).filter(([id, name]) => {
              const track = tracks.find((candidate) => candidate.id === id);
              return track && (track.speaker ?? "") !== name;
            }),
          )
        : read.names;
    setRead({
      ...read,
      tracks,
      names,
      playingId: isPlaying ? read.playingId : null,
    });
  }

  const splitJobs = useRef(new Map<string, SplitAttempt>());
  const splitUndos = useRef(
    new Map<string, { owner: SourceOwner; head: HistoryEntryId }>(),
  );
  const splitNeeds = useRef(
    new Map<string, { attempt: SplitAttempt; need: ModelNeeded }>(),
  );
  const timers = useRef(new Map<string, PendingName>());
  const soloBefore = useRef<{
    owner: SourceOwner;
    map: Record<string, boolean>;
  } | null>(null);

  const saveName = useCallback(
    (source: SourceOwner, trackId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      if (currentSource(source)) {
        const toast = useDawStore.getState().feedbackToast;
        if (toast?.undo) useDawStore.getState().dropFeedbackUndo(toast.id);
      }
      void setTrackMetaCommand(source.path, trackId, {
        label: trimmed,
        speaker: trimmed,
      }).catch((error: unknown) => {
        if (currentSource(source))
          useDawStore
            .getState()
            .announceStatus(`Could not save the name: ${errorMessage(error)}`, {
              tone: "error",
            });
      });
    },
    [],
  );

  useEffect(
    () => () => {
      for (const [id, pending] of timers.current) {
        if (pending.owner !== owner) continue;
        window.clearTimeout(pending.timer);
        timers.current.delete(id);
        saveName(pending.owner, id, pending.name);
      }
    },
    [owner, saveName],
  );

  useEffect(() => {
    if (isPlaying || soloBefore.current === null) return;
    const hearing = soloBefore.current;
    soloBefore.current = null;
    if (currentSource(hearing.owner))
      useDawStore.getState().setSoloMap(hearing.map);
  }, [isPlaying, owner]);

  const hear = useCallback(
    (id: string) => {
      if (!currentSource(owner)) return;
      const store = useDawStore.getState();
      if (store.isPlaying && soloBefore.current?.owner === owner) {
        store.setIsPlaying(false);
        return;
      }
      const first = store.project?.transcript?.utterances.find(
        (row) => row.track_id === id,
      );
      const start = first?.timeline_start ?? first?.start ?? 0;
      soloBefore.current = { owner, map: store.soloTracks };
      store.setSoloMap({ [id]: true });
      store.beginAudition({ playheadSec: start, untilSec: start + HEAR_SEC });
      setRead((current) =>
        current.owner === owner ? { ...current, playingId: id } : current,
      );
    },
    [owner],
  );

  const startSplit = useStableCallback(async (trackId: string) => {
    if (
      !currentSource(owner) ||
      splitJobs.current.get(trackId)?.owner === owner
    )
      return;
    const path = owner.path;
    const track = tracks.find((candidate) => candidate.id === trackId);
    const label = track?.speaker?.trim() || track?.label || trackId;
    const attempt: SplitAttempt = { owner, jobId: null };
    splitJobs.current.set(trackId, attempt);
    setRead((current) =>
      current.owner === owner
        ? {
            ...current,
            splitFailed: without(current.splitFailed, trackId),
            splitting: {
              ...current.splitting,
              [trackId]: {
                attempt,
                progress: { detail: "Starting" },
                jobId: null,
              },
            },
          }
        : current,
    );
    const scope = projectScopedSignal({ lifetime: "path", path });
    const before = useDawStore.getState();
    const knownActivity = before.activityJob?.id;
    const knownPipeline = before.pipelineJob?.id;
    try {
      const job = await startSplitSpeakersJob(path, {
        trackId,
        speakerCount: read.chosenVoices[trackId] ?? MIN_VOICES,
        names: null,
        enrollment: null,
      });
      attempt.jobId = job.id;
      if (scope.signal.aborted) return;
      setRead((current) =>
        current.owner === owner &&
        current.splitting[trackId]?.attempt === attempt
          ? {
              ...current,
              splitting: {
                ...current.splitting,
                [trackId]: { ...current.splitting[trackId], jobId: job.id },
              },
            }
          : current,
      );
      const store = useDawStore.getState();
      store.expectJobResult(job.id);
      if (
        (store.activityJob?.id === knownActivity ||
          store.activityJob?.id === job.id ||
          store.activityJob == null) &&
        (store.pipelineJob?.id === knownPipeline ||
          store.pipelineJob?.id === job.id ||
          store.pipelineJob == null)
      )
        seedStudioJob(job);
      const done = await followJobToOk(job.id, "Split failed", {
        signal: scope.signal,
      });
      if (scope.signal.aborted) {
        useDawStore.getState().settleJobResult(job.id);
        return;
      }
      const result = parseSplitSpeakersResult(done.result);
      if (result == null)
        throw new Error("The split finished without saying what it made");
      await refreshDocumentProject(path);
      if (scope.signal.aborted) {
        useDawStore.getState().settleJobResult(job.id);
        return;
      }
      const after = useDawStore.getState();
      after.announceStatus(splitSpeakersDoneCopy(result, label), {
        undo: result.history_head_id,
      });
      if (
        result.history_head_id &&
        currentSource(owner) &&
        splitJobs.current.get(trackId) === attempt
      ) {
        splitUndos.current.set(trackId, {
          owner,
          head: result.history_head_id,
        });
      }
      after.markJobResultsSpoken([job.id]);
    } catch (error) {
      if (attempt.jobId !== null)
        useDawStore.getState().settleJobResult(attempt.jobId);
      if (
        scope.signal.aborted ||
        isAbortError(error) ||
        error instanceof JobCancelledError ||
        !currentSource(owner) ||
        splitJobs.current.get(trackId) !== attempt
      )
        return;
      let cause: string;
      if (isModelNeeded(error)) {
        splitNeeds.current.set(trackId, { attempt, need: error.model });
        cause = `${notDownloadedLine(error.model)} Try again to download it.`;
      } else cause = plainError(errorMessage(error));
      setRead((current) =>
        current.owner === owner &&
        current.splitting[trackId]?.attempt === attempt
          ? {
              ...current,
              splitFailed: { ...current.splitFailed, [trackId]: cause },
            }
          : current,
      );
    } finally {
      scope.dispose();
      if (splitJobs.current.get(trackId) === attempt)
        splitJobs.current.delete(trackId);
      setRead((current) =>
        current.owner === owner &&
        current.splitting[trackId]?.attempt === attempt
          ? {
              ...current,
              splitting: without(current.splitting, trackId),
            }
          : current,
      );
    }
  });

  const shownSplitting = Object.fromEntries(
    Object.entries(read.splitting).map(([id, split]) => {
      const job =
        activityJob && split.jobId === activityJob.id ? activityJob : null;
      const total = job?.total ?? 0;
      return [
        id,
        job && total > 0
          ? {
              detail: `Finding voices · ${job.current ?? 0} of ${total}`,
              progress: (job.current ?? 0) / total,
            }
          : split.progress,
      ];
    }),
  );

  const actions: SourceActions = {
    onName: (id, name) => {
      if (!currentSource(owner)) return;
      const undo = splitUndos.current.get(id);
      const toast = useDawStore.getState().feedbackToast;
      if (undo?.owner === owner && toast?.undo === undo.head)
        useDawStore.getState().dropFeedbackUndo(toast.id);
      setRead((current) =>
        current.owner === owner
          ? { ...current, names: { ...current.names, [id]: name } }
          : current,
      );
      const previous = timers.current.get(id);
      if (previous) {
        window.clearTimeout(previous.timer);
        if (previous.owner !== owner)
          saveName(previous.owner, id, previous.name);
      }
      const pending: PendingName = {
        owner,
        name,
        timer: window.setTimeout(() => {
          if (timers.current.get(id) !== pending) return;
          timers.current.delete(id);
          saveName(owner, id, name);
        }, NAME_SAVE_MS),
      };
      timers.current.set(id, pending);
    },
    onRemove: (id) => runPointerCommand("track.remove", { trackId: id }),
    onHear: hear,
    onVoices: (id, voices) =>
      setRead((current) =>
        current.owner === owner
          ? {
              ...current,
              chosenVoices: { ...current.chosenVoices, [id]: voices },
            }
          : current,
      ),
    onSplit: (id) => void startSplit(id),
    onCancelSplit: (id) => {
      const attempt = splitJobs.current.get(id);
      if (attempt?.owner === owner && attempt.jobId)
        void cancelPipelineRun(attempt.jobId).catch(() => undefined);
    },
    onRetry: (id) => {
      const refused = splitNeeds.current.get(id);
      if (refused?.attempt.owner === owner) {
        splitNeeds.current.delete(id);
        void download([refused.need.id]).then((outcome) => {
          if (outcome.kind === "ok" && currentSource(owner))
            void startSplit(id);
        });
        return;
      }
      if (read.splitFailed[id]) void startSplit(id);
      else runPointerCommand("media.import", { trackId: id });
    },
    onDetails: (id) => {
      const cause = read.splitFailed[id];
      if (cause) useDawStore.getState().announceStatus(cause);
    },
    onReplace: (id) => runPointerCommand("media.import", { trackId: id }),
    onMove: (id, direction) => {
      const here = tracks.findIndex((track) => track.id === id);
      const mine = sourceTracks(tracks);
      const at = mine.findIndex((track) => track.id === id);
      const neighbour = mine[direction === "up" ? at - 1 : at + 1];
      const to = neighbour
        ? tracks.findIndex((track) => track.id === neighbour.id)
        : -1;
      if (here < 0 || to < 0) return;
      void executePointerCommand("track.reorder", { trackId: id, index: to });
    },
  };
  return {
    actions,
    names: read.names,
    chosenVoices: read.chosenVoices,
    splitting: shownSplitting,
    splitFailed: read.splitFailed,
    playingId: read.playingId,
  };
}
