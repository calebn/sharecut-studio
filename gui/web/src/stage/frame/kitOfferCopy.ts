import type { KitOfferEntry } from "../../api";
import { formatTimeShort } from "../../utils/time";

export const KIT_OFFER_TITLE = "Add your show's intro and outro?";
export const KIT_OFFER_ADDING = "Adding your intro and outro…";
export const KIT_OFFER_ADD = "Add them";
export const KIT_OFFER_NOT_NOW = "Not now";
/** An Undo that takes several steps stays up twice as long as the usual 10 s. */
export const KIT_UNDO_DWELL_MS = 20_000;
const UNKNOWN_SEGMENT = "A segment";

export function entryLine(
  entry: KitOfferEntry,
  names: ReadonlyMap<string, string>,
): string {
  const name = names.get(entry.segment_id) ?? UNKNOWN_SEGMENT;
  const at =
    entry.at === "start" || entry.at === "end"
      ? entry.at
      : formatTimeShort(entry.at);
  return `${name} at ${at}`;
}

export function offerDetail(
  entries: readonly KitOfferEntry[],
  names: ReadonlyMap<string, string>,
): string {
  return entries.map((entry) => entryLine(entry, names)).join(", ");
}

const COUNT_WORDS: Record<number, string> = { 2: "both" };

export function appliedLine(
  entries: readonly KitOfferEntry[],
  names: ReadonlyMap<string, string>,
  steps: number,
): string {
  const added = entries
    .map((entry) => names.get(entry.segment_id) ?? UNKNOWN_SEGMENT)
    .join(" and ");
  const undo =
    steps > 1
      ? ` Undo takes back ${COUNT_WORDS[steps] ?? `all ${steps}`}.`
      : "";
  return `Added ${added}.${undo}`;
}

export const UNDONE_LINE = "Took back your intro and outro.";

export const partialUndoLine = (done: number, total: number) =>
  `Undid ${done} of ${total}; the rest can't be undone because the project changed.`;
