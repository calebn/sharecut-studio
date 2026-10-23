import type { CommentRole } from "../shareMode";
import { readLocal, writeLocal } from "./storage";

const STORAGE_KEY = "podcast-mcp-comment-author";
const GUEST_NAME_KEY = "podcast-mcp-guest-comment-name";
const DEFAULT_AUTHOR = "viewer";

export const COMMENT_NAME_MAX = 40;
export const HOST_SESSION_LABEL = "Host";
/** A guest's presence label and comment name until they save one. */
export const GUEST_SESSION_LABEL = "Guest";
const PLACEHOLDER_NAMES = new Set([
  DEFAULT_AUTHOR,
  HOST_SESSION_LABEL,
  GUEST_SESSION_LABEL,
]);
const INVISIBLE_OR_MARKUP = /[\p{Cc}\p{Cf}\p{Cs}<>]/gu;

/** Keep at most `COMMENT_NAME_MAX` code points, as the server does. */
export function limitCommentName(raw: string): string {
  return Array.from(raw.replace(INVISIBLE_OR_MARKUP, ""))
    .slice(0, COMMENT_NAME_MAX)
    .join("");
}

/** The display name the server will store: no markup, controls or zero-width characters, trimmed, capped. */
export function capCommentName(raw: string): string {
  return limitCommentName(raw.replace(/\s+/g, " ").trim()).trim();
}

/**
 * Remember a comment name. A guest's name has its own key that the host never
 * reads or writes (`""` records a Skip); the host's name keeps its own.
 */
export function saveCommentAuthor(
  author: string,
  role: CommentRole = "host",
): void {
  const name = capCommentName(author);
  if (role === "guest") {
    writeLocal(GUEST_NAME_KEY, name);
    return;
  }
  writeLocal(STORAGE_KEY, name || DEFAULT_AUTHOR);
}

/** The name this browser's guest saved, or "" when none (never asked, or skipped). */
export function savedGuestName(): string {
  return capCommentName(readLocal(GUEST_NAME_KEY) ?? "");
}

/** Whether this browser's guest has already named themselves or skipped. */
export function guestNameChosen(): boolean {
  return readLocal(GUEST_NAME_KEY) !== null;
}

/**
 * Name this viewer shows as in the session: the role's saved comment name,
 * else the role's presence label. The host's saved placeholder (`viewer`,
 * `Host`, `Guest`) counts as unset.
 */
export function sessionDisplayName(role: CommentRole): string {
  if (role === "guest") {
    return (
      capCommentName(readLocal(GUEST_NAME_KEY) ?? "") || GUEST_SESSION_LABEL
    );
  }
  const saved = (readLocal(STORAGE_KEY) ?? "").trim();
  if (saved && !PLACEHOLDER_NAMES.has(saved)) {
    return saved;
  }
  return HOST_SESSION_LABEL;
}

/**
 * Identity for posts, replies, resolves and action items: the typed name,
 * else `sessionDisplayName(role)`. Never empty, and a blank field never picks
 * up another role's stored placeholder.
 */
export function resolveCommentActor(
  explicit: string | null | undefined,
  role: CommentRole,
): string {
  return (explicit ?? "").trim() || sessionDisplayName(role);
}

/**
 * Resolve the actor (`resolveCommentActor`), show it in the author field via
 * `show`, and save it so the next post starts from the same name. Shared by
 * the review page and the DAW's `useCommentActions`.
 */
export function commitCommentActor(
  explicit: string | null | undefined,
  role: CommentRole,
  show?: (name: string) => void,
): string {
  const who = resolveCommentActor(explicit, role);
  show?.(who);
  if (role === "host") saveCommentAuthor(who);
  return who;
}
