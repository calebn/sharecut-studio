import type {
  ProjectView,
  Selection,
  TranscriptWordView,
} from "../types/project";
import { findTranscriptWord } from "../utils/transcript";
import { clipRow, minimalProject, sampleTrack } from "./fixtures";

const STEP = 0.5;

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
  } = {},
): ProjectView {
  const removed = opts.removed ?? [];
  const words: TranscriptWordView[] = [];
  for (let i = 0; i < 10; i++) {
    if (removed.includes(i)) continue;
    const shift = removed.filter((r) => r < i).length * STEP;
    const word = wordAt(i, words.length, i * STEP - shift);
    if (opts.retime?.[i] !== undefined) word.start += opts.retime[i]!;
    words.push(word);
  }
  for (const extra of opts.extra ?? [])
    words.push({ ...extra, word_index: words.length });
  const gaps = removed.map((r) => ({ at: r * STEP, len: STEP }));
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
  const base = minimalProject({
    tracks: [sampleTrack({ id: "a" })],
    clips: { tracks: { a: clips }, clip_count: clips.length },
    transcript: {
      utterances: [
        {
          track_id: "a",
          source_id: null,
          speaker: "A",
          start: 0,
          end: 5,
          text: words.map((w) => w.text).join(" "),
          timeline_start: 0,
          timeline_end: 5,
          mappable: true,
          ...(opts.withWords === false ? {} : { words }),
        },
      ],
    },
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
