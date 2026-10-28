import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPipelineRun,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import { type ModelView, modelActivity, useModels } from "../../models";
import { useDawStore } from "../../state/dawStore";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
} from "../../types/pipeline";
import {
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
} from "../../utils/apiError";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { type ModelAsk, OVERWRITE_REFUSED } from "./prepareMappers";

const TRANSCRIBE_STEP = "transcribe_tracks";
const WHISPER = "whisper";
const WORD_ALIGNER = "word-aligner";
const BUSY_CODE = "pipeline_busy";

/** `update` redoes the transcripts whose audio changed, and only those. */
type RunMode = "run" | "retranscribe" | "retime" | "update";

/** Options for one run, from the project's saved pipeline settings. */
export function runOptions(
  cfg: PipelineConfigResponse,
  mode: RunMode,
  overwriteEdited: boolean,
  fromStep?: string,
): NonNullable<Parameters<typeof startPipelineRun>[1]> {
  const fromTranscribe = mode !== "run";
  return {
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

function whatIs(need: ModelNeeded): string {
  return need.id === WHISPER
    ? "the transcription model"
    : need.id === WORD_ALIGNER
      ? "word timing"
      : need.label.toLowerCase();
}

function installed(row: ModelView | null, need: ModelNeeded): boolean {
  return (
    row?.state.kind === "installed" &&
    (need.id !== WHISPER || !need.variant || row.variant === need.variant)
  );
}

/** The model ask for the row, following the download once the person taps Get. */
function modelAskOf(
  need: ModelNeeded,
  row: ModelView | null,
  busy: boolean,
): ModelAsk {
  const { working, downloading, failure } = modelActivity(row, busy);
  const size = need.size || row?.size || "";
  const what = whatIs(need);
  if (working) {
    const known =
      downloading && downloading.total
        ? downloading.bytes / downloading.total
        : undefined;
    return { phase: "downloading", size, what, progress: known };
  }
  if (failure) {
    return { phase: "failed", size, what, failure: failure.plain };
  }
  return { phase: "ask", size, what };
}

type PrepareRunInput = {
  projectPath: string;
  workingSet: PipelineWorkingSet;
  /** Sources that still have no transcript. */
  untranscribed: number;
  /** Changes when a track gains audio or is replaced. */
  mediaKey: string;
  ingestBusy: boolean;
  canRun: boolean;
  /** Names for a track id, for the keep-fixes line. */
  nameOf: (trackId: string) => string;
};

type KeepFixes = {
  mode: Exclude<RunMode, "run">;
  names: string[];
};

/**
 * Runs the pipeline for Prepare. Import starts it by itself once the files
 * are in; a missing model never downloads on its own, it shows the Get row and
 * the run continues after the download. Re-transcribe and Re-time words ask on
 * the row before they would replace hand fixes.
 */
export function usePrepareRun(input: PrepareRunInput) {
  const { ingestBusy, canRun, mediaKey } = input;
  const { models, busy: slotTaken, download } = useModels();
  const [starting, setStarting] = useState(false);
  const [need, setNeed] = useState<ModelNeeded | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [keepFixes, setKeepFixes] = useState<KeepFixes | null>(null);
  const [wantRetime, setWantRetime] = useState(false);
  const latest = useRef(input);
  latest.current = input;
  const startingRef = useRef(false);
  /** Mirrors `waiting`, so a second refusal says so instead of doing nothing. */
  const waitingRef = useRef(false);
  /** The request a missing model stopped, replayed once the model is in. */
  const refusedRef = useRef<{
    mode: RunMode;
    overwriteEdited: boolean;
    fromStep?: string;
  } | null>(null);
  /** Set once the model was seen missing after the ask, so a stale row never loops the run. */
  const sawMissing = useRef(false);

  /**
   * The slot is taken, so nothing started. A plain run waits and goes on when
   * the slot frees (the row shows it); other modes say so, so none is silent.
   */
  const busyRefused = useCallback((mode: RunMode) => {
    if (mode === "run" && !waitingRef.current) {
      waitingRef.current = true;
      setWaiting(true);
      return;
    }
    useDawStore
      .getState()
      .announceStatus(
        mode === "run"
          ? "Another job is running. Transcribing starts when it finishes."
          : "Another job is running. Try again when it finishes.",
        { tone: "error" },
      );
  }, []);

  const start = useCallback(
    async (mode: RunMode, overwriteEdited = false, fromStep?: string) => {
      if (startingRef.current) return;
      const store = useDawStore.getState();
      if (
        isPipelineSlotBusy(store.pipelineJob) ||
        isPipelineSlotBusy(store.activityJob)
      ) {
        busyRefused(mode);
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
        try {
          job = await startPipelineRun(
            latest.current.projectPath,
            runOptions(cfg, mode, overwriteEdited, fromStep),
          );
        } catch (error) {
          if (isModelNeeded(error)) {
            refusedRef.current = { mode, overwriteEdited, fromStep };
            setNeed(error.model);
            return;
          }
          throw error;
        }
        setNeed(null);
        refusedRef.current = null;
        waitingRef.current = false;
        setWaiting(false);
        if (useDawStore.getState().projectPath === latest.current.projectPath) {
          useDawStore.getState().setPipelineJob(job);
        }
      } catch (error) {
        const code = (error as { code?: string | null }).code;
        if (code === BUSY_CODE) {
          busyRefused(mode);
        } else {
          waitingRef.current = false;
          setWaiting(false);
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
    [busyRefused],
  );

  // Import is done when the busy flag drops with different audio on the
  // tracks than when it rose.
  const wasBusy = useRef(ingestBusy);
  const keyAtStart = useRef(mediaKey);
  useEffect(() => {
    if (ingestBusy && !wasBusy.current) keyAtStart.current = mediaKey;
    if (!ingestBusy && wasBusy.current) {
      if (canRun && mediaKey && mediaKey !== keyAtStart.current) {
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
    if (waiting && !slotBusy && canRun) void start("run");
  }, [waiting, slotBusy, canRun, start]);

  // A failed start is old news once any job holds the slot.
  useEffect(() => {
    if (slotBusy) setStartError(null);
  }, [slotBusy]);

  // A run that stopped for a model goes on by itself once that model is in.
  const row = need ? (models?.find((m) => m.id === need.id) ?? null) : null;
  const here = need !== null && installed(row, need);
  if (need && !here) sawMissing.current = true;
  const arrived = here && sawMissing.current;
  useEffect(() => {
    if (!arrived) return;
    sawMissing.current = false;
    setNeed(null);
    const refused = refusedRef.current;
    refusedRef.current = null;
    void start(
      refused?.mode ?? "run",
      refused?.overwriteEdited ?? false,
      refused?.fromStep,
    );
  }, [arrived, start]);

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

  const alignerRow = models?.find((m) => m.id === WORD_ALIGNER) ?? null;
  const alignerIn = alignerRow?.state.kind === "installed";
  useEffect(() => {
    if (!wantRetime || !alignerIn) return;
    setWantRetime(false);
    void askToReplace("retime");
  }, [wantRetime, alignerIn, askToReplace]);

  const ask = need ? modelAskOf(need, row, slotTaken) : null;
  const approximate =
    alignerRow && !alignerIn
      ? {
          size: alignerRow.size,
          downloading:
            modelActivity(alignerRow, slotTaken).working || wantRetime,
        }
      : null;

  return {
    starting,
    waiting,
    startError,
    model: ask,
    keepFixes,
    /** Word timing is missing; null when the model is in or unknown. */
    approximateTiming: approximate,
    run: start,
    tryAgain: () => (refusal ? void askToReplace("update") : void start("run")),
    retranscribe: () => void askToReplace("retranscribe"),
    keepMyFixes: () => setKeepFixes(null),
    replaceFixes: () => {
      const pending = keepFixes;
      setKeepFixes(null);
      if (pending) void start(pending.mode, true);
    },
    getModel: () => {
      if (!need) return;
      void download(
        [need.id],
        need.variant ? { whisperModel: need.variant } : undefined,
      );
    },
    getAligner: () => {
      setWantRetime(true);
      void download([WORD_ALIGNER]).then((outcome) => {
        if (outcome.kind !== "ok") setWantRetime(false);
      });
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
