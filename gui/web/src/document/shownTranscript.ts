import type { DawState } from "../state/types";
import type {
  CombinedUtterance,
  ProjectView,
  TranscriptWordView,
} from "../types/project";
import { wordSeekSec } from "../utils/transcript";
import { utteranceSourceKey } from "./projectPatch";

/**
 * One row of the guest transcript.
 * - live: words and times from the current project.
 * - held: the current header with the words this guest was last shown for the
 *   row, times removed. `lead` is the offset of its first drawn word from the
 *   row start, kept for order and label only.
 * - waiting: the current header alone; the row's words are not known yet.
 */
export type ShownRow =
  | { kind: "live"; utterance: CombinedUtterance }
  | { kind: "held"; utterance: CombinedUtterance; lead: number }
  | { kind: "waiting"; utterance: CombinedUtterance };

export type ShownTranscript = {
  readonly rows: readonly ShownRow[];
  /** Some row is held or waiting for the word detail. */
  readonly refreshing: boolean;
  /** Some row is live or held, so there is something to draw. */
  readonly drawn: boolean;
};

/** The rows of the last project this guest held with every word, and who it was for. */
export type SettledTranscript = {
  readonly grant: string;
  readonly utterances: readonly CombinedUtterance[];
};

/** What this session may read; words kept under one grant are never shown under another. */
export function transcriptGrantOf(
  state: Pick<
    DawState,
    "projectPath" | "shareTranscriptWords" | "shareCapabilities"
  >,
): string {
  const capabilities = [...(state.shareCapabilities ?? [])].sort().join(",");
  return `${state.projectPath}|${state.shareTranscriptWords}|${capabilities}`;
}

export function settledTranscriptOf(
  project: ProjectView,
  grant: string,
): SettledTranscript | null {
  return project.meta?.hydration?.transcript_words === true &&
    project.transcript
    ? { grant, utterances: project.transcript.utterances }
    : null;
}

function sameIndices(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((n, i) => n === right[i]);
}

function drawnBefore(word: TranscriptWordView): boolean {
  return !word.suppressed && !word.ignored && wordSeekSec(word) !== null;
}

/** The settled row's drawn words in drawn order, minus any ignored since, with no times. */
function heldWords(
  settled: CombinedUtterance,
  current: CombinedUtterance,
): { words: TranscriptWordView[]; lead: number } {
  const ignored = new Set(current.ignored_word_indices);
  const drawn = (settled.words ?? [])
    .filter(drawnBefore)
    .sort((a, b) => (wordSeekSec(a) ?? 0) - (wordSeekSec(b) ?? 0));
  const first = drawn[0] ? wordSeekSec(drawn[0]) : null;
  const words = drawn
    .filter(
      (word) => word.word_index === undefined || !ignored.has(word.word_index),
    )
    .map((word) => ({ ...word, timeline_start: null, timeline_end: null }));
  return {
    words,
    lead:
      first !== null && typeof settled.timeline_start === "number"
        ? first - settled.timeline_start
        : 0,
  };
}

function sameRow(
  settled: CombinedUtterance | undefined,
  current: CombinedUtterance,
): settled is CombinedUtterance {
  return (
    settled?.words !== undefined &&
    settled.text === current.text &&
    sameIndices(
      settled.edge_suppressed_word_indices,
      current.edge_suppressed_word_indices,
    ) &&
    Boolean(settled.suppressed_only) === Boolean(current.suppressed_only)
  );
}

function compute(
  transcript: ProjectView["transcript"],
  settled: SettledTranscript | null,
  grant: string,
  complete: boolean,
): ShownTranscript {
  if (complete) {
    const rows = (transcript?.utterances ?? []).map(
      (utterance): ShownRow => ({ kind: "live", utterance }),
    );
    return { rows, refreshing: false, drawn: rows.length > 0 };
  }
  const candidates = new Map<string, CombinedUtterance[]>();
  if (settled && settled.grant === grant) {
    for (const row of settled.utterances) {
      const key = utteranceSourceKey(row);
      candidates.set(key, [...(candidates.get(key) ?? []), row]);
    }
  }
  const rows: ShownRow[] = [];
  for (const utterance of transcript?.utterances ?? []) {
    const prior = candidates.get(utteranceSourceKey(utterance))?.shift();
    if (utterance.words) {
      rows.push({ kind: "live", utterance });
    } else if (
      utterance.mappable === false ||
      typeof utterance.timeline_start !== "number"
    ) {
      continue;
    } else if (sameRow(prior, utterance)) {
      const { words, lead } = heldWords(prior, utterance);
      if (words.length > 0)
        rows.push({
          kind: "held",
          utterance: { ...utterance, words },
          lead,
        });
    } else {
      rows.push({ kind: "waiting", utterance });
    }
  }
  return {
    rows,
    refreshing: rows.some((row) => row.kind !== "live"),
    drawn: rows.some((row) => row.kind !== "waiting"),
  };
}

let memo: {
  transcript: ProjectView["transcript"];
  settled: SettledTranscript | null;
  grant: string;
  complete: boolean;
  shown: ShownTranscript;
} | null = null;

/**
 * The rows to draw for a guest, in the order of the CURRENT project. Words
 * come from the project when it has them, else from the rows last held with
 * words when the row's key and text still match; those words carry no times,
 * so nothing here can seek or highlight on a stale time. A `complete` project
 * has every word it will get: all its rows are live.
 */
export function shownTranscriptOf(
  transcript: ProjectView["transcript"],
  settled: SettledTranscript | null,
  grant: string,
  complete: boolean,
): ShownTranscript {
  if (
    memo &&
    memo.transcript === transcript &&
    memo.settled === settled &&
    memo.grant === grant &&
    memo.complete === complete
  )
    return memo.shown;
  const shown = compute(transcript, settled, grant, complete);
  memo = { transcript, settled, grant, complete, shown };
  return shown;
}
