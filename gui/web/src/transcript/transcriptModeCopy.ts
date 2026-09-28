export type TranscriptIntent = "navigate" | "correct" | "select";

/** Toolbar hint: what the active transcript intent does to text vs audio. */
export const TRANSCRIPT_MODE_HINT: Record<TranscriptIntent, string> = {
  navigate:
    "Double-click a word to fix its text: Enter saves, Esc cancels. Text fixes never move or cut audio.",
  correct:
    "Correct: click a word, then Apply fixes its text or Suppress drops it from the transcript (text only; audio and timing stay as recorded). Ignore strikes it through and mutes its audio at render, without a cut.",
  select:
    "Select (edits audio): pick words, then Mod+X cuts their audio from the timeline and Mod+V pastes it. Ignore strikes through and mutes the selection at render, non-destructively; Restore brings it back.",
};

/** Navigate hint on coarse pointers: double-tap opens the Correct sheet, not the inline editor. */
export const TRANSCRIPT_NAVIGATE_TOUCH_HINT =
  "Double-tap a word to correct its text in the word editor. Text fixes never move or cut audio.";

/** Replaces the toolbar mode hint while an inline word fix saves; another word opens once it settles. */
export const TRANSCRIPT_INLINE_SAVING_STATUS =
  "Saving the word fix… you can fix another word once it is saved.";

/** Under Apply in the word editor. */
export const TRANSCRIPT_CORRECT_TIMING_NOTE =
  "Apply changes the text only; the audio and word timing stay as recorded. With End index above the start, the new words share the original span evenly.";

/** Under Apply when a word in the range is not loaded or its loaded copies disagree, so Apply cannot use the #650 stale-text guard. */
export const TRANSCRIPT_SPAN_UNVERIFIED_NOTE =
  "Apply can't confirm the current text of every word in this range, so it can't check whether someone else changed these words first.";

/** Correct inspector error after a 409 (#746), shown when its re-captured span differs from the refused text, so Apply again retries. Otherwise (the refresh failed and nothing newer arrived), and for MCP/CLI, the host's re-read wording stays. */
export const TRANSCRIPT_CORRECT_CONFLICT_NOTE =
  "These words changed since you started this correction, so it was not applied. Apply again to retry against the current text.";

/** Appended to the Select-mode Ignore/Restore status announcement when the range's text
 * couldn't be confirmed, so the command was sent without the #744 stale-text guard. */
export const TRANSCRIPT_IGNORE_UNVERIFIED_SUFFIX = " (text not verified)";

/** Title/tooltip suffix on an ignored word chip (#633). */
export const TRANSCRIPT_IGNORED_WORD_TIP =
  "Ignored: struck through and muted at render. No cut is made; Restore brings it back.";

/** Title on the word inspector's Suppress action (text only). */
export const TRANSCRIPT_SUPPRESS_TIP =
  "Suppress: drop the word from the transcript text only; its audio is unchanged";

/** Title on the word inspector's Unsuppress action (text only). */
export const TRANSCRIPT_UNSUPPRESS_TIP =
  "Unsuppress: put the word back in the transcript text; its audio is unchanged";

/** Title on a transcript edit-boundary glyph with no clip on one side (nothing to roll). */
export const TRANSCRIPT_EDIT_BOUNDARY_TIP = "Edit boundary glyph (Annotate)";

/** Title on a cut-away word chip (Annotate + Show cut-away). */
export const TRANSCRIPT_CUT_AWAY_WORD_TIP =
  "Cut away: not in the mix · drag nearby boundary to restore";
