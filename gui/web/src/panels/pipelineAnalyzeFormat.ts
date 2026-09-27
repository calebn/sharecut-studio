/** Compact `key=value, ...` line for Analyze evidence / per-track rows (skips null). */
export function formatAnalyzeFields(
  fields: Record<string, unknown>,
  skip: readonly string[] = [],
): string {
  return Object.entries(fields)
    .filter(([k, v]) => !skip.includes(k) && v != null)
    .map(
      ([k, v]) =>
        `${k}=${typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}`,
    )
    .join(", ");
}
