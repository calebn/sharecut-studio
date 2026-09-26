/** Return `singular` when `count === 1`, else `pluralForm` (default `${singular}s`). Word only — callers render the count. */
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

/** `text` with its first character upper-cased (`"medium"` → `"Medium"`). */
export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
