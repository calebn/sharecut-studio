import {
  cancelPipelineRun,
  loadTranscriptVocabulary,
  startPipelineRun,
} from "../../api";
import type { PipelineWorkingSet } from "../../hooks/usePipelineWorkingSet";
import type { ModelView, useModels } from "../../models";
import { useDawStore } from "../../state/dawStore";
import {
  currentMediaKey,
  recordJobMedia,
  runIncludesTranscribe,
} from "../../state/jobMedia";
import type { PipelineConfigResponse } from "../../types/pipeline";
import {
  errorMessage,
  isModelNeeded,
  type ModelNeeded,
} from "../../utils/apiError";
import { takeAutoRun } from "../../utils/openIntent";
import { isPipelineSlotBusy } from "../../utils/pipeline";
import { OVERWRITE_REFUSED, oneRunSkipSteps } from "./prepareMappers";
import type { ReadyRowId } from "./ReadyList";

const TRANSCRIBE_STEP = "transcribe_tracks";
const WHISPER = "whisper";
const WORD_ALIGNER = "word-aligner";
const BUSY_CODE = "pipeline_busy";

type RunMode = "run" | "retranscribe" | "retime" | "changed-audio";

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

export type PrepareRunInput = {
  projectPath: string;
  workingSet: PipelineWorkingSet;
  untranscribed: number;
  transcribed: number;
  mediaKey: string;
  ingestBusy: boolean;
  canRun: boolean;
  nameOf: (trackId: string) => string;
};
export type PrepareFrame = {
  input: PrepareRunInput;
  epoch: number;
  models: ReturnType<typeof useModels>;
};
type Owner = Readonly<{ path: string; epoch: number }>;
type Intent = {
  mode: RunMode;
  overwriteEdited: boolean;
  fromStep?: string;
  skipped?: ReadonlySet<ReadyRowId>;
};
type Request = { owner: Owner; intent: Intent };
type Attempt = { request: Request };
type Waiting = { request: Request; freeAttempted: boolean };
type Refusal = { request: Request; need: ModelNeeded; sawMissing: boolean };
type Failure = { request: Request; message: string };
type Probe = { owner: Owner };
type Question = { owner: Owner; data: KeepFixes };
type Aligner = { owner: Owner };
export type KeepFixes = { mode: Exclude<RunMode, "run">; names: string[] };
export type PrepareSnapshot = Readonly<{
  owner: Owner | null;
  starting: boolean;
  waiting: boolean;
  startError: string | null;
  need: ModelNeeded | null;
  keepFixes: KeepFixes | null;
  wantRetime: boolean;
}>;
export type PrepareAction =
  | {
      kind: "run";
      mode: RunMode;
      overwriteEdited?: boolean;
      fromStep?: string;
      skipped?: ReadonlySet<ReadyRowId>;
    }
  | { kind: "try-again" }
  | { kind: "retranscribe" }
  | { kind: "keep" }
  | { kind: "replace" }
  | { kind: "get-model" }
  | { kind: "get-aligner" }
  | { kind: "cancel" };

function sameOwner(a: Owner | null, b: Owner): boolean {
  return a?.path === b.path && a.epoch === b.epoch;
}
function installed(row: ModelView | null, need: ModelNeeded): boolean {
  return (
    row?.state.kind === "installed" &&
    (need.id !== WHISPER || !need.variant || row.variant === need.variant)
  );
}
function slotBusy(store = useDawStore.getState()): boolean {
  return (
    isPipelineSlotBusy(store.pipelineJob) ||
    isPipelineSlotBusy(store.activityJob)
  );
}
function overwriteRefusal(store = useDawStore.getState()): string | null {
  const job = store.pipelineJob;
  return job?.status === "error" && job.error_code === OVERWRITE_REFUSED
    ? job.id
    : null;
}

