export type TranscriptIntent = "navigate" | "correct" | "select";

/** Toolbar hint: what the active transcript intent does to text vs audio. */
export const TRANSCRIPT_MODE_HINT: Record<TranscriptIntent, string> = {
  navigate:
    "Double-click a word or focus it and press F2 to fix its text: Enter saves, Esc cancels. Text fixes never move or cut audio.",
  correct:
    "Correct: click a word, then Apply fixes its text or Suppress drops it from the transcript (text only; audio and timing stay as recorded). Ignore strikes it through and mutes its audio at render, without a cut.",
  select:
    "Select (edits audio): pick words, then Mod+X cuts their audio from the timeline and Mod+V pastes it. Ignore strikes through and mutes the selection at render, non-destructively; Restore brings it back.",
};

/** Select-mode hint for share guests: an Editor link's range applies, a Commenter link's is a proposal. */
export const TRANSCRIPT_GUEST_SELECT_HINT: Record<"edit" | "suggest", string> =
  {
    edit: "Select (edits audio): pick words, then Cut or Mute in Range actions (or Mod+X) edits the timeline. Undo restores it.",
    suggest:
      "Select: pick words, then Suggest cut or Suggest mute sends them to the host for review. Nothing changes until the host approves.",
  };

export const TRANSCRIPT_CORRECT_TOUCH_HINT =
  "Correct: tap a word, then Apply fixes its text or Suppress drops it from the transcript (text only; audio and timing stay as recorded). Ignore strikes it through and mutes its audio at render, without a cut.";

/** Select hint on touch: the hold-and-drag gesture and the Range actions replace Mod+X and Mod+V. */
export const TRANSCRIPT_SELECT_TOUCH_HINT =
  "Select (edits audio): hold a word and drag across more, or tap a word and add words in Range actions. Cut and Mute are there too. Ignore strikes through and mutes the selection at render, non-destructively; Restore brings it back.";

export const TRANSCRIPT_GUEST_SELECT_TOUCH_HINT: Record<
  "edit" | "suggest",
  string
> = {
  edit: "Select (edits audio): hold a word and drag across more, then Cut or Mute in Range actions edits the timeline. Undo restores it.",
  suggest:
    "Select: hold a word and drag across more, then Suggest cut or Suggest mute sends them to the host for review. Nothing changes until the host approves.",
};

/** Replaces the toolbar mode hint while an inline word fix saves; another word opens once it settles. */
export const TRANSCRIPT_INLINE_SAVING_STATUS =
  "Saving the word fix… you can fix another word once it is saved.";

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

/** Title on a cut-away word chip (Annotate + Show cut-away). */
export const TRANSCRIPT_CUT_AWAY_WORD_TIP =
  "Cut away: not in the mix · drag nearby boundary to restore";

/** Title/tooltip on a word whose suppression is locked: a person or agent decided it
 * directly, so reconcile and auto-suppress passes leave it alone (#768/#781). */
export const TRANSCRIPT_AUDIBILITY_LOCKED_TIP =
  "Suppression locked: set directly, not by a heuristic pass. Reconcile and auto-suppress leave it alone.";

/** Title on the word inspector's Return to automatic action (#824): clears the lock only. */
export const TRANSCRIPT_RETURN_TO_AUTOMATIC_TIP =
  "Return to automatic: clear the lock so the next reconcile pass decides this word again. Suppressed is unchanged until then.";

/** Note shown next to the speaker label on a suppressed-only turn (#758). */
export const TRANSCRIPT_SUPPRESSED_ONLY_NOTE = "all suppressed";

/** Title/tooltip on a suppressed-only turn or chip (#758). */
export const TRANSCRIPT_SUPPRESSED_ONLY_TIP =
  "Every word on this track is suppressed from the transcript text (audio unchanged). Correct → Unsuppress puts a word back.";
