import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPipelineRun,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import {
  clearRetimeOffer,
  type NeedTarget,
  useModelResume,
  useWordTiming,
} from "../../models";
import { useDawStore } from "../../state/dawStore";
import {
  currentMediaKey,
  recordJobMedia,
  runIncludesTranscribe,
} from "../../state/jobMedia";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import {
  errorMessage,
  isModelNeeded,
  notDownloadedLine,
} from "../../utils/apiError";
import { takeAutoRun } from "../../utils/openIntent";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { OVERWRITE_REFUSED, oneRunSkipSteps } from "./prepareMappers";
import type { ReadyRowId } from "./ReadyList";

const TRANSCRIBE_STEP = "transcribe_tracks";
const modelKey = (model: Pick<NeedTarget, "id" | "variant">) =>
  `${model.id}:${model.variant ?? ""}`;
const BUSY_CODE = "pipeline_busy";

/** `update` redoes the transcripts whose audio changed, and only those. */
type RunMode = "run" | "retranscribe" | "retime" | "update";

/** Options for one run, from this episode's staged session settings. */
export function runOptions(
  cfg: PipelineConfigResponse,
  mode: RunMode,
  overwriteEdited: boolean,
  fromStep?: string,
  skipped?: ReadonlySet<ReadyRowId>,
): NonNullable<Parameters<typeof startPipelineRun>[1]> {
  const fromTranscribe = mode !== "run";
  return {
    skipSteps:
      skipped && skipped.size > 0 ? oneRunSkipSteps(cfg, skipped) : undefined,
    fromStep: fromTranscribe ? TRANSCRIBE_STEP : fromStep,
    enabledSteps: fromTranscribe
      ? [...new Set([...cfg.enabled_steps, TRANSCRIBE_STEP])]
      : cfg.enabled_steps,
    unattended: cfg.unattended,
    config: cfg.config,
    useWorkingSet: true,
    forceTranscribe: mode === "retranscribe",
    retimeWords: mode === "retime",
    overwriteEdited: fromTranscribe && overwriteEdited,
  };
}

type PrepareRunInput = {
  projectPath: string;
  workingSet: PipelineWorkingSet;
  /** Sources that still have no transcript. */
  untranscribed: number;
  /** Sources that have one: audio added next to them waits for the person. */
  transcribed: number;
  /** Changes when a track gains audio or is replaced. */
  mediaKey: string;
  ingestBusy: boolean;
  canRun: boolean;
  /** Names for a track id, for the keep-fixes line. */
  nameOf: (trackId: string) => string;
};

type RunRequest = {
  mode: RunMode;
  overwriteEdited: boolean;
  fromStep?: string;
  skipped?: ReadonlySet<ReadyRowId>;
};

type KeepFixes = {
  mode: Exclude<RunMode, "run">;
  names: string[];
};

/**
 * Runs the pipeline for Prepare. An initial import starts it once the files
 * are in. Audio added beside transcribed tracks waits for Process new audio.
 * A missing model shows Get and the run continues after its download.
 * Re-transcribe and Re-time words ask before replacing hand fixes. Word timing
 * installed anywhere waits for the Re-time words action.
 */
