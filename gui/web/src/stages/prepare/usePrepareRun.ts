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
import { takeAutoRun } from "../../utils/openIntent";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import type { ModelAsk } from "./prepareMappers";

const TRANSCRIBE_STEP = "transcribe_tracks";
const WHISPER = "whisper";
const WORD_ALIGNER = "word-aligner";
const BUSY_CODE = "pipeline_busy";

export type RunMode = "run" | "retranscribe" | "retime";

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
export function modelAskOf(
  need: ModelNeeded | null,
  row: ModelView | null,
  busy: boolean,
): ModelAsk | null {
  if (!need) return null;
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

export type PrepareRunInput = {
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

export type KeepFixes = {
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
  /** A run was refused because another job holds the pipeline slot. */
  const [waiting, setWaiting] = useState(false);
  const [keepFixes, setKeepFixes] = useState<KeepFixes | null>(null);
  const [wantRetime, setWantRetime] = useState(false);
  const latest = useRef(input);
  latest.current = input;
  const startingRef = useRef(false);
  /** Set once the model was seen missing after the ask, so a stale row never loops the run. */
  const sawMissing = useRef(false);

  /**
   * The slot is taken, so nothing started. A plain run waits and goes on when
   * the slot frees (the row shows it); other modes say so, so none is silent.
   */
  const busyRefused = useCallback((mode: RunMode) => {
    if (mode === "run") {
      setWaiting(true);
      return;
    }
    useDawStore
      .getState()
      .announceStatus("Another job is running. Try again when it finishes.", {
        tone: "error",
      });
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
            setNeed(error.model);
            return;
          }
          throw error;
        }
        setNeed(null);
        setWaiting(false);
        if (useDawStore.getState().projectPath === latest.current.projectPath) {
          useDawStore.getState().setPipelineJob(job);
        }
      } catch (error) {
        const code = (error as { code?: string | null }).code;
        if (code === BUSY_CODE) {
          busyRefused(mode);
        } else {
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

  // Audio that Home imported into this new episode starts processing on open,
  // once, the same as an import made here.
  useEffect(() => {
    if (!canRun || !mediaKey || ingestBusy) return;
    if (takeAutoRun(latest.current.projectPath)) void start("run");
  }, [canRun, mediaKey, ingestBusy, start]);

  // A run that stopped for a model goes on by itself once that model is in.
  const row = need ? (models?.find((m) => m.id === need.id) ?? null) : null;
  const here = need !== null && installed(row, need);
  if (need && !here) sawMissing.current = true;
  const arrived = here && sawMissing.current;
  useEffect(() => {
    if (!arrived) return;
    sawMissing.current = false;
    setNeed(null);
    void start("run");
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
        await start(mode, false);
        return;
      }
      setKeepFixes({ mode, names: edited.map(nameOf) });
    },
    [start],
  );

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
    model: ask,
    keepFixes,
    /** Word timing is missing; null when the model is in or unknown. */
    approximateTiming: approximate,
    run: start,
    tryAgain: () => void start("run"),
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