export class PrepareExecution {
  private frame: PrepareFrame | null = null;
  private owner: Owner | null = null;
  private activeStart: Attempt | null = null;
  private waiting: Waiting | null = null;
  private refusal: Refusal | null = null;
  private failure: Failure | null = null;
  private probe: Probe | null = null;
  private question: Question | null = null;
  private aligner: Aligner | null = null;
  private ingest: { busy: boolean; key: string } | null = null;
  private askedFor: string | null = null;
  private homeBasis: {
    owner: Owner;
    canRun: boolean;
    mediaKey: string;
    ingestBusy: boolean;
  } | null = null;
  private attached = false;
  private reconciling = false;
  private busyObserved: boolean | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PrepareSnapshot = {
    owner: null,
    starting: false,
    waiting: false,
    startError: null,
    need: null,
    keepFixes: null,
    wantRetime: false,
  };

  getSnapshot = (): PrepareSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  attach = (): (() => void) => {
    this.attached = true;
    const unsubscribe = useDawStore.subscribe((current, previous) => {
      if (
        current.projectPath !== previous.projectPath ||
        current.projectEpoch !== previous.projectEpoch ||
        slotBusy(current) !== slotBusy(previous) ||
        overwriteRefusal(current) !== overwriteRefusal(previous)
      ) {
        this.reconcile();
      }
    });
    this.reconcile();
    return () => {
      this.attached = false;
      unsubscribe();
    };
  };
  private install(frame: PrepareFrame): void {
    this.frame = frame;
    const owner = { path: frame.input.projectPath, epoch: frame.epoch };
    if (!sameOwner(this.owner, owner)) {
      this.owner = owner;
      this.waiting = null;
      this.refusal = null;
      this.failure = null;
      this.probe = null;
      this.question = null;
      this.aligner = null;
      this.ingest = { busy: frame.input.ingestBusy, key: frame.input.mediaKey };
      this.askedFor = overwriteRefusal();
      this.homeBasis = null;
    }
  }
  observe = (frame: PrepareFrame): void => {
    this.install(frame);
    this.reconcile();
    this.publish();
  };

  private current(owner: Owner): boolean {
    const store = useDawStore.getState();
    return (
      store.projectPath === owner.path && store.projectEpoch === owner.epoch
    );
  }
  private publish(): void {
    const next: PrepareSnapshot = {
      owner: this.owner,
      starting: this.activeStart !== null,
      waiting: this.waiting !== null,
      startError: this.failure?.message ?? null,
      need: this.refusal?.need ?? null,
      keepFixes: this.question?.data ?? null,
      wantRetime: this.aligner !== null,
    };
    const previous = this.snapshot;
    if (
      previous.owner === next.owner &&
      previous.starting === next.starting &&
      previous.waiting === next.waiting &&
      previous.startError === next.startError &&
      previous.need === next.need &&
      previous.keepFixes === next.keepFixes &&
      previous.wantRetime === next.wantRetime
    )
      return;
    this.snapshot = next;
    if (this.attached) for (const listener of this.listeners) listener();
  }
  private request(frame: PrepareFrame, intent: Intent): Request {
    return {
      owner: { path: frame.input.projectPath, epoch: frame.epoch },
      intent: {
        ...intent,
        skipped: intent.skipped ? new Set(intent.skipped) : undefined,
      },
    };
  }
  private busyRefused(request: Request): void {
    if (request.intent.mode === "run" && this.waiting === null) {
      this.waiting = { request, freeAttempted: false };
      this.publish();
      return;
    }
    useDawStore
      .getState()
      .announceStatus(
        request.intent.mode === "run"
          ? "Another job is running. Processing starts when it finishes."
          : "Another job is running. Try again when it finishes.",
        { tone: "error" },
      );
  }

