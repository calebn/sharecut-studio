import type { SourceCardProps } from "../../system/SourceCard";
import type {
  PipelineConfigResponse,
  PipelineJobSnapshot,
  PipelineStepTiming,
} from "../../types/pipeline";
import type { TrackView } from "../../types/project";
import { getByPath, setByPath } from "../../utils/configPath";
import { plainError } from "../../utils/plainError";
import { formatTimeShort } from "../../utils/time";
import type { CleanupSettings } from "./PrepareView";
import type { PreparePhase } from "./prepareAnnouncement";
import type { PrepareSession, PrepareSource } from "./prepareTypes";
import type { ReadyRowData, ReadyRowId } from "./ReadyList";

export const TIGHTEN_INTENSITY_PATH = "tighten.intensity";
const MASTER_LUFS_PATH = "master.integrated_lufs";

/** The row each pipeline step belongs to (spec INT-PREPARE-RUN). */
const ROW_STEPS: Readonly<Record<ReadyRowId, readonly string[]>> = {
  add: ["ingest_tracks"],
  transcribe: ["transcribe_tracks"],
  align: [
    "align_tracks",
    "require_align_accept",
    "merge_transcript",
    "render_dialogue_stems",
    "reconcile_transcript",
    "precorrect_transcript",
  ],
  clean: [
    "fill_gate_holes",
    "clean_audio",
    "compress_tracks",
    "balance_tracks",
    "assemble_timeline",
  ],
  suggest: ["analyze_fillers_pauses", "apply_sound_actions"],
  // Only the plan has this row; a run reports the scan under Find suggestions.
  scan: [],
};

type PlanOperation = {
  step: string;
  label: string;
  enabledPath?: string;
};

const PLAN_OPERATIONS: Readonly<Record<ReadyRowId, readonly PlanOperation[]>> =
  {
    add: [],
    transcribe: [{ step: "transcribe_tracks", label: "Transcribe" }],
    align: [
      { step: "align_tracks", label: "Line up tracks" },
      { step: "require_align_accept", label: "Check alignment" },
    ],
    clean: [
      { step: "fill_gate_holes", label: "Fill gate holes" },
      { step: "clean_audio", label: "Clean" },
      { step: "compress_tracks", label: "Compress" },
      { step: "balance_tracks", label: "Balance" },
    ],
    scan: [
      {
        step: "apply_sound_actions",
        label: "Apply sound actions",
        enabledPath: "tighten.apply_non_speech",
      },
    ],
    suggest: [
      {
        step: "analyze_fillers_pauses",
        label: "Find suggestions",
        enabledPath: "tighten.enabled",
      },
    ],
  };

type PlanSettings = Pick<
  PipelineConfigResponse,
  "step_names" | "enabled_steps" | "config"
>;

function enabledPlanOperations(
  settings: PlanSettings,
  row: ReadyRowId,
): readonly PlanOperation[] {
  return PLAN_OPERATIONS[row].filter(
    (operation) =>
      settings.enabled_steps.includes(operation.step) &&
      (!operation.enabledPath ||
        getByPath(settings.config, operation.enabledPath) === true),
  );
}

/**
 * The steps to pass as `skip_steps` for one run: what the saved settings leave
 * off, plus what the person skipped on a plan row. The server takes an explicit
 * list over the saved one, so the saved switches have to be in it.
 */
export function oneRunSkipSteps(
  cfg: Pick<PipelineConfigResponse, "step_names" | "enabled_steps">,
  skipped: ReadonlySet<ReadyRowId>,
): string[] {
  const rowSteps = new Set(
    [...skipped].flatMap((row) =>
      PLAN_OPERATIONS[row].map((operation) => operation.step),
    ),
  );
  return cfg.step_names.filter(
    (name) => !cfg.enabled_steps.includes(name) || rowSteps.has(name),
  );
}

const ROW_ORDER: readonly ReadyRowId[] = [
  "add",
  "transcribe",
  "align",
  "clean",
  "suggest",
];

const ROW_TITLE: Record<ReadyRowId, string> = {
  add: "Add audio",
  transcribe: "Transcribe",
  align: "Line up tracks",
  clean: "Clean and level",
  scan: "Apply sound actions",
  suggest: "Find suggestions",
};

