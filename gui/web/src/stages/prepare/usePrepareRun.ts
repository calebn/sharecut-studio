import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPipelineRun,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import { useLatestRequest } from "../../hooks/useLatestRequest";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import {
  type DownloadOutcome,
  type NeedTarget,
  rowInstalled,
  useModelResume,
  useModels,
  WORD_ALIGNER,
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
import type { LanguageStatus } from "./useLanguageStatus";
import { languageName } from "./whisperLanguages";

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
  languageStatus?: LanguageStatus | null;
};

type RunRequest = {
  projectPath: string;
  projectEpoch: number;
  mode: RunMode;
  options: ReturnType<typeof runOptions>;
  consent: {
    edited: string[];
    mediaKey: ReturnType<typeof currentMediaKey>;
  } | null;
};

function retainRun(request: RunRequest): RunRequest {
  return { ...request, options: { ...request.options, useWorkingSet: false } };
}

function ownsRequest(
  request: Pick<RunRequest, "projectPath" | "projectEpoch">,
) {
  const store = useDawStore.getState();
  return (
    store.projectPath === request.projectPath &&
    store.projectEpoch === request.projectEpoch
  );
}

type KeepFixes = {
  mode: Exclude<RunMode, "run">;
  names: string[];
};

function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function keptFixesMessage(
  keep: KeepFixes,
  status: LanguageStatus | null,
): string {
  const kept = `Kept the hand fixes on ${nameList(keep.names)}.`;
  const nothing =
    keep.mode === "retranscribe"
      ? "Nothing was re-transcribed."
      : "No run started, so nothing was re-transcribed.";
  const language =
    status?.language && status.edited.length > 0
      ? ` Language stays set to ${languageName(status.language)}.`
      : "";
  return `${kept} ${nothing}${language}`;
}

/**
 * Runs the pipeline for Prepare. An initial import starts it once the files
 * are in. Audio added beside transcribed tracks waits for Process new audio.
 * A missing model shows Get and the run continues after its download.
 * Re-transcribe and Re-time words ask before replacing hand fixes.
 */