  private async start(frame: PrepareFrame, intent: Intent): Promise<void> {
    const request = this.request(frame, intent);
    if (!this.attached || !this.current(request.owner) || this.activeStart)
      return;
    if (slotBusy()) {
      this.busyRefused(request);
      return;
    }
    const attempt = { request };
    const workingSet = frame.input.workingSet;
    const warm = workingSet.cfg;
    this.activeStart = attempt;
    this.failure = null;
    this.publish();
    try {
      const cfg = warm ?? (await workingSet.fetchFresh());
      if (!this.attached || !this.current(request.owner)) return;
      if (!cfg) throw new Error("Could not read the pipeline settings.");
      const key = currentMediaKey();
      const options = runOptions(
        cfg,
        intent.mode,
        intent.overwriteEdited,
        intent.fromStep,
        request.intent.skipped,
      );
      const storeAtSubmission = useDawStore.getState();
      const knownPipeline = storeAtSubmission.pipelineJob?.id;
      const job = await startPipelineRun(request.owner.path, options);
      if (runIncludesTranscribe({ fromStep: options.fromStep }))
        recordJobMedia(job.id, key);
      if (this.current(request.owner) && this.activeStart === attempt) {
        this.refusal = null;
        this.failure = null;
        this.waiting = null;
      }
      const knownNow = useDawStore.getState().pipelineJob?.id;
      if (knownNow === knownPipeline || knownNow === job.id || knownNow == null)
        useDawStore.getState().setPipelineJob(job);
    } catch (error) {
      if (
        !this.attached ||
        !this.current(request.owner) ||
        this.activeStart !== attempt
      )
        return;
      if (isModelNeeded(error)) {
        const row =
          this.frame?.models.models?.find(
            (model) => model.id === error.model.id,
          ) ?? null;
        this.refusal = {
          request,
          need: error.model,
          sawMissing: !installed(row, error.model),
        };
      } else if ((error as { code?: string | null }).code === BUSY_CODE) {
        this.busyRefused(request);
      } else {
        this.waiting = null;
        this.failure = { request, message: errorMessage(error) };
        useDawStore
          .getState()
          .announceStatus(`Could not start: ${errorMessage(error)}`, {
            tone: "error",
          });
      }
    } finally {
      if (this.activeStart === attempt) this.activeStart = null;
      this.publish();
    }
  }

  private reconcile(): void {
    const frame = this.frame;
    const owner = this.owner;
    if (
      !this.attached ||
      !frame ||
      !owner ||
      !this.current(owner) ||
      this.reconciling
    )
      return;
    this.reconciling = true;
    try {
      const input = frame.input;
      const before = this.ingest;
      this.ingest = {
        busy: input.ingestBusy,
        key: input.ingestBusy && before?.busy ? before.key : input.mediaKey,
      };
      if (
        !input.ingestBusy &&
        before?.busy &&
        input.canRun &&
        input.mediaKey &&
        input.mediaKey !== before.key &&
        !(input.transcribed > 0 && input.untranscribed > 0)
      )
        void this.start(frame, { mode: "run", overwriteEdited: false });
      const busy = slotBusy();
      if (busy && this.busyObserved !== true) this.failure = null;
      this.busyObserved = busy;
      if (busy) {
        if (this.waiting) this.waiting.freeAttempted = false;
      } else if (
        this.waiting &&
        !this.waiting.freeAttempted &&
        input.canRun &&
        !this.activeStart
      ) {
        this.waiting.freeAttempted = true;
        void this.start(frame, this.waiting.request.intent);
      }
      const home = this.homeBasis;
      if (
        !home ||
        !sameOwner(home.owner, owner) ||
        home.canRun !== input.canRun ||
        home.mediaKey !== input.mediaKey ||
        home.ingestBusy !== input.ingestBusy
      ) {
        this.homeBasis = {
          owner,
          canRun: input.canRun,
          mediaKey: input.mediaKey,
          ingestBusy: input.ingestBusy,
        };
        if (
          input.canRun &&
          input.mediaKey &&
          !input.ingestBusy &&
          takeAutoRun(input.projectPath)
        ) {
          void this.start(frame, { mode: "run", overwriteEdited: false });
        }
      }
      const refused = this.refusal;
      if (refused) {
        const row =
          frame.models.models?.find((model) => model.id === refused.need.id) ??
          null;
        const here = installed(row, refused.need);
        if (!here) refused.sawMissing = true;
        if (here && refused.sawMissing && !this.activeStart) {
          this.refusal = null;
          void this.start(frame, refused.request.intent);
        }
      }
      const refusal = overwriteRefusal();
      if (refusal && this.askedFor !== refusal) {
        this.askedFor = refusal;
        void this.askToReplace(frame, "changed-audio");
      }
      if (
        this.aligner &&
        frame.models.models?.some(
          (model) =>
            model.id === WORD_ALIGNER && model.state.kind === "installed",
        )
      ) {
        this.aligner = null;
        void this.askToReplace(frame, "retime");
      }
      this.publish();
    } finally {
      this.reconciling = false;
    }
  }