const ROW_ACTIVITY: Record<ReadyRowId, string> = {
  add: "Adding audio",
  transcribe: "Transcribing",
  align: "Lining up tracks",
  clean: "Cleaning",
  scan: "Applying sound actions",
  suggest: "Finding suggestions",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function sourceTracks(tracks: readonly TrackView[]): TrackView[] {
  return tracks.filter((track) => track.role === "dialogue");
}

export function hasMedia(track: Pick<TrackView, "media_path">): boolean {
  return Boolean(track.media_path);
}

function mediaName(track: TrackView): string {
  const path = track.media_path;
  if (!path) return track.id;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || track.id;
}

export function transcriptIndex(
  utterances: readonly { track_id: string; speaker: string }[] | undefined,
): { transcribed: ReadonlySet<string>; voices: ReadonlyMap<string, number> } {
  const speakers = new Map<string, Set<string>>();
  for (const row of utterances ?? []) {
    const set = speakers.get(row.track_id) ?? new Set<string>();
    set.add(row.speaker);
    speakers.set(row.track_id, set);
  }
  return {
    transcribed: new Set(speakers.keys()),
    voices: new Map([...speakers].map(([id, set]) => [id, set.size])),
  };
}

export type SplitProgress = { detail?: string; progress?: number };

type SessionsInput = {
  tracks: readonly TrackView[];
  transcribed: ReadonlySet<string>;
  voicesIn: ReadonlyMap<string, number>;
  /** A host may split; a review guest may not. */
  mayManage: boolean;
  ingestBusy: boolean;
  playingId: string | null;
  chosenVoices: Readonly<Record<string, number>>;
  splitting: Readonly<Record<string, SplitProgress>>;
  splitFailed: Readonly<Record<string, string>>;
  job: PipelineJobSnapshot | null;
  /** A track the person asked to split ("Split speakers…"); its prompt shows. */
  focusTrackId?: string | null;
  /** Tracks added to a project that already ran, not processed yet. */
  newTrackIds?: ReadonlySet<string>;
};

export const MIN_VOICES = 2;

/** Whether a track offers the split prompt: one file that holds several voices, or the only file. */
function offersSplit(
  track: TrackView,
  input: Pick<SessionsInput, "mayManage" | "voicesIn" | "focusTrackId"> & {
    sources: number;
  },
): boolean {
  if (!input.mayManage || track.speaker_split_id || !hasMedia(track)) {
    return false;
  }
  if (input.focusTrackId === track.id) return true;
  return input.sources === 1 || (input.voicesIn.get(track.id) ?? 0) > 1;
}

function audioTime(track: TrackView): string | undefined {
  const seconds = track.duration_sec;
  return seconds && seconds > 0
    ? `${formatTimeShort(seconds)} of audio`
    : undefined;
}

function sourceState(
  track: TrackView,
  input: SessionsInput,
  splittable: boolean,
): { state: SourceCardProps["state"]; cause?: string } {
  const failure = input.splitFailed[track.id];
  if (failure) return { state: "failed", cause: failure };
  if (input.splitting[track.id]) return { state: "splitting" };
  if (!hasMedia(track)) {
    return input.ingestBusy
      ? { state: "uploading" }
      : { state: "failed", cause: "This track has no audio yet." };
  }
  if (input.ingestBusy && !(track.duration_sec && track.duration_sec > 0)) {
    return { state: "probing" };
  }
  if (splittable) return { state: "split-prompt" };
  if (!track.speaker?.trim()) return { state: "needs-name" };
  return { state: input.newTrackIds?.has(track.id) ? "new" : "ready" };
}

function prepareSource(
  track: TrackView,
  input: SessionsInput,
  sources: number,
): PrepareSource {
  const splittable = offersSplit(track, { ...input, sources });
  const { state, cause } = sourceState(track, input, splittable);
  const split = input.splitting[track.id];
  return {
    id: track.id,
    state,
    name: track.speaker?.trim() ?? "",
    fileName: mediaName(track),
    audioTime: audioTime(track),
    playing: input.playingId === track.id,
    voices: input.chosenVoices[track.id] ?? MIN_VOICES,
    canSplit: splittable,
    splitDetail: split?.detail,
    progress: split?.progress,
    cause,
  };
}

function sessionStatus(
  input: SessionsInput,
  sources: readonly TrackView[],
): Pick<PrepareSession, "status" | "progress"> {
  const job = input.job;
  if (job && (job.status === "running" || job.status === "queued")) {
    return {
      status: "running",
      progress:
        job.total && job.current != null ? job.current / job.total : undefined,
    };
  }
  if (job?.status === "error") return { status: "failed" };
  if (sources.some((t) => input.newTrackIds?.has(t.id))) {
    return { status: "new" };
  }
  const done =
    sources.length > 0 && sources.every((t) => input.transcribed.has(t.id));
  return { status: done ? "done" : "idle" };
}

/**
 * The Sources column. Imports are grouped into one session for now: the
 * project does not say which recording session a track came from, so true
 * sessions wait for the Record flow to leave that on the track.
 */
export function prepareSessions(input: SessionsInput): PrepareSession[] {
  const sources = sourceTracks(input.tracks);
  if (sources.length === 0) return [];
  const names = new Set(
    sources.map((t) => t.speaker?.trim().toLowerCase()).filter(Boolean),
  );
  const longest = Math.max(0, ...sources.map((t) => t.duration_sec ?? 0));
  return [
    {
      id: "session-1",
      title: "Session 1",
      people: Math.max(names.size, 1),
      takes: sources.length,
      duration: formatTimeShort(longest),
      target: "end",
      targetLocked: true,
      ...sessionStatus(input, sources),
      sources: sources.map((track) =>
        prepareSource(track, input, sources.length),
      ),
    },
  ];
}

export type ModelAsk = {
  /** "ask" until the person taps Get; then it follows the download. */
  phase: "ask" | "downloading" | "failed";
  /** "1.6 GB". */
  size: string;
  /** What is missing, in words: "the transcription model". */
  what: string;
  progress?: number;
  failure?: string;
};

export type ReadyInput = {
  sourceCount: number;
  ingestBusy: boolean;
  transcribed: boolean;
  /** The job was seen with the audio on the tracks now, so it covered every source. */
  jobCoversMedia?: boolean;
  /** A run is being started (auto-run waiting on the slot, or the POST in flight). */
  starting: boolean;
  /** A run was refused because another job holds the pipeline slot. */
  waiting?: boolean;
  /** Starting the run failed for a reason other than a busy slot. */
  startError?: string | null;
  job: PipelineJobSnapshot | null;
  pendingSuggestions: number;
  model: ModelAsk | null;
  approximateTiming: { size: string; downloading: boolean } | null;
  /** A re-transcribe waits on whether to keep hand fixes. */
  keepFixes: { names: readonly string[] } | null;
  /**
   * Audio was added to a project that already ran and nothing has started:
   * the rows are the plan. Left out while a run starts, waits, asks for a
   * model or has failed to start.
   */
  plan?: RerunPlan | null;
};

/** What the next run would do when audio was added after a finished run. */
export type RerunPlan = {
  /** Who is new: speaker names, else track labels. */
  newNames: readonly string[];
  /** Tracks that already have their results. */
  kept: number;
  /** Rows the person skipped for this run only. */
  skipped: ReadonlySet<ReadyRowId>;
  settings: PlanSettings | null;
  settingsError?: string | null;
  /** Present while automatic sound actions are on. */
  scan?: { time: string } | null;
};

function joined(names: readonly string[]): string {
  return names.length === 2 ? `${names[0]} and ${names[1]}` : names[0];
}

/** "Priya", "Priya and Joss", "3 new tracks". */
function whoIsNew(names: readonly string[]): string {
  return names.length <= 2 ? joined(names) : `${names.length} new tracks`;
}

/** The line under the plan's title. */
export function planNote(plan: RerunPlan): string {
  if (!plan.settings) {
    return plan.settingsError
      ? "Could not load saved steps. Open Advanced to try again."
      : "Loading saved steps…";
  }
  const { newNames: names, kept } = plan;
  const first =
    names.length === 1
      ? `${names[0]}’s audio is new.`
      : `${names.length === 2 ? joined(names) : `${names.length} tracks`} have new audio.`;
  // Only the transcripts are verified as kept (plan_transcription reuses a
  // stored transcript whose audio is unchanged); the other steps run on all.
  const rest =
    kept === 1
      ? "The other track keeps its transcript."
      : `The other ${kept} tracks keep their transcripts.`;
  return `${first} ${rest}`;
}

function planRows(plan: RerunPlan): ReadyRowData[] {
  const who = whoIsNew(plan.newNames);
  const scope = `${who} only · ${plan.kept} kept`;
  const total = plan.kept + plan.newNames.length;
  const joins = `All ${total} tracks, ${who} ${plan.newNames.length === 1 ? "joins" : "join"}`;
  // Only Transcribe skips tracks that already have results (#2890 covers the
  // rest), so only it says "kept"; the other rows say what runs on all.
  const everyone = `All ${total} tracks`;
  const are = plan.newNames.length === 1 ? "is" : "are";
  const consequence: Partial<Record<ReadyRowId, string>> = {
    transcribe: `Skipped this time. ${who} will have no transcript or suggestions.`,
    align: `Skipped this time. ${who} ${are} not lined up with the others.`,
    clean: `Skipped this time. ${who} ${are} not cleaned or levelled.`,
    scan: "Skipped this time. Sound actions are not applied automatically.",
    suggest: "Skipped this time. Filler and pause analysis is skipped.",
  };
  const row = (id: ReadyRowId, detail: string): ReadyRowData => {
    const settings = plan.settings;
    if (!settings) return { id, state: "queued", title: ROW_TITLE[id] };
    const operations = enabledPlanOperations(settings, id);
    if (operations.length === 0) {
      return {
        id,
        state: "queued",
        title: ROW_TITLE[id],
        detail: "Off in Advanced",
      };
    }
    const partial = operations.length < PLAN_OPERATIONS[id].length;
    const selected = operations
      .map((operation, index) =>
        index === 0 ? operation.label : operation.label.toLowerCase(),
      )
      .join(", ");
    if (plan.skipped.has(id)) {
      return {
        id,
        state: "queued",
        title: ROW_TITLE[id],
        detail: partial
          ? `Skipped this time. ${selected} will not run.`
          : consequence[id],
        action: { label: "Include", run: "include" },
      };
    }
    return {
      id,
      state: "queued",
      title: ROW_TITLE[id],
      detail: partial ? `${everyone} · ${selected}` : detail,
      action: { label: "Skip", run: "skip" },
    };
  };
  return [
    {
      id: "add",
      state: "done",
      title: ROW_TITLE.add,
      detail: `${who} added, ${plural(plan.newNames.length, "file", "files")}`,
    },
    row("transcribe", scope),
    row("align", joins),
    row("clean", everyone),
    ...(plan.scan ? [row("scan", `Whole episode · ${plan.scan.time}`)] : []),
    row("suggest", "Whole episode"),
  ];
}

function reuseFromSteps(
  steps: readonly PipelineStepTiming[],
): string | undefined {
  let reused = 0;
  let recomputed = 0;
  for (const step of steps) {
    if (!step.reuse) continue;
    reused += step.reuse.reused;
    recomputed += step.reuse.recomputed;
  }
  return reused > 0 ? `${recomputed} new · ${reused} reused` : undefined;
}

function reuseDetail(
  job: PipelineJobSnapshot | null,
  row: ReadyRowId,
): string | undefined {
  return reuseFromSteps(
    (job?.steps ?? []).filter((step) => ROW_STEPS[row].includes(step.name)),
  );
}

type RowWork = { operation: PlanOperation; timing: PipelineStepTiming };
type TerminalRowResult =
  | {
      kind: "performed";
      work: readonly [RowWork, ...RowWork[]];
      partial: boolean;
    }
  | { kind: "omitted"; detail: "Skipped this run" | "Not run this time" };

function ownOperations(row: ReadyRowId): readonly PlanOperation[] {
  return row === "suggest"
    ? [...PLAN_OPERATIONS.suggest, ...PLAN_OPERATIONS.scan]
    : PLAN_OPERATIONS[row];
}

function terminalRowResult(
  job: PipelineJobSnapshot | null,
  row: ReadyRowId,
): TerminalRowResult | null {
  if (job?.status !== "ok" || row === "add") return null;
  const operations = ownOperations(row);
  const work = operations.flatMap((operation): RowWork[] => {
    const timing = job.steps.find(
      (step) => step.name === operation.step && step.status === "ok",
    );
    return timing ? [{ operation, timing }] : [];
  });
  const [first, ...rest] = work;
  if (first)
    return {
      kind: "performed",
      work: [first, ...rest],
      partial: work.length < operations.length,
    };
  return {
    kind: "omitted",
    detail: operations.every((operation) =>
      job.skip_steps?.includes(operation.step),
    )
      ? "Skipped this run"
      : "Not run this time",
  };
}

function terminalWorkDetail(
  result: Extract<TerminalRowResult, { kind: "performed" }>,
  fallback: string,
): string {
  if (result.partial) {
    return result.work
      .map(({ operation, timing }) => {
        const detail =
          reuseFromSteps([timing]) ??
          timing.summary ??
          (operation.step === "analyze_fillers_pauses" ? fallback : undefined);
        return detail ? `${operation.label} · ${detail}` : operation.label;
      })
      .join(" · ");
  }
  return (
    reuseFromSteps(result.work.map(({ timing }) => timing)) ??
    (result.work
      .map(({ timing }) => timing.summary)
      .filter(Boolean)
      .join(" · ") ||
      fallback)
  );
}

/** "1 min 12 s", "45 s", "1 h 2 min". */
function spokenDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0)
    return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0)
    return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  return `${rest} s`;
}

