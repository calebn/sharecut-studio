import { ApiError } from "../../utils/apiError";
import { type FeedAccess, fieldOf } from "./feedLogic";

/** The service's coded refusals that need words of their own; the rest carry a sentence the service already wrote. */
const WORDS: Readonly<Record<string, string>> = {
  feed_blocked: "Fix the blockers in Checks first, then write the feed file.",
  feed_write_failed:
    "Could not write the feed file. Close anything that has the export folder open and try again.",
  feed_show_unreadable:
    "The show file cannot be read. Fix or remove it, then try again.",
  feed_show_missing: "Set up your show first.",
  feed_show_not_found:
    "That show is no longer there. Pick another or create a new one.",
  feed_show_busy: "The show is being changed somewhere else. Try again.",
  feed_field_unknown: "That setting is not part of the listing.",
  feed_show_unknown: "That show is not one this project knows. Pick another.",
  feed_field_edit_at_source:
    "That setting is changed where it comes from, not in the listing.",
  feed_field_not_editable: "That setting cannot be edited here.",
  share_capability_required: "That setting is changed by the host.",
  network_error:
    "Couldn't reach the server. Check your connection and try again.",
};

/** Words for a person on a share link, who cannot reach the host's folders or settings. */
const EDITOR_WORDS: Readonly<Record<string, string>> = {
  feed_write_failed:
    "The feed file could not be written on the host's computer. Ask the host to check that its disk has space and is not read-only, then try again.",
};

const KEY_IN_TEXT = /\b(?:channel|item)\.[A-Za-z][A-Za-z.]*[A-Za-z]/g;

/** A service sentence with each setting named by its label, never by its key. */
function byLabels(text: string): string {
  return text.replace(KEY_IN_TEXT, (key) => fieldOf(key).label);
}

/** What went wrong with a listing request, in words a person can act on. */
export function feedErrorText(error: unknown, access: FeedAccess): string {
  if (error instanceof ApiError) {
    const own =
      error.code === null
        ? undefined
        : ((access === "host" ? undefined : EDITOR_WORDS[error.code]) ??
          WORDS[error.code]);
    if (own) return own;
    if (error.code === "feed_value_invalid") {
      const detail = error.message.trim();
      return detail === ""
        ? "That value isn't valid for this field."
        : byLabels(detail);
    }
  }
  if (error instanceof Error && error.message.trim() !== "")
    return byLabels(error.message);
  return "Something went wrong with the listing. Try again.";
}
