import { readLocal, writeLocal } from "./storage";

const STORAGE_KEY = "podcast-mcp-comment-author";
const DEFAULT_AUTHOR = "viewer";

/** Presence label the host publishes (useSessionSync); the host's default comment name. */
export const HOST_SESSION_LABEL = "Host";
/** A guest's presence label and comment name until they save one. */
export const GUEST_SESSION_LABEL = "Guest";
const PLACEHOLDER_NAMES = new Set([
  DEFAULT_AUTHOR,
  HOST_SESSION_LABEL,
  GUEST_SESSION_LABEL,
]);

function savedCommentAuthor(): string {
  return readLocal(STORAGE_KEY) ?? DEFAULT_AUTHOR;
}

export function saveCommentAuthor(author: string): void {
  writeLocal(STORAGE_KEY, author.trim() || DEFAULT_AUTHOR);
}

/**
 * Name this viewer shows as in the session: the saved comment name, else the
 * role's presence label. A placeholder saved by an earlier default (`viewer`,
 * `Host`, `Guest`) counts as unset, so a host's stored `Host` never names a
 * guest in the same browser.
 */
export function sessionDisplayName(role: "host" | "guest"): string {
  const saved = (readLocal(STORAGE_KEY) ?? "").trim();
  if (saved && !PLACEHOLDER_NAMES.has(saved)) {
    return saved;
  }
  return role === "host" ? HOST_SESSION_LABEL : GUEST_SESSION_LABEL;
}

/** Identity for resolve / action-item completion; never empty. */
export function resolveCommentActor(explicit?: string | null): string {
  const who = (explicit ?? "").trim() || savedCommentAuthor().trim();
  return who || DEFAULT_AUTHOR;
}
