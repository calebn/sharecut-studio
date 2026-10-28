import type { SourceCardProps } from "../../system/SourceCard";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { TrackView } from "../../types/project";
import { getByPath, setByPath } from "../../utils/configPath";
import { plainError } from "../../utils/plainError";
import { formatTimeShort } from "../../utils/time";
import type { CleanupSettings } from "./PrepareView";
import type { PreparePhase } from "./prepareAnnouncement";
import type { PrepareSession, PrepareSource } from "./prepareTypes";
import type { ReadyRowData, ReadyRowId } from "./ReadyList";

/**
 * Pure mappers from the project and the pipeline job onto the props of the
 * presentational Prepare view. The hook that reads the store and runs the
 * actions lives in `usePrepareStage.ts`; nothing here touches a store, a
 * clock or the network, so each mapper is a plain function of its input.
 */

export const TIGHTEN_INTENSITY_PATH = "tighten.intensity";
export const MASTER_LUFS_PATH = "master.integrated_lufs";

/** The row each pipeline step belongs to (spec INT-PREPARE-RUN). */
export const ROW_STEPS: Readonly<Record<ReadyRowId, readonly string[]>> = {
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
};

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
  suggest: "Find suggestions",
};

const ROW_ACTIVITY: Record<ReadyRowId, string> = {
  add: "Adding audio",
  transcribe: "Transcribing",
  align: "Lining up tracks",
  clean: "Cleaning",
  suggest: "Finding suggestions",
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The tracks that are voices to prepare: dialogue, in project order. */
export function sourceTracks(tracks: readonly TrackView[]): TrackView[] {
  return tracks.filter((track) => track.role === "dialogue");
}

export function hasMedia(track: Pick<TrackView, "media_path">): boolean {
  return Boolean(track.media_path);
}

export function mediaName(track: TrackView): string {
  const path = track.media_path;
  if (!path) return track.id;
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || track.id;
}

/** Track ids that have at least one utterance, and how many voices each holds. */
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

export type SessionsInput = {
  tracks: readonly TrackView[];
  transcribed: ReadonlySet<string>;
  /** Distinct speakers in each track's transcript. */
  voicesIn: ReadonlyMap<string, number>;
  /** A host may split; a review guest may not. */
  mayManage: boolean;
  ingestBusy: boolean;
  playingId: string | null;
  /** Voice count the person chose on a split prompt, by track id. */
  chosenVoices: Readonly<Record<string, number>>;
  /** Tracks being split now. */
  splitting: Readonly<Record<string, SplitProgress>>;
  /** Plain cause of a split that failed, by track id. */
  splitFailed: Readonly<Record<string, string>>;
  job: PipelineJobSnapshot | null;
  /** A track the person asked to split ("Split speakers…"); its prompt shows. */
  focusTrackId?: string | null;
};

const MIN_VOICES = 2;

/** Whether a track offers the split prompt: one file that holds several voices, or the only file. */
export function offersSplit(
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
  return { state: track.speaker?.trim() ? "ready" : "needs-name" };
}

export function prepareSource(
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
  /** Every source has a transcript. */
  transcribed: boolean;
  /** A run is being started (auto-run waiting on the slot, or the POST in flight). */
  starting: boolean;
  /** A run was refused because another job holds the pipeline slot. */
  waiting?: boolean;
  job: PipelineJobSnapshot | null;
  pendingSuggestions: number;
  model: ModelAsk | null;
  /** Transcription finished without the word-timing model. */
  approximateTiming: { size: string; downloading: boolean } | null;
  /** A re-transcribe waits on whether to keep hand fixes. */
  keepFixes: { names: readonly string[] } | null;
};

type Outcome = {
  state: "queued" | "running" | "done" | "failed";
  error?: string;
};

function isLive(job: PipelineJobSnapshot | null): boolean {
  return job?.status === "running" || job?.status === "queued";
}

/** What a job says about the steps one row stands for. */
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

/** The five Getting ready rows. */
export function readyRows(input: ReadyInput): ReadyRowData[] {
  if (input.sourceCount === 0) return [];
  const { job } = input;
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
                : `Waiting for ${model.what}. Other steps keep going.`,
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
      detail: "Waiting for the other job to finish. It starts by itself.",
      action: { label: "Run", run: "try-again" },
    });
  } else if (transcribe?.state === "failed") {
    rows.push(failedRow("transcribe", transcribe.error ?? ""));
  } else if (transcribe?.state === "running") {
    rows.push({
      id: "transcribe",
      state: "running",
      title: ROW_TITLE.transcribe,
      detail: `Listening to ${plural(input.sourceCount, "track", "tracks")}`,
    });
  } else if (transcribe?.state === "done" || settled) {
    rows.push(
      input.approximateTiming
        ? {
            id: "transcribe",
            state: "needs-you",
            title: ROW_TITLE.transcribe,
            detail:
              "Transcribed. Word timing is approximate, so cuts may clip word edges.",
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
            detail: speakers,
          },
    );
  } else {
    rows.push({
      id: "transcribe",
      state: "queued",
      title: ROW_TITLE.transcribe,
      detail: input.starting || live ? "Starts in a moment" : "Not started",
      action:
        input.starting || live || input.ingestBusy
          ? undefined
          : { label: "Start", run: "try-again" },
    });
  }

  const tail: Record<"align" | "clean" | "suggest", string> = {
    align:
      input.sourceCount === 1
        ? "One track, nothing to line up"
        : (stepSummary(job, "align") ?? "Lined up"),
    clean: stepSummary(job, "clean") ?? "Noise, volume, balance",
    suggest:
      input.pendingSuggestions > 0
        ? plural(input.pendingSuggestions, "suggestion", "suggestions")
        : "None to decide yet",
  };
  for (const id of ["align", "clean", "suggest"] as const) {
    const outcome = rowOutcome(job, id);
    if (outcome?.state === "failed") {
      rows.push(failedRow(id, outcome.error ?? ""));
    } else if (outcome?.state === "running") {
      rows.push({
        id,
        state: "running",
        title: ROW_TITLE[id],
        detail: ROW_ACTIVITY[id],
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

/** The one line the phone shows first. */
export function readySummary(rows: readonly ReadyRowData[]): string {
  if (rows.length === 0) return "";
  const failed = rows.find((row) => row.state === "failed");
  if (failed) return `Getting ready: ${failed.title} failed`;
  const done = rows.filter((row) => row.state === "done").length;
  if (done === rows.length) return "Getting ready: all done";
  const needs = rows.filter((row) => row.state === "needs-you");
  const progress = `Getting ready: ${done} of ${rows.length} done`;
  if (needs.length === 0) return progress;
  return needs.length === 1
    ? `${progress}, ${needs[0].title} needs you`
    : `${progress}, ${needs.length} need you`;
}

export type PhaseInput = {
  sources: number;
  ingestBusy: boolean;
  /** Sources whose audio is still being measured. */
  checking: boolean;
  /** The run was refused for a busy slot. */
  waiting?: boolean;
  rows: readonly ReadyRowData[];
};

export type PhaseResult = {
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
  const transcribe = input.rows.find((row) => row.id === "transcribe");
  if (
    transcribe?.state === "needs-you" &&
    transcribe.action?.run === "download-model"
  ) {
    return { phase: "needs-model" };
  }
  // Refused for a busy slot: nothing runs until the slot frees or Run is tapped.
  if (input.waiting) return { phase: "waiting" };
  // A row that waits on the person (word timing to download, hand fixes to
  // keep) is not work in progress: nothing runs, so the hand-off is not held.
  if (
    input.rows.length > 0 &&
    input.rows.every((r) => r.state === "done" || r.state === "needs-you")
  ) {
    return { phase: "done" };
  }
  return { phase: "transcribing" };
}

/** Whether the person can still leave for the next stage while work runs. */
export function isWorking(phase: PreparePhase): boolean {
  return phase === "adding" || phase === "checking" || phase === "transcribing";
}

export type PrepareHandoff = { label: string; target: "review" | "edit" };

/** Where Prepare sends the host next: decisions first, then the Edit. */
export function prepareHandoff(input: {
  pendingReviewCount: number;
}): PrepareHandoff {
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

export const DEFAULT_CLEANUP: CleanupSettings = {
  tight: "medium",
  loudness: "podcast",
};

/** The Cleanup segments from the project's pipeline settings. */
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

/** The config with the Cleanup choice written into it. */
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

/** Whether the transcribing model is installed and the run has to wait for it. */
export function needsTranscribeModel(input: {
  untranscribed: number;
  whisperInstalled: boolean | null;
}): boolean {
  return input.untranscribed > 0 && input.whisperInstalled === false;
}

export function trackLabel(track: Pick<TrackView, "label" | "id">): string {
  return track.label || track.id;
}
