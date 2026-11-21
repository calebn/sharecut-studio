export const SAVED_COPY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function isSavedCopyFresh(
  savedAt: number | undefined,
  now = Date.now(),
): boolean {
  return (
    typeof savedAt === "number" &&
    Number.isFinite(savedAt) &&
    savedAt > 0 &&
    savedAt <= now &&
    now - savedAt < SAVED_COPY_MAX_AGE_MS
  );
}
