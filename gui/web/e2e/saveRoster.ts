import { SAVE_STATE_COPY } from "../src/record/saveStatus";

/**
 * `"saved"` once every host roster line for `name` reads saved, else the
 * participant's lines as read. A participant with several segments gets one
 * line per segment (`Ava, take 1 segment 2: …`), so match both forms.
 */
export function participantSaveStatus(
  lines: readonly string[],
  name: string,
): string {
  const own = lines.filter(
    (line) => line.startsWith(`${name}: `) || line.startsWith(`${name}, take `),
  );
  const saved = own.every((line) =>
    line.endsWith(`: ${SAVE_STATE_COPY.saved}`),
  );
  return own.length > 0 && saved ? "saved" : JSON.stringify(own);
}
