import { guestScriptOf } from "../../stage/hosts/guestScript";
import type { OverviewTick } from "../../system/OverviewStrip";
import { SCRIPT_TURNS } from "../../system/scriptFixtures";

export const DURATION = 3120;

/** Each word starts 1.3 s after the last, from the first turn's 12:04. */
export const WORD_STARTS: readonly number[] = Array.from(
  { length: 54 },
  (_, index) => 724 + index * 1.3,
);

export const PEAKS = Array.from(
  { length: 64 },
  (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);

export const TICKS: readonly OverviewTick[] = [
  { at: 0.23, kind: "comment" },
  { at: 0.5, kind: "chapter" },
  { at: 0.75, kind: "chapter" },
];

export const PEOPLE = [
  { name: "Maya Okafor", colorIndex: 0 },
  { name: "Anneke de Vries", colorIndex: 1 },
];

export const GUEST_SCRIPT = guestScriptOf(
  SCRIPT_TURNS.map((turn) => {
    const words = turn.words.map(({ text, index }) => {
      const start = WORD_STARTS[index]!;
      return {
        text,
        start,
        end: start + 1,
        timeline_start: start,
        timeline_end: start + 1,
        word_index: index,
      };
    });
    return {
      kind: "live",
      utterance: {
        track_id: turn.speakerId,
        speaker: turn.speaker.name,
        text: words.map((w) => w.text).join(" "),
        start: words[0]!.start,
        end: words[words.length - 1]!.end,
        words,
      },
    };
  }),
);
