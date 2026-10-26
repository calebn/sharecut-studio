import type { ReviewContent } from "../review/ReviewQueue";
import type { ReviewItem } from "../review/reviewQueue";
import type { SuggestionSegment } from "../system/Suggestion";
import { Suggestion } from "../system/Suggestion";
import { formatSeconds } from "../system/seconds";

/** 120 peaks across a 12 s window, quiet inside each `[from, to]` gap in seconds. */
export function windowPeaks(gaps: readonly [number, number][]): number[] {
  return Array.from({ length: 120 }, (_, index) => {
    const at = index * 0.1;
    if (gaps.some(([from, to]) => at >= from && at < to)) return 0.04;
    return (
      0.25 + 0.65 * Math.abs(Math.sin(index * 0.9) * Math.cos(index * 0.31))
    );
  });
}

export const fillerPeaks = windowPeaks([
  [0, 0.4],
  [4.4, 4.9],
  [7.3, 7.9],
  [11.5, 12],
]);

export const pausePeaks = windowPeaks([
  [0, 0.6],
  [4.3, 7.2],
  [11, 12],
]);

export const FILLER_EXCERPT: readonly SuggestionSegment[] = [
  { text: "So the thing about the old mill is " },
  { text: "um, you know,", struck: true },
  { text: " nobody asked the river what it wanted." },
];

export const UNSURE_EXCERPT: readonly SuggestionSegment[] = [
  { text: "I asked " },
  { text: "uncle", unsure: true },
  { text: " Rosa whether the boat was still there." },
];

export const FILLER_WITH_UNSURE: readonly SuggestionSegment[] = [
  { text: "We went to see " },
  { text: "uh, my", struck: true },
  { text: " " },
  { text: "uncle", unsure: true },
  { text: " about the boat." },
];

export const FILLER_WAVEFORM = {
  peaks: fillerPeaks,
  windowStart: 1108.8,
  start: 1114.4,
  end: 1115.2,
};

type Spec = {
  item: ReviewItem;
  time: string;
  title: string;
  segments?: readonly SuggestionSegment[];
  pause?: { length: number; to: number };
  speaker?: string;
  why?: string;
  unsure?: string;
  comment?: { by: string; body: string; replies?: number; unread?: boolean };
  detail?: string;
};

const around = (
  before: string,
  struck: string,
  after: string,
): SuggestionSegment[] => [
  { text: before },
  { text: struck, struck: true },
  { text: after },
];

