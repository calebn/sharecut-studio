import { isShareProjectKey, shareTokenFromKey } from "./shareMode";

const frozenReviewTokens = new Set<string>();

export function rememberFrozenReview(token: string, frozen: unknown): void {
  if (frozen === true) frozenReviewTokens.add(token);
  else frozenReviewTokens.delete(token);
}

/**
 * Whether this review link plays a published version (the server's
 * `frozen_review_view`, #3605): a Viewer or Commenter whose version holds its
 * frozen timeline. Such a guest plays the review WAV through the audio
 * element, not the live stem proxies; false until the bootstrap says so.
 */
export function isFrozenReviewKey(projectPath: string | null): boolean {
  if (!projectPath || !isShareProjectKey(projectPath)) return false;
  const token = shareTokenFromKey(projectPath);
  return token !== null && frozenReviewTokens.has(token);
}