/**
 * The one line under the title after a run that reused results: "Done in 1 min
 * 12 s. 9 of 13 results were reused, so this run did less." Only from steps
 * that report reuse, so it never counts what the engine did not say.
 */
export function reuseNote(job: PipelineJobSnapshot | null): string | undefined {
  if (job?.status !== "ok") return undefined;
  let reused = 0;
  let total = 0;
  for (const step of job.steps) {
    if (!step.reuse) continue;
    reused += step.reuse.reused;
    total += step.reuse.reused + step.reuse.recomputed;
  }
  if (reused <= 0 || total <= 0) return undefined;
  return `Done in ${spokenDuration(job.elapsed_sec)}. ${reused} of ${total} results were reused, so this run did less.`;
}

type Outcome = {
  state: "queued" | "running" | "done" | "failed";
  error?: string;
  skipped?: true;
};

function isLive(job: PipelineJobSnapshot | null): boolean {
  return job?.status === "running" || job?.status === "queued";
}

export function rowOutcome(
  job: PipelineJobSnapshot | null,
  row: ReadyRowId,
): Outcome | null {
  if (!job) return null;
  const mine = job.steps.filter((step) => ROW_STEPS[row].includes(step.name));
  const failed = mine.find((step) => step.status === "error");
  if (failed) {
    return {
      state: "failed",
      error: failed.error ?? job.error ?? "This step did not finish.",
    };
  }
  if (mine.some((step) => step.status === "running")) {
    return { state: "running" };
  }
  const terminal = terminalRowResult(job, row);
  if (terminal)
    return { state: terminal.kind === "performed" ? "done" : "queued" };
  const operations = ownOperations(row);
  const reportedOwnWork = job.steps.some(
    (step) =>
      operations.some((operation) => operation.step === step.name) &&
      ["ok", "running", "error"].includes(step.status),
  );
  if (
    isLive(job) &&
    operations.length > 0 &&
    !reportedOwnWork &&
    operations.every((operation) => job.skip_steps?.includes(operation.step))
  ) {
    return { state: "queued", skipped: true };
  }
  const later = ROW_ORDER.slice(ROW_ORDER.indexOf(row) + 1);
  const movedOn = job.steps.some((step) =>
    later.some((id) => ROW_STEPS[id].includes(step.name)),
  );
  if (job.status === "ok" || movedOn) return { state: "done" };
  if (job.status === "error" || job.status === "cancelled") {
    const reached = mine.length > 0;
    return reached
      ? { state: "done" }
      : {
          state: "failed",
          error:
            job.status === "cancelled"
              ? "Stopped before this step."
              : (job.error ?? "An earlier step did not finish."),
        };
  }
  return { state: mine.length > 0 ? "running" : "queued" };
}