const SPECS: readonly Spec[] = [
  {
    item: { id: "c1", kind: "check", at: 0, savedSeconds: 0 },
    time: "0:00",
    title: "Check the transcript before cutting",
    why: "Cuts are placed by words, so give the transcript a glance first.",
    detail: "3 unsure words",
  },
  {
    item: { id: "u1", kind: "unsure-word", at: 614, savedSeconds: 0 },
    time: "10:14",
    title: "Is this “uncle”?",
    segments: UNSURE_EXCERPT,
    unsure: "uncle",
    why: "The transcriber was not sure of this word.",
  },
  {
    item: { id: "m1", kind: "comment", at: 702, savedSeconds: 0 },
    time: "11:42",
    title: "Rosa asks about the laugh",
    segments: [{ text: "…and that was the last time anyone saw the boat." }],
    comment: {
      by: "Rosa",
      body: "Can we keep the laugh here?",
      replies: 2,
      unread: true,
    },
  },
  {
    item: { id: "f1", kind: "filler", at: 1116, savedSeconds: 0.8 },
    time: "18:36",
    title: "Remove “um, you know,”",
    segments: FILLER_EXCERPT,
    speaker: "Jon",
    why: "Jon restarts the sentence; nobody talks over it.",
  },
  {
    item: { id: "f2", kind: "filler", at: 1290, savedSeconds: 0.6 },
    time: "21:30",
    title: "Remove “uh,”",
    segments: around(
      "We left before the rain, ",
      "uh,",
      " and the river was high.",
    ),
    speaker: "Jon",
    why: "A hesitation before a clean restart.",
  },
  {
    item: {
      id: "f3",
      kind: "filler",
      at: 1544,
      savedSeconds: 0.9,
      unsure: true,
    },
    time: "25:44",
    title: "Remove “uh, my”",
    segments: FILLER_WITH_UNSURE,
    speaker: "Rosa",
    unsure: "uncle",
    why: "Rosa starts again; the word after it is unsure.",
  },
  {
    item: { id: "f4", kind: "filler", at: 2010, savedSeconds: 0.7 },
    time: "33:30",
    title: "Remove “like,”",
    segments: around("It was, ", "like,", " the biggest boat on the water."),
    speaker: "Rosa",
    why: "A filler between two clear phrases.",
  },
  {
    item: { id: "p1", kind: "pause", at: 1480, savedSeconds: 2.3 },
    time: "24:40",
    title: "Shorten a 2.9 s pause to 0.6 s",
    pause: { length: 2.9, to: 0.6 },
    why: "Nobody speaks, and the room is quiet.",
  },
  {
    item: { id: "p2", kind: "pause", at: 2210, savedSeconds: 1.9 },
    time: "36:50",
    title: "Shorten a 2.5 s pause to 0.6 s",
    pause: { length: 2.5, to: 0.6 },
    why: "A long breath between two thoughts.",
  },
  {
    item: { id: "s1", kind: "sound", at: 2660, savedSeconds: 0 },
    time: "44:20",
    title: "Lower a laugh by 12 dB",
    segments: [{ text: "The laugh peaks over Rosa's next sentence." }],
    why: "The laugh peaks over the next sentence.",
  },
  {
    item: {
      id: "f0",
      kind: "filler",
      at: 90,
      savedSeconds: 0.5,
      result: "applied",
    },
    time: "1:30",
    title: "Remove “um,”",
    segments: around("So ", "um,", " here we are."),
  },
  {
    item: {
      id: "p0",
      kind: "pause",
      at: 240,
      savedSeconds: 1.1,
      result: "kept",
    },
    time: "4:00",
    title: "Shorten a 1.7 s pause to 0.6 s",
    pause: { length: 1.7, to: 0.6 },
  },
];

export const QUEUE_ITEMS: readonly ReviewItem[] = SPECS.map((s) => s.item);

const COLOR: Record<string, number> = { Jon: 1, Rosa: 2 };

/** Row and card content for a fixture item. */
export function reviewContent(item: ReviewItem): ReviewContent {
  const found = SPECS.find((s) => s.item.id === item.id);
  if (!found) throw new Error(`No fixture content for ${item.id}`);
  const {
    time,
    title,
    segments,
    pause,
    speaker,
    why,
    unsure,
    comment,
    detail,
  } = found;
  const drawing = pause ? (
    <Suggestion kind="pause" length={pause.length} to={pause.to} />
  ) : segments ? (
    <Suggestion focus segments={segments} />
  ) : (
    title
  );
  const author = comment
    ? { name: comment.by, colorIndex: COLOR[comment.by] }
    : undefined;
  const start = pause ? item.at : item.at - 0.4;
  const wave = {
    peaks: pause ? pausePeaks : fillerPeaks,
    windowStart: start - 5.6,
    start,
    end:
      start +
      (pause ? pause.length : item.kind === "sound" ? 3 : item.savedSeconds),
  };
  return {
    row: {
      snippet: drawing,
      time,
      value: comment
        ? comment.replies
          ? `${comment.replies} replies`
          : undefined
        : item.savedSeconds > 0
          ? formatSeconds(item.savedSeconds)
          : undefined,
      author,
      unread: comment?.unread,
    },
    check: detail ? { title, detail, actionLabel: "Check" } : undefined,
    card: {
      title,
      time,
      speaker: speaker
        ? { name: speaker, colorIndex: COLOR[speaker] }
        : undefined,
      excerpt: pause ? (
        drawing
      ) : segments ? (
        <Suggestion segments={segments} />
      ) : undefined,
      why,
      waveform: ["filler", "pause", "sound"].includes(item.kind)
        ? wave
        : undefined,
      unsure: unsure ? { word: unsure, guess: unsure } : undefined,
      comment: comment
        ? {
            author: author as NonNullable<typeof author>,
            time,
            body: comment.body,
            replies: comment.replies,
          }
        : undefined,
    },
  };
}
