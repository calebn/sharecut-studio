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
import type { TrackView } from "../../types/project";
import {
  errorMessage,
  isAbortError,
  isModelNeeded,
  type ModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import {
  parseSplitSpeakersResult,
  splitSpeakersDoneCopy,
} from "../../utils/speakerSplit";
import { MIN_VOICES, type SplitProgress, sourceTracks } from "./prepareMappers";
import type { SourceActions } from "./prepareTypes";

const NAME_SAVE_MS = 600;
const HEAR_SEC = 4;

type Keyed<T> = Readonly<Record<string, T>>;

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
}) {
  const { projectPath, tracks, activityJob, isPlaying } = input;
  const { download } = useModels();
  const [names, setNames] = useState<Keyed<string>>({});
  const [chosenVoices, setChosenVoices] = useState<Keyed<number>>({});
  const [splitting, setSplitting] = useState<Keyed<SplitProgress>>({});
  const [splitFailed, setSplitFailed] = useState<Keyed<string>>({});
  const [playingId, setPlayingId] = useState<string | null>(null);
  const splitJobs = useRef(new Map<string, string>());
  const splitNeeds = useRef(new Map<string, ModelNeeded>());
  const timers = useRef(
    new Map<string, { timer: number; name: string }>(),
  );
  const latest = useRef({ projectPath, tracks, chosenVoices });
  latest.current = { projectPath, tracks, chosenVoices };
  const soloBefore = useRef<Record<string, boolean> | null>(null);

  // A typed name is shown at once and saved a moment after the last key.
  const saveName = useCallback((trackId: string, name: string) => {
    const { projectPath: path } = latest.current;
    const trimmed = name.trim();
    if (!trimmed) return;
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

  const startSplit = useCallback(async (trackId: string) => {
    const {
      projectPath: path,
      tracks: all,
      chosenVoices: chosen,
    } = latest.current;
    const track = all.find((candidate) => candidate.id === trackId);
    const label = track?.speaker?.trim() || track?.label || trackId;
    setSplitFailed((current) => without(current, trackId));
    setSplitting((current) => ({
      ...current,
      [trackId]: { detail: "Starting" },
    }));
    const scope = projectScopedSignal(path);
    let jobId: string | null = null;
    try {
      const job = await startSplitSpeakersJob(path, {
        trackId,
        speakerCount: chosen[trackId] ?? MIN_VOICES,
        names: null,
        enrollment: null,
      });
      jobId = job.id;
      splitJobs.current.set(trackId, job.id);
      const store = useDawStore.getState();
      store.expectJobResult(job.id);
      seedStudioJob(job);
      const done = await followJobToOk(job.id, "Split failed", {
        signal: scope.signal,
      });
      const result = parseSplitSpeakersResult(done.result);
      if (result == null) {
        throw new Error("The split finished without saying what it made");
      }
      await refreshDocumentProject(path);
      const after = useDawStore.getState();
      after.announceStatus(splitSpeakersDoneCopy(result, label), {
        undo: result.history_head_id,
      });
      after.markJobResultsSpoken([job.id]);
    } catch (error) {
      if (jobId !== null) useDawStore.getState().settleJobResult(jobId);
      if (isAbortError(error) || error instanceof JobCancelledError) return;
      if (isModelNeeded(error)) {
        splitNeeds.current.set(trackId, error.model);
        setSplitFailed((current) => ({
          ...current,
          [trackId]: `${notDownloadedLine(error.model)} Try again to download it.`,
        }));
      } else {
        setSplitFailed((current) => ({
          ...current,
          [trackId]: errorMessage(error),
        }));
      }
    } finally {
      scope.dispose();
      splitJobs.current.delete(trackId);
      setSplitting((current) => without(current, trackId));
    }
  }, []);

  // The split's own progress, from the job the Activity chip follows.
  const shownSplitting = Object.fromEntries(
    Object.entries(splitting).map(([id, progress]) => {
      const job =
        activityJob && splitJobs.current.get(id) === activityJob.id
          ? activityJob
          : null;
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

  const actions: SourceActions = {
    onName: (id, name) => {
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
    onSplit: (id) => void startSplit(id),
    onCancelSplit: (id) => {
      const jobId = splitJobs.current.get(id);
      if (jobId) void cancelPipelineRun(jobId).catch(() => undefined);
    },
    onRetry: (id) => {
      const need = splitNeeds.current.get(id);
      if (need) {
        splitNeeds.current.delete(id);
        void download([need.id]).then((outcome) => {
          if (outcome.kind === "ok") void startSplit(id);
        });
        return;
      }
      if (splitFailed[id]) void startSplit(id);
      else runPointerCommand("media.import", { trackId: id });
    },
    onDetails: (id) => {
      const cause = splitFailed[id];
      if (cause) useDawStore.getState().announceStatus(cause);
    },
    onReplace: (id) => runPointerCommand("media.import", { trackId: id }),
    onMove: (id, direction) => {
      const all = latest.current.tracks;
      const here = all.findIndex((track) => track.id === id);
      const mine = sourceTracks(all);
      const at = mine.findIndex((track) => track.id === id);
      const neighbour = mine[direction === "up" ? at - 1 : at + 1];
      const to = neighbour ? all.findIndex((t) => t.id === neighbour.id) : -1;
      if (here < 0 || to < 0) return;
      void executePointerCommand("track.reorder", { trackId: id, index: to });
    },
  };

  return {
    actions,
    names,
    chosenVoices,
    splitting: shownSplitting,
    splitFailed,
    playingId,
  };
}