function stepSummary(
  job: PipelineJobSnapshot | null,
  row: ReadyRowId,
): string | undefined {
  const step = job?.steps.find(
    (s) => ROW_STEPS[row].includes(s.name) && s.summary,
  );
  return step?.summary ?? undefined;
}

function failedRow(
  id: ReadyRowId,
  error: string,
  detail?: string,
): ReadyRowData {
  const plain = plainError(error);
  return {
    id,
    state: "failed",
    title: ROW_TITLE[id],
    detail: detail ?? plain,
    action: { label: "Try again", run: "try-again" },
    details: error === plain ? undefined : error,
  };
}

/** The job's `error_code` when a run would have replaced hand fixes. */
export const OVERWRITE_REFUSED = "transcript_overwrite_refused";

export function readyRows(input: ReadyInput): ReadyRowData[] {
  if (input.sourceCount === 0) return [];
  if (input.plan) return planRows(input.plan);
  // A finished run says nothing about audio that arrived after it, unless it
  // ran on this audio and a source simply has no speech to show.
  const job =
    input.job?.status === "ok" && !input.transcribed && !input.jobCoversMedia
      ? null
      : input.job;
  const live = isLive(job);
  const jobless = job === null;
  const settled = jobless && input.transcribed && !input.starting;
  const rows: ReadyRowData[] = [];

  const files = plural(input.sourceCount, "file", "files");
  const addOutcome = rowOutcome(job, "add");
  if (input.ingestBusy || addOutcome?.state === "running") {
    rows.push({
      id: "add",
      state: "running",
      title: ROW_TITLE.add,
      detail: "Adding files",
    });
  } else if (addOutcome?.state === "failed") {
    rows.push(failedRow("add", addOutcome.error ?? ""));
  } else {
    rows.push({
      id: "add",
      state: "done",
      title: ROW_TITLE.add,
      detail: files,
    });
  }

  const transcribe = rowOutcome(job, "transcribe");
  const terminalTranscribe = terminalRowResult(job, "transcribe");
  const speakers = plural(input.sourceCount, "speaker", "speakers");
  if (input.model) {
    const { model } = input;
    rows.push(
      model.phase === "downloading"
        ? {
            id: "transcribe",
            state: "running",
            title: ROW_TITLE.transcribe,
            detail: `Downloading ${model.what}`,
            progress: model.progress,
          }
        : {
            id: "transcribe",
            state: "needs-you",
            title: ROW_TITLE.transcribe,
            detail:
              model.phase === "failed"
                ? `${model.failure ?? "The download did not finish."} Try again.`
                : `Needs ${model.what} before it can start.`,
            action: {
              label: `Get (${model.size})`,
              icon: "cloud-download",
              run: "download-model",
            },
          },
    );
  } else if (input.keepFixes) {
    const who = input.keepFixes.names.join(", ");
    rows.push({
      id: "transcribe",
      state: "needs-you",
      title: ROW_TITLE.transcribe,
      detail: who ? `You fixed words on ${who}` : "You fixed words",
      body: {
        kind: "keep-fixes",
        text: "Transcribing again would change words you fixed by hand. Keep them, or replace them with the new transcript.",
      },
    });
  } else if (input.waiting && !live) {
    rows.push({
      id: "transcribe",
      state: "needs-you",
      title: ROW_TITLE.transcribe,
      detail:
        "Another job is running. This starts when it finishes, or press Run to try now.",
      action: { label: "Run", run: "try-again" },
    });
  } else if (input.startError && !live) {
    rows.push(failedRow("transcribe", input.startError));
  } else if (transcribe?.state === "failed") {
    rows.push(
      job?.error_code === OVERWRITE_REFUSED
        ? failedRow(
            "transcribe",
            transcribe.error ?? "",
            "The audio changed on a track with hand fixes.",
          )
        : failedRow("transcribe", transcribe.error ?? ""),
    );
  } else if (transcribe?.state === "running") {
    rows.push({
      id: "transcribe",
      state: "running",
      title: ROW_TITLE.transcribe,
      detail: `Listening to ${plural(input.sourceCount, "track", "tracks")}`,
    });
  } else if (
    transcribe?.state === "done" ||
    settled ||
    ((terminalTranscribe?.kind === "omitted" || transcribe?.skipped) &&
      input.transcribed)
  ) {
    const kept = terminalTranscribe?.kind === "omitted" || transcribe?.skipped;
    rows.push(
      input.approximateTiming
        ? {
            id: "transcribe",
            state: "needs-you",
            title: ROW_TITLE.transcribe,
            detail: kept
              ? "Existing transcripts kept. Word timing is approximate, so cuts may clip word edges."
              : "Transcribed. Word timing is approximate, so cuts may clip word edges.",
            ...(terminalTranscribe?.kind === "omitted"
              ? { runDisposition: "omitted" as const }
              : {}),
            action: input.approximateTiming.downloading
              ? undefined
              : {
                  label: `Download word timing (${input.approximateTiming.size})`,
                  icon: "cloud-download",
                  run: "download-aligner",
                },
          }
        : {
            id: "transcribe",
            state: "done",
            title: ROW_TITLE.transcribe,
            detail: kept
              ? "Existing transcripts kept"
              : (reuseDetail(job, "transcribe") ?? speakers),
            ...(terminalTranscribe?.kind === "omitted"
              ? { runDisposition: "omitted" as const }
              : {}),
          },
    );
  } else if (transcribe?.skipped) {
    rows.push({
      id: "transcribe",
      state: "queued",
      title: ROW_TITLE.transcribe,
      detail: "Skipped this run",
    });
  } else if (terminalTranscribe?.kind === "omitted") {
    rows.push({
      id: "transcribe",
      state: "queued",
      title: ROW_TITLE.transcribe,
      detail: terminalTranscribe.detail,
      runDisposition: "omitted",
    });
  } else {
    rows.push({
      id: "transcribe",
      state: "queued",
      title: ROW_TITLE.transcribe,
      detail:
        input.starting || live
          ? "Starts in a moment"
          : input.job
            ? "Not transcribed yet"
            : "Not started",
      action:
        input.starting || live || input.ingestBusy
          ? undefined
          : { label: "Start", run: "try-again" },
    });
  }

  const fallback: Record<"align" | "clean" | "suggest", string> = {
    align:
      input.sourceCount === 1 ? "One track, nothing to line up" : "Lined up",
    clean: "Noise, volume, balance",
    suggest:
      input.pendingSuggestions > 0
        ? plural(input.pendingSuggestions, "suggestion", "suggestions")
        : "None to decide yet",
  };
  const tail = {
    align:
      reuseDetail(job, "align") ?? stepSummary(job, "align") ?? fallback.align,
    clean:
      reuseDetail(job, "clean") ?? stepSummary(job, "clean") ?? fallback.clean,
    suggest: fallback.suggest,
  };
  for (const id of ["align", "clean", "suggest"] as const) {
    const outcome = rowOutcome(job, id);
    const terminal = terminalRowResult(job, id);
    if (outcome?.state === "failed") {
      rows.push(failedRow(id, outcome.error ?? ""));
    } else if (outcome?.state === "running") {
      rows.push({
        id,
        state: "running",
        title: ROW_TITLE[id],
        detail: ROW_ACTIVITY[id],
      });
    } else if (outcome?.skipped) {
      rows.push({
        id,
        state: "queued",
        title: ROW_TITLE[id],
        detail: "Skipped this run",
      });
    } else if (terminal?.kind === "omitted") {
      rows.push({
        id,
        state: "queued",
        title: ROW_TITLE[id],
        detail: terminal.detail,
        runDisposition: "omitted",
      });
    } else if (terminal?.kind === "performed") {
      rows.push({
        id,
        state: "done",
        title: ROW_TITLE[id],
        detail: terminalWorkDetail(terminal, fallback[id]),
        ...(terminal.partial ? { runDisposition: "partial" as const } : {}),
      });
    } else if (outcome?.state === "done" || settled) {
      rows.push({
        id,
        state: "done",
        title: ROW_TITLE[id],
        detail: tail[id],
      });
    } else {
      rows.push({ id, state: "queued", title: ROW_TITLE[id] });
    }
  }
  return rows;
}

