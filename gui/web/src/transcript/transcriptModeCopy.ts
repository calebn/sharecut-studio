export type TranscriptIntent = "navigate" | "correct" | "select";

/** Toolbar hint: what the active transcript intent does to text vs audio. */
export const TRANSCRIPT_MODE_HINT: Record<TranscriptIntent, string> = {
  navigate:
    "Double-click a word to fix its text: Enter saves, Esc cancels. Text fixes never move or cut audio.",
  correct:
    "Correct (text only): click a word, then Apply in the word editor. The audio and word timing stay as recorded.",
  select:
    "Select (edits audio): pick words, then Mod+X cuts their audio from the timeline and Mod+V pastes it.",
};

/** Under Apply in the word editor. */
export const TRANSCRIPT_CORRECT_TIMING_NOTE =
  "Apply changes the text only; the audio and word timing stay as recorded. With End index above the start, the new words share the original span evenly.";
