const ENV_NAME =
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%/;
const POSIX_PATH =
  /(?<![\w.)\]])(?:\/[\w@~-]+(?:\.[\w@~-]+)*){3,}|(?<![\w.)\]])(?:\/[\w@~-]+)+\.[A-Za-z0-9]{1,5}\b/g;
const WINDOWS_PATH =
  /\b[A-Za-z]:[\\/][^\s]*[^\s.,;:!?]|\\\\[\w.$-]+\\[^\s]*[^\s.,;:!?]/g;
const SNAKE_CODE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

const NEXT_STEP = "Export diagnostics from the command palette and try again.";

const hasPath = (text: string) =>
  new RegExp(POSIX_PATH.source).test(text) ||
  new RegExp(WINDOWS_PATH.source).test(text);

const hasOtherInternals = (text: string) =>
  ENV_NAME.test(text) ||
  SNAKE_CODE.test(text) ||
  UUID.test(text) ||
  /\bTraceback\b/.test(text);

const carriesInternals = (text: string) =>
  hasPath(text) || hasOtherInternals(text);

/** A sentence whose only internal is a file path reads on with the path named "the file". */
const namePath = (text: string) =>
  text.replace(POSIX_PATH, "the file").replace(WINDOWS_PATH, "the file");

/**
 * A failure message safe to show. Sentences that carry an environment
 * variable name, a path, an id, a machine code or stack text are replaced:
 * a path alone becomes "the file", a first sentence keeps the words before
 * its colon, anything else goes. Later clean sentences stay, and when the
 * cause was lost with no next step left, the diagnostics step is added.
 */
export function plainError(message: string): string {
  if (!carriesInternals(message)) return message;
  const sentences = message.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  let lost = false;
  sentences.forEach((sentence, index) => {
    if (!carriesInternals(sentence)) {
      kept.push(sentence);
      return;
    }
    const lead = index === 0 ? sentence.split(/:\s/, 1)[0] : "";
    if (lead && lead !== sentence && !carriesInternals(lead)) {
      kept.push(`${lead.replace(/[.:]$/, "")}.`);
    } else if (!hasOtherInternals(sentence) && !/:\s/.test(sentence)) {
      kept.push(namePath(sentence));
      return;
    }
    lost = true;
  });
  if (kept.length === 0) kept.push("Something went wrong.");
  if (lost && kept.length === 1) kept.push(NEXT_STEP);
  return kept.join(" ");
}