export function readySummary(
  rows: readonly ReadyRowData[],
  newAudio = false,
): string {
  if (rows.length === 0) return "";
  if (newAudio) return "Getting ready: new audio waiting";
  const failed = rows.find((row) => row.state === "failed");
  if (failed) return `Getting ready: ${failed.title} failed`;
  const done = rows.filter((row) => row.state === "done").length;
  const needs = rows.filter((row) => row.state === "needs-you");
  if (
    needs.length === 0 &&
    rows.some((row) => row.runDisposition !== undefined) &&
    rows.every(
      (row) =>
        row.state === "done" ||
        (row.state === "queued" && row.runDisposition === "omitted"),
    )
  ) {
    return "Getting ready: selected work finished";
  }
  if (done === rows.length) return "Getting ready: all done";
  const progress = `Getting ready: ${done} of ${rows.length} done`;
  if (needs.length === 0) return progress;
  return needs.length === 1
    ? `${progress}, ${needs[0].title} needs you`
    : `${progress}, ${needs.length} need you`;
}

type PhaseInput = {
  sources: number;
  ingestBusy: boolean;
  checking: boolean;
  /** The run is stopped on a missing model (asked, downloading or failed). */
  model?: ModelAsk | null;
  waiting?: boolean;
  /** The rows are the plan for audio added after a run. */
  plan?: boolean;
  rows: readonly ReadyRowData[];
};