  private async askToReplace(
    frame: PrepareFrame,
    mode: Exclude<RunMode, "run">,
  ): Promise<void> {
    const owner = { path: frame.input.projectPath, epoch: frame.epoch };
    if (!this.attached || !this.current(owner)) return;
    const probe = { owner };
    this.probe = probe;
    const nameOf = frame.input.nameOf;
    try {
      const edited =
        (await loadTranscriptVocabulary(owner.path)).edited_tracks ?? [];
      if (!this.attached || !this.current(owner) || this.probe !== probe)
        return;
      if (edited.length === 0) {
        if (mode === "changed-audio")
          useDawStore
            .getState()
            .announceStatus("Could not tell which tracks have hand fixes.", {
              tone: "error",
            });
        else if (this.frame)
          await this.start(this.frame, { mode, overwriteEdited: false });
        return;
      }
      this.question = { owner, data: { mode, names: edited.map(nameOf) } };
      this.publish();
    } catch (error) {
      if (this.attached && this.current(owner) && this.probe === probe)
        useDawStore
          .getState()
          .announceStatus(errorMessage(error), { tone: "error" });
    }
  }

  dispatch = async (
    frame: PrepareFrame,
    action: PrepareAction,
  ): Promise<void> => {
    const owner = { path: frame.input.projectPath, epoch: frame.epoch };
    if (!this.attached || !this.current(owner)) return;
    this.install(frame);
    switch (action.kind) {
      case "run":
        return this.start(frame, {
          mode: action.mode,
          overwriteEdited: action.overwriteEdited ?? false,
          fromStep: action.fromStep,
          skipped: action.skipped,
        });
      case "try-again":
        if (overwriteRefusal())
          return this.askToReplace(frame, "changed-audio");
        return this.start(
          frame,
          this.failure?.request.intent ?? {
            mode: "run",
            overwriteEdited: false,
          },
        );
      case "retranscribe":
        return this.askToReplace(frame, "retranscribe");
      case "keep":
        this.question = null;
        this.publish();
        return;
      case "replace": {
        const question = this.question;
        this.question = null;
        this.publish();
        if (question && sameOwner(question.owner, owner))
          return this.start(frame, {
            mode: question.data.mode,
            overwriteEdited: true,
          });
        return;
      }
      case "get-model": {
        const need = this.refusal?.need;
        if (need)
          await frame.models.download(
            [need.id],
            need.variant ? { whisperModel: need.variant } : undefined,
          );
        return;
      }
      case "get-aligner": {
        const intent = { owner };
        this.aligner = intent;
        this.publish();
        const outcome = await frame.models.download([WORD_ALIGNER]);
        if (outcome.kind !== "ok" && this.aligner === intent) {
          this.aligner = null;
          this.publish();
        }
        return;
      }
      case "cancel": {
        const store = useDawStore.getState();
        const job = store.activityJob ?? store.pipelineJob;
        try {
          const done = await cancelPipelineRun(job?.id);
          const live = useDawStore.getState();
          if ((live.activityJob ?? live.pipelineJob)?.id === job?.id) {
            live.setPipelineJob(done.kind === "pipeline" ? done : null);
            live.setActivityJob(done);
          }
        } catch (error) {
          if (this.current(owner))
            useDawStore
              .getState()
              .announceStatus(errorMessage(error), { tone: "error" });
        }
      }
    }
  };
}
