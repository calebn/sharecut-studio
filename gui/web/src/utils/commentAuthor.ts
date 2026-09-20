const STORAGE_KEY = "podcast-mcp-comment-author";
const DEFAULT_AUTHOR = "viewer";

export function loadCommentAuthor(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_AUTHOR;
  } catch {
    return DEFAULT_AUTHOR;
  }
}

export function saveCommentAuthor(author: string): void {
  const who = author.trim() || DEFAULT_AUTHOR;
  try {
    localStorage.setItem(STORAGE_KEY, who);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Identity for resolve / action-item completion; never empty. */
export function resolveCommentActor(explicit?: string | null): string {
  const who = (explicit ?? "").trim() || loadCommentAuthor().trim();
  return who || DEFAULT_AUTHOR;
}
