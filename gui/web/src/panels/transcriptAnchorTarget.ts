import { presenceAnchor } from "../presence/anchors";
import type { TranscriptTurn } from "../utils/transcript";

/** Resolve an offscreen presence anchor to the turn the virtual list must mount. */
export function transcriptAnchorTurnIndex(
  turns: TranscriptTurn[],
  anchor: string,
): number {
  const parts = anchor.split(":");
  if (parts[0] !== "transcript") return -1;
  if (parts[1] === "turn") {
    const index = Number(parts[2]);
    return Number.isInteger(index) && index >= 0 && index < turns.length
      ? index
      : -1;
  }
  if (parts[1] !== "word") return -1;
  const wordIndex = Number(parts[3]);
  if (!Number.isInteger(wordIndex)) return -1;
  return turns.findIndex((turn) =>
    turn.utterances.some((u) =>
      u.words?.some(
        (word) =>
          word.word_index === wordIndex &&
          presenceAnchor("transcript", "word", u.track_id, wordIndex) ===
            anchor,
      ),
    ),
  );
}