type PhaseResult = {
  phase: PreparePhase;
  failure?: { step: string; cause: string };
};

export function preparePhase(input: PhaseInput): PhaseResult {
  if (input.sources === 0 && !input.ingestBusy) return { phase: "empty" };
  if (input.ingestBusy) return { phase: "adding" };
  if (input.checking) return { phase: "checking" };
  const failed = input.rows.find((row) => row.state === "failed");
  if (failed) {
    return {
      phase: "failed",
      failure: {
        step: ROW_ACTIVITY[failed.id],
        cause: failed.details ?? failed.detail ?? "It did not finish.",
      },
    };
  }
  // The run was refused, so no work runs while the model asks or downloads.
  if (input.model) {
    return {
      phase: input.model.phase === "failed" ? "model-failed" : "needs-model",
    };
  }
  // Hand fixes would be replaced: the row asks, so the question is spoken.
  if (input.rows.some((row) => row.body?.kind === "keep-fixes")) {
    return { phase: "keep-fixes" };
  }
  // Refused for a busy slot: it starts by itself when the slot frees.
  if (input.waiting) return { phase: "waiting" };
  // New audio waits for the person: nothing runs until Process new audio.
  if (input.plan) return { phase: "new-audio" };
  // Never started (a row offers Start): nothing runs until Start is tapped.
  if (input.rows.some((row) => row.state === "queued" && row.action)) {
    return { phase: "not-started" };
  }
  // A row that waits on the person (word timing to download, hand fixes to
  // keep) is not work in progress: nothing runs, so the hand-off is not held.
  if (
    input.rows.length > 0 &&
    input.rows.every(
      (r) =>
        r.state === "done" ||
        r.state === "needs-you" ||
        (r.state === "queued" && r.runDisposition === "omitted"),
    )
  ) {
    return { phase: "done" };
  }
  return { phase: "transcribing" };
}

