import type { KitImportEntry, KitImportPreview, KitImportResult } from "../api";

export const KIT_IMPORT_TITLE = "Import a kit";
export const KIT_ADD_LABEL = "Add to library";
export const KIT_EXPIRED = "That file expired. Choose it again.";

export function isUnchangedKit(preview: KitImportPreview): boolean {
  return (
    preview.outcome === "unchanged" &&
    preview.counts.added === 0 &&
    preview.counts.new_version === 0
  );
}

export function outcomeLine(preview: KitImportPreview): string {
  if (isUnchangedKit(preview)) return "Already in your library";
  if (preview.outcome === "unchanged")
    return "Already in your library, with new segments to add";
  if (preview.outcome === "new_version")
    return `Adds as ${preview.name} v${preview.version}`;
  return `Adds ${preview.name}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "3 segments: 2 new, 1 already there". */
export function countsLine(preview: KitImportPreview): string {
  const { added, new_version, unchanged } = preview.counts;
  const total = plural(preview.entry_count, "segment", "segments");
  const parts = [
    added > 0 ? `${added} new` : "",
    new_version > 0
      ? `${new_version} new ${new_version === 1 ? "version" : "versions"}`
      : "",
    unchanged > 0 ? `${unchanged} already there` : "",
  ].filter(Boolean);
  return parts.length > 0 ? `${total}: ${parts.join(", ")}` : total;
}

export function entryStatus(entry: KitImportEntry): string {
  if (entry.outcome === "unchanged") return "Already there";
  if (entry.outcome === "new_version") return `New version v${entry.version}`;
  return "New";
}

export function placement(
  at: KitImportEntry["at"],
  format: (sec: number) => string,
): string {
  if (at === "start") return "At start";
  if (at === "end") return "At end";
  return `At ${format(at)}`;
}

/**
 * `earlier` is how many segments earlier tries of the same file added, and `total` how many
 * the file holds: after a retry the count is for the whole file, not the last try.
 */
export function importedMessage(
  name: string,
  result: KitImportResult,
  retried?: { earlier: number; total: number },
): string {
  const { kit } = result;
  const lead =
    kit.status === "unchanged"
      ? `${name} is already in your library`
      : kit.status === "new_version"
        ? `Added ${name} as version ${kit.version}`
        : `Added ${name} to your library`;
  const fresh = result.segments.filter(
    (segment) => segment.status === "added" || segment.status === "new_version",
  ).length;
  const earlier = retried?.earlier ?? 0;
  const all = fresh + earlier;
  if (earlier > 0 && retried && all < retried.total)
    return `${lead}, with ${all} of ${retried.total} segments new`;
  return all > 0
    ? `${lead}, with ${plural(all, "new segment", "new segments")}`
    : lead;
}

export function partialMessage(added: number, total: number): string {
  return `Added ${added} of ${total} segments. Choose Add to library to finish.`;
}

/** What an expired file leaves behind: segments an earlier try already added. */
export function alreadyThere(added: number, total: number): string {
  const of = total > 0 ? ` of ${total}` : "";
  return `${added}${of} ${total === 1 || (total === 0 && added === 1) ? "segment is" : "segments are"} already in your library.`;
}
