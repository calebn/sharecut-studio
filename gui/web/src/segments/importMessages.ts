import type { SegmentImportPreview, SegmentSaveResult } from "../api";
import type { ExportOutcome } from "../utils/shareOrSave";

export const IMPORT_LABEL = "Import";
export const IMPORT_TITLE = "Import a segment";
export const IMPORT_ACCEPT = ".sharecutseg,application/zip";
export const SEGMENT_EXTENSION = ".sharecutseg";
export const ZIP_TYPE = "application/zip";
export const WAIT_TO_DROP =
  "Wait for the library to finish, then drop the file again.";
export const DROP_LABEL = "Drop a segment file to import it";
export const DROP_HINT = "Have a segment file? Choose Import, or drop it here.";
export const NOT_A_SEGMENT_FILE = "That isn't a segment file (.sharecutseg).";
export const ONE_FILE_ONLY = "Import one segment file at a time.";
export const ADD_LABEL = "Add to library";
export const SHOW_LABEL = "Show in library";
export const CANCEL_LABEL = "Cancel";
export const CLOSE_LABEL = "Close";
export const CHOOSE_AGAIN_LABEL = "Choose another file";
export const ADDING_LABEL = "Adding…";
export const PLAY_FAILED = "Couldn't play this file";
export const IMPORT_FAILED = "Couldn't import that file. Try again.";

export function checkingMessage(fileName: string): string {
  return `Checking ${fileName}…`;
}

export function outcomeLine(preview: SegmentImportPreview): string {
  if (preview.outcome === "unchanged") return "Already in your library";
  if (preview.outcome === "new_version")
    return `Adds as ${preview.name} v${preview.version}`;
  return `Adds ${preview.name}`;
}

export function importedMessage(
  name: string,
  result: SegmentSaveResult,
): string {
  if (result.status === "unchanged")
    return `${name} is already in your library`;
  if (result.status === "new_version")
    return `Added ${name} as version ${result.version}`;
  return `Added ${name} to your library`;
}

export function lengthLine(preview: SegmentImportPreview): string {
  return preview.clip_count > 1 ? `${preview.clip_count} clips` : "";
}

export function exportedMessage(name: string, outcome: ExportOutcome): string {
  if (outcome.kind === "shared") return `Shared ${name}`;
  if (outcome.kind === "cancelled") return `Export of ${name} cancelled`;
  return outcome.afterShare
    ? `Saved ${outcome.filename}. This browser would not open the share sheet, so the file was saved instead.`
    : `Saved ${outcome.filename}`;
}
