/** Appended to the Ignore/Restore status announcement when the range's text
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

/** Title on a cut-away word chip shown under Show cut away. */
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
