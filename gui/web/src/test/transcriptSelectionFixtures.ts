import type {
  CombinedUtterance,
  EditBoundaryView,
  ProjectView,
  Selection,
  TranscriptWordView,
} from "../types/project";
import { findTranscriptWord } from "../utils/transcript";
import { clipRow, minimalProject, sampleTrack } from "./fixtures";

const STEP = 0.5;

function utterance(
  sourceId: string | null,
  words: TranscriptWordView[],
): CombinedUtterance {
  return {
    track_id: "a",
    source_id: sourceId,
    speaker: "A",
    start: 0,
    end: 5,
    text: "",
    timeline_start: 0,
    timeline_end: 5,
    mappable: true,
    words,
  };
}

export function wordAt(
  i: number,
  index: number,
  timeline: number,
  over: Partial<TranscriptWordView> = {},
): TranscriptWordView {
  return {
    text: `w${i}`,
    word_index: index,
    start: i * STEP,
    end: i * STEP + 0.3,
    timeline_start: timeline,
    timeline_end: timeline + 0.3,
    mappable: true,
    ...over,
  };
}

/**
 * One track, one utterance. `removed` source words are cut (a ripple of
 * `STEP` seconds each), so later words renumber down and their timeline
 * start moves, but their source start does not.
 */
export function snapshot(
  opts: {
    removed?: readonly number[];
    retime?: Record<number, number>;
    extra?: TranscriptWordView[];
    withWords?: boolean;
    retext?: Record<number, string>;
    /** Source words whose utterance names this recording instead of the primary one. */
    otherSource?: { words: readonly number[]; sourceId: string };
    /** Source words an applied cut took out but the utterance still lists, so nothing renumbers. */
    cutAway?: readonly number[];
    /** Moves every word on the timeline without touching any number. */
    shift?: number;
    /** A second utterance repeating this source word, as a word straddling two utterances does. */
    straddle?: number;
    /** The text the straddling copy carries, when it differs from the word it repeats. */
    straddleText?: string;
  } = {},
): ProjectView {
  const cutAway = opts.cutAway ?? [];
  const removed = opts.removed ?? [];
  const gone = [...removed, ...cutAway];
  const words: TranscriptWordView[] = [];
  const sourceOf: (string | null)[] = [];
  for (let i = 0; i < 10; i++) {
    if (removed.includes(i)) continue;
    const shift = gone.filter((r) => r < i).length * STEP - (opts.shift ?? 0);
    const word = wordAt(i, words.length, i * STEP - shift);
    if (opts.retime?.[i] !== undefined) word.start += opts.retime[i]!;
    if (opts.retext?.[i] !== undefined) word.text = opts.retext[i]!;
    if (cutAway.includes(i)) {
      word.mappable = false;
      delete word.timeline_start;
      delete word.timeline_end;
    }
    words.push(word);
    sourceOf.push(
      opts.otherSource?.words.includes(i) ? opts.otherSource.sourceId : null,
    );
  }
  for (const extra of opts.extra ?? []) {
    words.push({ ...extra, word_index: words.length });
    sourceOf.push(null);
  }
  const gaps = gone.map((r) => ({ at: r * STEP, len: STEP }));
  const kept: [number, number][] = [];
  let from = 0;
  for (const g of gaps) {
    if (g.at > from) kept.push([from, g.at]);
    from = g.at + g.len;
  }
  kept.push([from, 10]);
  let cursor = 0;
  const clips = kept.map(([s, e], n) => {
    const row = clipRow({
      id: `c${n}`,
      track_id: "a",
      source_start: s,
      source_end: e,
      timeline_start: cursor,
      timeline_end: cursor + (e - s),
    });
    cursor += e - s;
    return row;
  });
  const utterances: CombinedUtterance[] = [];
  for (let at = 0; at < words.length; at++) {
    const previous = utterances[utterances.length - 1];
    const sourceId = sourceOf[at] ?? null;
    if (previous && previous.source_id === sourceId) {
      previous.words!.push(words[at]!);
      continue;
    }
    utterances.push(utterance(sourceId, [words[at]!]));
  }
  if (opts.straddle !== undefined) {
    const copy = words.find((w) => w.text === `w${opts.straddle}`)!;
    utterances.push(
      utterance(null, [
        {
          ...copy,
          ...(opts.straddleText === undefined
            ? {}
            : { text: opts.straddleText }),
        },
      ]),
    );
  }
  for (const each of utterances)
    each.text = (each.words ?? []).map((w) => w.text).join(" ");
  const boundaries: EditBoundaryView[] = cutAway.map((i) => ({
    id: `cut${i}`,
    track_id: "a",
    left_clip_id: "c0",
    right_clip_id: "c1",
    timeline_join_sec: i * STEP - gone.filter((r) => r < i).length * STEP,
    cutaway_source_start: i * STEP,
    cutaway_source_end: i * STEP + STEP,
    has_cutaway: true,
    cutaway_word_ids: [
      {
        track_id: "a",
        source_id: null,
        word_index: words.findIndex((w) => w.text === `w${i}`),
        text: `w${i}`,
        start: i * STEP,
        end: i * STEP + 0.3,
      },
    ],
  }));
  const base = minimalProject({
    tracks: [sampleTrack({ id: "a" })],
    clips: { tracks: { a: clips }, clip_count: clips.length },
    transcript: {
      utterances:
        opts.withWords === false
          ? utterances.map(({ words: _words, ...rest }) => rest)
          : utterances,
    },
    ...(boundaries.length > 0 ? { edit_boundaries: boundaries } : {}),
  });
  return opts.withWords === false
    ? {
        ...base,
        meta: { ...base.meta, hydration: { transcript_words: false } },
      }
    : base;
}

export const PICK: Selection = {
  kind: "transcriptRange",
  trackId: "a",
  sourceId: null,
  startWordIndex: 6,
  endWordIndex: 8,
};

export function named(project: ProjectView, selection: Selection): string[] {
  if (selection?.kind !== "transcriptRange") return [];
  const out: string[] = [];
  for (let i = selection.startWordIndex; i <= selection.endWordIndex; i++)
    out.push(
      findTranscriptWord(project, "a", i, selection.sourceId)?.text ?? "(none)",
    );
  return out;
}
