import type {
  ProjectView,
  Selection,
  TranscriptWordView,
} from "../types/project";
import { findTranscriptWordIn } from "../utils/transcript";

export interface IgnoredWordRun {
  trackId: string;
  startWordIndex: number;
  endWordIndex: number;
}

/**
 * Runs of consecutive `word_index` values among `words` that are ignored
 * (#633). Gaps in `word_index` (a suppressed/dropped word) break a run.
 */
export function ignoredRuns(
  trackId: string,
  words: readonly TranscriptWordView[],
): IgnoredWordRun[] {
  const runs: IgnoredWordRun[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const word of words) {
    const index = word.word_index;
    if (index == null) {
      continue;
    }
    if (word.ignored) {
      if (start === null || prev === null || index !== prev + 1) {
        start = index;
      }
      prev = index;
      continue;
    }
    if (start !== null && prev !== null) {
      runs.push({ trackId, startWordIndex: start, endWordIndex: prev });
    }
    start = null;
    prev = null;
  }
  if (start !== null && prev !== null) {
    runs.push({ trackId, startWordIndex: start, endWordIndex: prev });
  }
  return runs;
}

export interface IgnoreTargetArgs {
  trackId?: string;
  startWordIndex?: number;
  endWordIndex?: number;
  ignored?: boolean;
}

export interface IgnoreTarget {
  trackId: string;
  startWordIndex: number;
  endWordIndex: number;
  ignored: boolean;
}

/** Whether every word in `[startWordIndex, endWordIndex]` on `trackId` is ignored. */
export function selectionAllIgnored(
  project: ProjectView | null,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
): boolean {
  const utterances = project?.transcript?.utterances ?? [];
  const lo = Math.min(startWordIndex, endWordIndex);
  const hi = Math.max(startWordIndex, endWordIndex);
  let sawWord = false;
  for (let i = lo; i <= hi; i += 1) {
    const word = findTranscriptWordIn(utterances, trackId, i);
    if (!word) {
      continue;
    }
    sawWord = true;
    if (!word.ignored) {
      return false;
    }
  }
  return sawWord;
}

/**
 * Resolve the range and desired `ignored` state for `transcript.ignoreWords`.
 * Explicit `args` win; otherwise a `transcriptRange` or `transcriptWord`
 * selection is used and toggled (restore only when every word in it is
 * already ignored).
 */
export function ignoreTarget(
  project: ProjectView | null,
  selection: Selection,
  args: IgnoreTargetArgs,
): IgnoreTarget | null {
  const trackId = args.trackId ?? selectionTrackId(selection);
  if (!trackId) {
    return null;
  }
  const [startWordIndex, endWordIndex] = resolveRange(selection, args);
  if (
    startWordIndex == null ||
    endWordIndex == null ||
    endWordIndex < startWordIndex
  ) {
    return null;
  }
  const ignored =
    args.ignored ??
    !selectionAllIgnored(project, trackId, startWordIndex, endWordIndex);
  return { trackId, startWordIndex, endWordIndex, ignored };
}

function selectionTrackId(selection: Selection): string | undefined {
  if (
    selection?.kind === "transcriptRange" ||
    selection?.kind === "transcriptWord"
  ) {
    return selection.trackId;
  }
  return undefined;
}

function resolveRange(
  selection: Selection,
  args: IgnoreTargetArgs,
): [number | undefined, number | undefined] {
  if (args.startWordIndex != null || args.endWordIndex != null) {
    return [
      args.startWordIndex ?? args.endWordIndex,
      args.endWordIndex ?? args.startWordIndex,
    ];
  }
  if (selection?.kind === "transcriptRange") {
    return [
      Math.min(selection.startWordIndex, selection.endWordIndex),
      Math.max(selection.startWordIndex, selection.endWordIndex),
    ];
  }
  if (selection?.kind === "transcriptWord") {
    return [selection.wordIndex, selection.wordIndex];
  }
  return [undefined, undefined];
}
