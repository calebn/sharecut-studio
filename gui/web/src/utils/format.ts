/** Return `singular` when `count === 1`, else `pluralForm` (default `${singular}s`). Word only — callers render the count. */
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}