export function usePrepareRun(input: PrepareRunInput) {
  const { ingestBusy, canRun, mediaKey } = input;
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [keepFixes, setKeepFixes] = useState<KeepFixes | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const startingRef = useRef(false);
  /** Mirrors `waiting`, so a second refusal says so instead of doing nothing. */
  const waitingRef = useRef(false);
  const waitSkipRef = useRef<ReadonlySet<ReadyRowId> | undefined>(undefined);
  /** The request a missing model stopped, replayed once the model is in. */
  const refusedRef = useRef<RunRequest | null>(null);
  /** The request that failed to start, replayed by Try again. */
  const failedRef = useRef<RunRequest | null>(null);
  /** The model the stopped run already waited for once, so a second refusal says so instead of looping. */
  const retried = useRef<string | null>(null);
  const replay = useRef<(model: NeedTarget) => void>(() => undefined);
  const { stop: need, stopFor } = useModelResume((model) =>
    replay.current(model),
  );

  /**
   * The slot is taken, so nothing started. A plain run waits and goes on when
   * the slot frees (the row shows it); other modes say so, so none is silent.
   */
  const busyRefused = useCallback(
    (mode: RunMode, skipped?: ReadonlySet<ReadyRowId>) => {
      if (mode === "run" && !waitingRef.current) {
        waitingRef.current = true;
        waitSkipRef.current = skipped;
        setWaiting(true);
        return;
      }
      useDawStore
        .getState()
        .announceStatus(
          mode === "run"
            ? "Another job is running. Processing starts when it finishes."
            : "Another job is running. Try again when it finishes.",
          { tone: "error" },
        );
    },
    [],
  );

  const start = useCallback(
    async (
      mode: RunMode,
      overwriteEdited = false,
      fromStep?: string,
      skipped?: ReadonlySet<ReadyRowId>,
    ) => {
      if (startingRef.current) return;
      const store = useDawStore.getState();
      if (
        isPipelineSlotBusy(store.pipelineJob) ||
        isPipelineSlotBusy(store.activityJob)
      ) {
        busyRefused(mode, skipped);
        return;
      }
      startingRef.current = true;
      setStarting(true);
      setStartError(null);
      try {
        const { workingSet } = latest.current;
        const cfg = workingSet.cfg ?? (await workingSet.fetchFresh());
        if (!cfg) throw new Error("Could not read the pipeline settings.");
        let job: PipelineJobSnapshot;
        const keyAtRequest = currentMediaKey();
        const options = runOptions(
          cfg,
          mode,
          overwriteEdited,
          fromStep,
          skipped,
        );
        try {
          job = await startPipelineRun(latest.current.projectPath, options);
        } catch (error) {
          if (
            isModelNeeded(error) &&
            retried.current !== modelKey(error.model)
          ) {
            refusedRef.current = { mode, overwriteEdited, fromStep, skipped };
            stopFor(error.model);
            return;
          }
          if (isModelNeeded(error)) {
            retried.current = null;
            throw new Error(notDownloadedLine(error.model));
          }
          throw error;
        }
        if (runIncludesTranscribe({ fromStep: options.fromStep }))
          recordJobMedia(job.id, keyAtRequest);
        retried.current = null;
        clearRetimeOffer(latest.current.projectPath);
        refusedRef.current = null;
        failedRef.current = null;
        waitingRef.current = false;
        setWaiting(false);
        if (useDawStore.getState().projectPath === latest.current.projectPath) {
          useDawStore.getState().setPipelineJob(job);
        }
      } catch (error) {
        const code = (error as { code?: string | null }).code;
        if (code === BUSY_CODE) {
          busyRefused(mode, skipped);
        } else {
          waitingRef.current = false;
          setWaiting(false);
          failedRef.current = { mode, overwriteEdited, fromStep, skipped };
          setStartError(errorMessage(error));
          useDawStore
            .getState()
            .announceStatus(`Could not start: ${errorMessage(error)}`, {
              tone: "error",
            });
        }
      } finally {
        startingRef.current = false;
        setStarting(false);
      }
    },
    [busyRefused, stopFor],
  );

  // Import is done when the busy flag drops with different audio on the
  // tracks than when it rose.
  const wasBusy = useRef(ingestBusy);
  const keyAtStart = useRef(mediaKey);
  useEffect(() => {
    if (ingestBusy && !wasBusy.current) keyAtStart.current = mediaKey;
    if (!ingestBusy && wasBusy.current) {
      const waitsForPlan =
        latest.current.transcribed > 0 && latest.current.untranscribed > 0;
      if (
        canRun &&
        mediaKey &&
        mediaKey !== keyAtStart.current &&
        !waitsForPlan
      ) {
        void start("run");
      }
    }
    wasBusy.current = ingestBusy;
  }, [ingestBusy, mediaKey, canRun, start]);

  // A run refused for a busy slot goes on once the slot frees.
  const slotBusy = useDawStore(
    (s) =>
      isPipelineSlotBusy(s.pipelineJob) || isPipelineSlotBusy(s.activityJob),
  );
  useEffect(() => {
    if (waiting && !slotBusy && canRun) {
      void start("run", false, undefined, waitSkipRef.current);
    }
  }, [waiting, slotBusy, canRun, start]);

  // A failed start is old news once any job holds the slot.
  useEffect(() => {
    if (slotBusy) setStartError(null);
  }, [slotBusy]);

  // Audio that Home imported into this new episode starts processing on open,
  // once, the same as an import made here.
  useEffect(() => {
    if (!canRun || !mediaKey || ingestBusy) return;
    if (takeAutoRun(latest.current.projectPath)) void start("run");
  }, [canRun, mediaKey, ingestBusy, start]);

  // A run that stopped for a model goes on by itself once that model is in.
  replay.current = (model) => {
    const refused = refusedRef.current;
    refusedRef.current = null;
    retried.current = modelKey(model);
    void start(
      refused?.mode ?? "run",
      refused?.overwriteEdited ?? false,
      refused?.fromStep,
      refused?.skipped,
    );
  };

  /** Run from the transcribe step; ask first when hand fixes would be replaced. */
  const askToReplace = useCallback(
    async (mode: Exclude<RunMode, "run">) => {
      const { projectPath: path, nameOf } = latest.current;
      let edited: string[] = [];
      try {
        edited = (await loadTranscriptVocabulary(path)).edited_tracks ?? [];
      } catch (error) {
        useDawStore.getState().announceStatus(errorMessage(error), {
          tone: "error",
        });
        return;
      }
      if (edited.length === 0) {
        if (mode === "update") {
          useDawStore
            .getState()
            .announceStatus("Could not tell which tracks have hand fixes.", {
              tone: "error",
            });
          return;
        }
        await start(mode, false);
        return;
      }
      setKeepFixes({ mode, names: edited.map(nameOf) });
    },
    [start],
  );

  // A run the server refused because the audio changed under hand fixes asks
  // the same question as Re-transcribe. A refusal already there on arrival
  // stays a failed row, and Try again asks.
  const refusal = useDawStore((s) =>
    s.pipelineJob?.status === "error" &&
    s.pipelineJob.error_code === OVERWRITE_REFUSED
      ? s.pipelineJob.id
      : null,
  );
  const askedFor = useRef(refusal);
  useEffect(() => {
    if (!refusal || askedFor.current === refusal) return;
    askedFor.current = refusal;
    void askToReplace("update");
  }, [refusal, askToReplace]);

  const { row: alignerRow, missing, retime } = useWordTiming();

  return {
    starting,
    waiting,
    startError,
    model: need,
    keepFixes,
    /** Word timing is missing; null when the model is in or unknown. */
    approximateTiming: missing ? alignerRow : null,
    /** Word timing arrived after a transcript without it: offer to redo the timing. */
    retimeWords: retime,
    run: start,
    tryAgain: () => {
      if (refusal) return void askToReplace("update");
      const failed = startError ? failedRef.current : null;
      void start(
        failed?.mode ?? "run",
        failed?.overwriteEdited ?? false,
        failed?.fromStep,
        failed?.skipped,
      );
    },
    retranscribe: () => void askToReplace("retranscribe"),
    retime: () => void askToReplace("retime"),
    keepMyFixes: () => setKeepFixes(null),
    replaceFixes: () => {
      const pending = keepFixes;
      setKeepFixes(null);
      if (pending) void start(pending.mode, true);
    },
    cancel: async () => {
      const store = useDawStore.getState();
      const job = store.activityJob ?? store.pipelineJob;
      try {
        const done = await cancelPipelineRun(job?.id);
        store.setPipelineJob(done.kind === "pipeline" ? done : null);
        store.setActivityJob(done);
      } catch (error) {
        store.announceStatus(errorMessage(error), { tone: "error" });
      }
    },
  };
}