export function isWorking(phase: PreparePhase): boolean {
  return phase === "adding" || phase === "checking" || phase === "transcribing";
}

export const PROCESS_NEW_AUDIO = "Process new audio";

type PrepareHandoff = {
  label: string;
  target: "review" | "edit" | "process";
};

/** Where Prepare sends the host next: decisions first, then the Edit. */
export function prepareHandoff(input: {
  pendingReviewCount: number;
  /** New audio waits to be processed: the hand-off runs it. */
  newAudio?: boolean;
}): PrepareHandoff {
  if (input.newAudio) {
    return { label: PROCESS_NEW_AUDIO, target: "process" };
  }
  const count = input.pendingReviewCount;
  return count > 0
    ? {
        label: `Review ${plural(count, "suggestion", "suggestions")}`,
        target: "review",
      }
    : { label: "Edit", target: "edit" };
}

export const STILL_GETTING_READY = "Still getting ready";

/** The hand-off: always offered; quiet, with its reason, while work runs. */
export function handoffProps(
  phase: PreparePhase,
  target: { label: string },
): { label: string; disabledReason?: string } {
  return isWorking(phase)
    ? { label: target.label, disabledReason: STILL_GETTING_READY }
    : { label: target.label };
}

const TIGHT_TO_INTENSITY = {
  light: "light",
  medium: "medium",
  tight: "aggressive",
} as const satisfies Record<CleanupSettings["tight"], string>;

