/** Return `singular` when `count === 1`, else `pluralForm` (default `${singular}s`). Word only — callers render the count. */
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

/** Label for items collapsed out of a capped list (`3` → `"+3 more"`). */
export function overflowLabel(count: number): string {
  return `+${count} more`;
}

/** `text` with its first character upper-cased (`"medium"` → `"Medium"`). */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The non-empty `parts` joined as sentences for titles and live-region copy (`["A", null, "B"]` → `"A. B"`, no trailing period). */
export function joinSentences(
  parts: readonly (string | null | undefined | false)[],
): string {
  return parts.filter((p): p is string => Boolean(p)).join(". ");
}
