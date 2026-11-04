export const MAX_ACTION_ITEMS = 5;
export const MAX_ACTION_LENGTH = 120;

/** The non-empty lines, trimmed, in order. */
export function filledActions(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  return lines
    .map((l) => l.trim())
    .filter((l) => {
      const key = l.toLowerCase();
      if (!l || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