const LUFS: Record<CleanupSettings["loudness"], number> = {
  podcast: -16,
  broadcast: -23,
  streaming: -14,
};

const DEFAULT_CLEANUP: CleanupSettings = {
  tight: "medium",
  loudness: "podcast",
};

export function cleanupFromConfig(
  config: Readonly<Record<string, unknown>> | null | undefined,
): CleanupSettings {
  if (!config) return DEFAULT_CLEANUP;
  const intensity = getByPath(config, TIGHTEN_INTENSITY_PATH);
  const tight =
    intensity === "aggressive"
      ? "tight"
      : intensity === "light"
        ? "light"
        : "medium";
  const lufs = getByPath(config, MASTER_LUFS_PATH);
  let loudness: CleanupSettings["loudness"] = "podcast";
  if (typeof lufs === "number") {
    let best = Number.POSITIVE_INFINITY;
    for (const [id, level] of Object.entries(LUFS)) {
      const gap = Math.abs(level - lufs);
      if (gap < best) {
        best = gap;
        loudness = id as CleanupSettings["loudness"];
      }
    }
  }
  return { tight, loudness };
}

export function applyCleanup(
  config: Record<string, unknown>,
  next: CleanupSettings,
): Record<string, unknown> {
  return setByPath(
    setByPath(config, TIGHTEN_INTENSITY_PATH, TIGHT_TO_INTENSITY[next.tight]),
    MASTER_LUFS_PATH,
    LUFS[next.loudness],
  );
}

export type VocabularyLists = { terms: string[]; guest_names: string[] };

/** The chips the field shows: terms, then guest names that are not already a term. */
export function vocabularyChips(vocabulary: VocabularyLists): string[] {
  return [...new Set([...vocabulary.terms, ...vocabulary.guest_names])];
}

/** The lists to save for the chips: a guest name stays a guest name while its chip stays. */
export function vocabularyFromChips(
  previous: VocabularyLists,
  chips: readonly string[],
): VocabularyLists {
  const guests = new Set(previous.guest_names);
  return {
    guest_names: chips.filter((chip) => guests.has(chip)),
    terms: chips.filter((chip) => !guests.has(chip)),
  };
}

export function trackLabel(track: Pick<TrackView, "label" | "id">): string {
  return track.label || track.id;
}
