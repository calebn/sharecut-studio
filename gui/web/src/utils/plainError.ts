const ACRONYMS = new Set([
  "LUFS",
  "FLAC",
  "JSON",
  "HTTP",
  "HTTPS",
  "OPUS",
  "AIFF",
  "MIDI",
  "RF64",
]);

const ENV_NAME =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%/;
const POSIX_PATH = /(?:\/[\w.@~-]+){2,}/;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][^\s]+|\\\\[\w.$-]+\\[^\s]+/;
const SNAKE_CODE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const BARE_ENV = /\b[A-Z]{4,}\b/g;

const NEXT_STEP = "Export diagnostics from the command palette and try again.";

function carriesInternals(text: string): boolean {
  if (
    ENV_NAME.test(text) ||
    POSIX_PATH.test(text) ||
    WINDOWS_PATH.test(text) ||
    SNAKE_CODE.test(text) ||
    UUID.test(text) ||
    /\bTraceback\b/.test(text)
  )
    return true;
  return (text.match(BARE_ENV) ?? []).some((word) => !ACRONYMS.has(word));
}

/**
 * A failure message safe to show: when the text carries an environment
 * variable name, a file path, an id, a machine code or stack text, only the
 * first sentence ("Refresh failed") stays and the next step takes the
 * cause's place.
 */
export function plainError(message: string): string {
  if (!carriesInternals(message)) return message;
  const lead = message.split(/[.:]\s/, 1)[0]?.replace(/[.:]$/, "") ?? "";
  const named = lead !== message && lead !== "" && !carriesInternals(lead);
  return `${named ? lead : "Something went wrong"}. ${NEXT_STEP}`;
}
