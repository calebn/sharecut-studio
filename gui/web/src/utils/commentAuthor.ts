import { readLocal, writeLocal } from "./storage";

const STORAGE_KEY = "podcast-mcp-comment-author";
const DEFAULT_AUTHOR = "viewer";

export function loadCommentAuthor(): string {
  return readLocal(STORAGE_KEY) ?? DEFAULT_AUTHOR;
}

export function saveCommentAuthor(author: string): void {
  writeLocal(STORAGE_KEY, author.trim() || DEFAULT_AUTHOR);
}

/** Identity for resolve / action-item completion; never empty. */
export function resolveCommentActor(explicit?: string | null): string {
  const who = (explicit ?? "").trim() || loadCommentAuthor().trim();
  return who || DEFAULT_AUTHOR;
}
