export type PillTone = "neutral" | "ok" | "warning" | "audition";

/**
 * Class list for a pill of `tone`. Action pills (a `CommandButton` or
 * `Button` that reads as a pill, e.g. the stale-render chip) use this so the
 * tone mapping lives in one place.
 */
export function pillClassName(
  tone: PillTone = "neutral",
  ...extra: (string | false | null | undefined)[]
): string {
  return ["pill", tone === "neutral" ? "" : tone, ...extra]
    .filter(Boolean)
    .join(" ");
}
