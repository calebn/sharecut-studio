import type { ReviewContent } from "../review/ReviewQueue";
import type { ReviewItem } from "../review/reviewQueueModel";
import { KIND_META } from "../system/decisionKinds";
import type { SuggestionSegment } from "../system/Suggestion";
import { Suggestion } from "../system/Suggestion";
import { formatSeconds } from "../system/seconds";
import {
  FILLER_EXCERPT,
  FILLER_WITH_UNSURE,
  fillerPeaks,
  pausePeaks,
  UNSURE_EXCERPT,
} from "./reviewFixtures";

type Spec = {
  id: string;
  time: string;
  title: string;
  segments?: readonly SuggestionSegment[];
  pause?: { length: number; to: number };
  speaker?: string;
  why?: string;
  unsure?: string;
  comment?: { by: string; body: string; replies?: number; unread?: boolean };
  detail?: string;
  /** A staged record session: the range it replaces, and the line a held replace asks. */
  pickup?: {
    range: readonly [number, number];
    confirm?: string;
    takes?: ReviewContent["takes"];
  };
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

const FALLBACK: Spec = { id: "none", time: "0:00", title: "" };

const SPECS: readonly Spec[] = [
  {
    id: "c1",
    time: "0:00",
    title: "Check the transcript before cutting",
    why: "Cuts are placed by words, so give the transcript a glance first.",
    detail: "3 unsure words",
  },
  {
    id: "u1",
    time: "10:14",
    title: "Is this “uncle”?",
    segments: UNSURE_EXCERPT,
    unsure: "uncle",
    why: "The transcriber was not sure of this word.",
  },
  {
    id: "m1",
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
    id: "f1",
    time: "18:36",
    title: "Remove “um, you know,”",
    segments: FILLER_EXCERPT,
    speaker: "Jon",
    why: "Jon restarts the sentence; nobody talks over it.",
  },
  {
    id: "f2",
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
    id: "f3",
    time: "25:44",
    title: "Remove “uh, my”",
    segments: FILLER_WITH_UNSURE,
    speaker: "Rosa",
    unsure: "uncle",
    why: "Rosa starts again; the word after it is unsure.",
  },
  {
    id: "f4",
    time: "33:30",
    title: "Remove “like,”",
    segments: around("It was, ", "like,", " the biggest boat on the water."),
    speaker: "Rosa",
    why: "A filler between two clear phrases.",
  },
  {
    id: "p1",
    time: "24:40",
    title: "Shorten a 2.9 s pause to 0.6 s",
    pause: { length: 2.9, to: 0.6 },
    why: "Nobody speaks, and the room is quiet.",
  },
  {
    id: "p2",
    time: "36:50",
    title: "Shorten a 2.5 s pause to 0.6 s",
    pause: { length: 2.5, to: 0.6 },
    why: "A long breath between two thoughts.",
  },
  {
    id: "s1",
    time: "44:20",
    title: "Lower a laugh by 12 dB",
    segments: [{ text: "The laugh peaks over Rosa's next sentence." }],
    why: "The laugh peaks over the next sentence.",
  },
  {
    id: "r1",
    time: "13:20",
    title: "Remove a repeated “the”",
    segments: around("We went to ", "the", " the river."),
    speaker: "Jon",
    why: "Jon says the word twice.",
  },
  {
    id: "k1",
    time: "31:40",
    title: "Remove a false start",
    segments: around("I think we ", "should, no,", " we will leave early."),
    speaker: "Rosa",
    why: "Rosa restarts the sentence.",
  },
  {
    id: "g1",
    time: "40:00",
    title: "Remove a guest suggestion",
    segments: [{ text: "A guest marked this stretch to cut." }],
    why: "Suggested by a guest.",
  },
  {
    id: "pk1",
    time: "12:04",
    title: "Insert Session 2 at 12:04",
    why: "2 takes · Jon and Rosa",
    pickup: { range: [724, 724] },
  },
  {
    id: "pk2",
    time: "26:00",
    title: "Replace 26:00–26:25 with Session 3",
    why: "Jon",
    pickup: {
      range: [1560, 1585],
      takes: {
        selected: 1,
        takes: [
          {
            takeIndex: 0,
            length: "8.4 s",
            words: "22 words",
            snippet: "The reason we shipped late was the vendor, not the team…",
          },
          {
            takeIndex: 1,
            length: "9.1 s",
            words: "25 words",
            snippet: "Honestly the reason we shipped late was the vendor…",
          },
          {
            takeIndex: 2,
            length: "1.2 s",
            words: "3 words",
            snippet: "The reason we",
            refusal: "It is shorter than the 25 s it replaces.",
          },
        ],
      },
    },
  },
  {
    id: "pk3",
    time: "35:00",
    title: "Replace 35:00–35:20 with Session 4",
    why: "Take 1 of 1 · Jon",
    pickup: {
      range: [2100, 2120],
      confirm: "This also removes speech from Rosa.",
    },
  },
  { id: "g2", time: "Unplaced", title: "Remove an unplaced suggestion" },
  {
    id: "f0",
    time: "1:30",
    title: "Remove “um,”",
    segments: around("So ", "um,", " here we are."),
  },
  {
    id: "p0",
    time: "4:00",
    title: "Shorten a 1.7 s pause to 0.6 s",
    pause: { length: 1.7, to: 0.6 },
  },
];

const COLOR: Record<string, number> = { Jon: 1, Rosa: 2 };

export function reviewContent(item: ReviewItem): ReviewContent {
  const found = SPECS.find((s) => s.id === item.id) ?? FALLBACK;
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
    pickup,
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
    confirm: pickup?.confirm ? { message: pickup.confirm } : undefined,
    takes: pickup?.takes,
    card: {
      change: pickup && { start: pickup.range[0], end: pickup.range[1] },
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
      waveform:
        KIND_META[item.kind].wave && Number.isFinite(item.at)
          ? wave
          : undefined,
      unsure: unsure ? { word: unsure, guess: unsure } : undefined,
      comment: comment
        ? {
            author: { name: comment.by, colorIndex: COLOR[comment.by] },
            time,
            body: comment.body,
            replies: comment.replies,
          }
        : undefined,
    },
  };
}
