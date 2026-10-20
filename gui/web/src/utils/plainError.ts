const INTERNALS =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|(?:\/[\w.@-]+){2,}|\bTraceback\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

const NEXT_STEP = "Export diagnostics from the command palette and try again.";

/**
 * A failure message safe to show: when the text carries an environment
 * variable name, a file path, an id or stack text, only the lead sentence
 * ("Refresh failed") stays and the next step takes the cause's place.
 */
export function plainError(message: string): string {
  if (!INTERNALS.test(message)) return message;
  const lead = message.split(/:\s/, 1)[0] ?? "";
  const named = lead !== message && !INTERNALS.test(lead);
  return `${named ? lead.replace(/\.$/, "") : "Something went wrong"}. ${NEXT_STEP}`;
}