export function usePrepareRun(input: PrepareRunInput) {
  const { ingestBusy, canRun, mediaKey } = input;
  const { models } = useModels();
  const [starting, setStarting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [keepFixes, setKeepFixes] = useState<KeepFixes | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const activeStart = useRef<RunRequest | null>(null);
  const captureReads = useLatestRequest();
  /** Mirrors `waiting`, so a second refusal says so instead of doing nothing. */
  const waitingRef = useRef(false);
  const waitingRequest = useRef<RunRequest | null>(null);
  const confirmation = useRef<RunRequest | null>(null);
  /** The request a missing model stopped, replayed once the model is in. */
  const refusedRef = useRef<RunRequest | null>(null);
  /** The request that failed to start, replayed by Try again. */
  const failedRef = useRef<RunRequest | null>(null);
  /** The model the stopped run already waited for once, so a second refusal says so instead of looping. */
  const retried = useRef<string | null>(null);
  const replay = useRef<(model: NeedTarget) => void>(() => undefined);
  const {
    stop: need,
    stopFor,
    clear,
  } = useModelResume((model) => replay.current(model));

  /**
   * The slot is taken, so nothing started. A plain run waits and goes on when
   * the slot frees (the row shows it); other modes say so, so none is silent.
   */
  const busyRefused = useCallback((request: RunRequest) => {
    const { mode } = request;
    if (mode === "run" && !waitingRef.current) {
      waitingRef.current = true;
      waitingRequest.current = retainRun(request);
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
  }, []);

  const capture = useCallback(
    async (
      mode: RunMode,
      overwriteEdited = false,
      fromStep?: string,
      skipped?: ReadonlySet<ReadyRowId>,
    ): Promise<RunRequest | null> => {
      const { projectPath, workingSet } = latest.current;
      const { projectEpoch } = useDawStore.getState();
      const scope = { projectPath, projectEpoch };
      const token = captureReads.begin();
      const isCurrent = () =>
        captureReads.isCurrent(token) && ownsRequest(scope);
      const selection = skipped ? new Set(skipped) : undefined;
      try {
        const cfg = workingSet.cfg
          ? structuredClone(workingSet.cfg)
          : await workingSet.fetchFresh();
        if (!isCurrent()) return null;
        if (!cfg) throw new Error("Could not read the pipeline settings.");
        return {
          ...scope,
          mode,
          options: structuredClone(
            runOptions(cfg, mode, overwriteEdited, fromStep, selection),
          ),
          consent: null,
        };
      } catch (error) {
        if (!isCurrent()) return null;
        throw error;
      }
    },
    [captureReads],
  );

  const offerReplace = useCallback((request: RunRequest, edited: string[]) => {
    if (request.mode === "run" || !ownsRequest(request)) return;
    confirmation.current = {
      ...request,
      options: { ...request.options, overwriteEdited: true },
      consent: { edited: [...edited].sort(), mediaKey: currentMediaKey() },
    };
    setKeepFixes({
      mode: request.mode,
      names: edited.map(latest.current.nameOf),
    });
  }, []);

  const execute = useCallback(
    async (request: RunRequest) => {
      if (activeStart.current || !ownsRequest(request)) return;
      const store = useDawStore.getState();
      if (
        isPipelineSlotBusy(store.pipelineJob) ||
        isPipelineSlotBusy(store.activityJob)
      ) {
        busyRefused(request);
        return;
      }
      const operation = request;
      activeStart.current = operation;
      const isCurrent = () =>
        activeStart.current === operation && ownsRequest(operation);
      setStarting(true);
      setStartError(null);
      try {
        if (request.options.overwriteEdited) {
          const vocabulary = await loadTranscriptVocabulary(
            request.projectPath,
          );
          if (!isCurrent()) return;
          if (!vocabulary.edited_tracks) {
            throw new Error("Could not tell which tracks have hand fixes.");
          }
          const edited = [...vocabulary.edited_tracks].sort();
          const mediaKey = currentMediaKey();
          if (
            (request.consent === null && edited.length > 0) ||
            (request.consent &&
              (request.consent.mediaKey !== mediaKey ||
                JSON.stringify(request.consent.edited) !==
                  JSON.stringify(edited)))
          ) {
            offerReplace(request, vocabulary.edited_tracks);
            return;
          }
          request = { ...request, consent: { edited, mediaKey } };
        }
        let job: PipelineJobSnapshot;
        const keyAtRequest = currentMediaKey();
        const { options } = request;
        try {
          job = await startPipelineRun(request.projectPath, options);
        } catch (error) {
          if (!isCurrent()) return;
          if (
            isModelNeeded(error) &&
            retried.current !== modelKey(error.model)
          ) {
            refusedRef.current = { ...retainRun(request), consent: null };
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
        if (!isCurrent()) return;
        retried.current = null;
        refusedRef.current = null;
        failedRef.current = null;
        waitingRef.current = false;
        waitingRequest.current = null;
        setWaiting(false);
        useDawStore.getState().setPipelineJob(job);
      } catch (error) {
        if (!isCurrent()) return;
        const code = (error as { code?: string | null }).code;
        if (code === BUSY_CODE) {
          busyRefused(request);
        } else {
          waitingRef.current = false;
          setWaiting(false);
          failedRef.current = retainRun(request);
          setStartError(errorMessage(error));
          useDawStore
            .getState()
            .announceStatus(`Could not start: ${errorMessage(error)}`, {
              tone: "error",
            });
        }
      } finally {
        if (activeStart.current === operation) {
          activeStart.current = null;
          setStarting(false);
        }
      }
    },
    [busyRefused, offerReplace, stopFor],
  );

  const start = useCallback(
    async (
      mode: RunMode,
      overwriteEdited = false,
      fromStep?: string,
      skipped?: ReadonlySet<ReadyRowId>,
    ) => {
      const scope = {
        projectPath: latest.current.projectPath,
        projectEpoch: useDawStore.getState().projectEpoch,
      };
      try {
        const request = await capture(mode, overwriteEdited, fromStep, skipped);
        if (request) await execute(request);
      } catch (error) {
        if (ownsRequest(scope)) setStartError(errorMessage(error));
      }
    },
    [capture, execute],
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
    if (waiting && !slotBusy && canRun && waitingRequest.current) {
      void execute(waitingRequest.current);
    }
  }, [waiting, slotBusy, canRun, execute]);

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
    if (!refused || !ownsRequest(refused)) return;
    retried.current = modelKey(model);
    void execute(refused);
  };

  const confirmRequest = useCallback(
    async (request: RunRequest, isCurrent: () => boolean) => {
      if (request.mode === "run" || !isCurrent()) return;
      try {
        const edited =
          (await loadTranscriptVocabulary(request.projectPath)).edited_tracks ??
          [];
        if (!isCurrent()) return;
        if (edited.length === 0) {
          if (request.mode === "update") {
            useDawStore
              .getState()
              .announceStatus("Could not tell which tracks have hand fixes.", {
                tone: "error",
              });
            return;
          }
          await execute(request);
          return;
        }
        offerReplace(request, edited);
      } catch (error) {
        if (!isCurrent()) return;
        useDawStore.getState().announceStatus(errorMessage(error), {
          tone: "error",
        });
      }
    },
    [execute, offerReplace],
  );

  const askToReplace = useCallback(
    async (mode: Exclude<RunMode, "run">) => {
      const scope = {
        projectPath: latest.current.projectPath,
        projectEpoch: useDawStore.getState().projectEpoch,
      };
      try {
        const request = await capture(mode);
        if (request) await confirmRequest(request, () => ownsRequest(request));
      } catch (error) {
        if (ownsRequest(scope)) {
          useDawStore
            .getState()
            .announceStatus(errorMessage(error), { tone: "error" });
        }
      }
    },
    [capture, confirmRequest],
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
  const alignerIn = rowInstalled(alignerRow, {
    id: WORD_ALIGNER,
    variant: null,
  });
  const retimeIntent = useRef<Pick<
    RunRequest,
    "projectPath" | "projectEpoch"
  > | null>(null);
  const { clear: clearRetime, stopFor: stopForRetime } = useModelResume<
    NeedTarget & {
      request: RunRequest;
      intent: Pick<RunRequest, "projectPath" | "projectEpoch">;
    }
  >(({ request, intent }) => {
    if (retimeIntent.current !== intent || !ownsRequest(request)) return;
    void confirmRequest(
      request,
      () => retimeIntent.current === intent && ownsRequest(request),
    ).finally(() => {
      if (retimeIntent.current === intent) retimeIntent.current = null;
    });
  });
  const approximate = alignerRow && !alignerIn ? alignerRow : null;

  const projectEpoch = useDawStore((s) => s.projectEpoch);
  useEffect(() => {
    activeStart.current = null;
    setStarting(false);
    refusedRef.current = null;
    failedRef.current = null;
    waitingRequest.current = null;
    confirmation.current = null;
    retried.current = null;
    waitingRef.current = false;
    setWaiting(false);
    setKeepFixes(null);
    setStartError(null);
    clear();
    retimeIntent.current = null;
    clearRetime();
    return () => {
      activeStart.current = null;
      retimeIntent.current = null;
    };
  }, [input.projectPath, projectEpoch, clear, clearRetime]);

  return {
    starting,
    waiting,
    startError,
    model: need,
    keepFixes,
    /** Word timing is missing; null when the model is in or unknown. */
    approximateTiming: approximate,
    awaitAligner: (model: NeedTarget, outcome: Promise<DownloadOutcome>) => {
      const intent = {
        projectPath: latest.current.projectPath,
        projectEpoch: useDawStore.getState().projectEpoch,
      };
      retimeIntent.current = intent;
      clearRetime();
      void Promise.all([capture("retime"), outcome]).then(
        ([request, downloaded]) => {
          if (retimeIntent.current !== intent || !ownsRequest(intent)) return;
          if (!request || downloaded.kind !== "ok") {
            retimeIntent.current = null;
            return;
          }
          stopForRetime({ ...model, request: retainRun(request), intent });
        },
        (error: unknown) => {
          if (retimeIntent.current !== intent || !ownsRequest(intent)) return;
          retimeIntent.current = null;
          useDawStore
            .getState()
            .announceStatus(errorMessage(error), { tone: "error" });
        },
      );
    },
    run: start,
    tryAgain: () => {
      if (refusal) return void askToReplace("update");
      const failed = startError ? failedRef.current : null;
      const request = failed ?? waitingRequest.current;
      if (request) void execute(request);
      else void start("run");
    },
    retranscribe: () => void askToReplace("retranscribe"),
    keepMyFixes: () => {
      confirmation.current = null;
      if (keepFixes) {
        useDawStore
          .getState()
          .announceStatus(
            keptFixesMessage(keepFixes, latest.current.languageStatus ?? null),
          );
      }
      setKeepFixes(null);
    },
    replaceFixes: () => {
      const pending = confirmation.current;
      confirmation.current = null;
      setKeepFixes(null);
      if (pending) void execute(pending);
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
