import { ApiError } from "../../utils/apiError";

/** The service's coded refusals that need words of their own; the rest carry a sentence the service already wrote. */
const WORDS: Readonly<Record<string, string>> = {
  feed_blocked: "Fix the blockers in Checks first, then write the feed file.",
  feed_write_failed:
    "Could not write the feed file. Close anything that has the export folder open and try again.",
  feed_show_unreadable:
    "The show file cannot be read. Fix or remove it, then try again.",
  feed_show_missing: "Set up your show first.",
  feed_show_busy: "The show is being changed somewhere else. Try again.",
  feed_field_unknown: "That setting is not part of the listing.",
  share_capability_required: "That setting is changed by the host.",
  network_error:
    "Couldn't reach the server. Check your connection and try again.",
};

/** What went wrong with a listing request, in words a person can act on. */
export function feedErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    const own = error.code === null ? undefined : WORDS[error.code];
    if (own) return own;
  }
  if (error instanceof Error && error.message.trim() !== "")
    return error.message;
  return "Something went wrong with the listing. Try again.";
}
